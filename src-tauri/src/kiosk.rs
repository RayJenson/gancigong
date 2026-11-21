use crate::db::log_event;
use crate::state::{lock, AppState};
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct KioskRuntime {
    pub child: Option<Arc<Mutex<Child>>>,
    pub pid: Option<u32>,
    pub released: Option<Arc<AtomicBool>>,
    pub hb_stop: Option<Arc<AtomicBool>>,
}

pub fn is_engaged(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let k = lock(&state.kiosk);
    k.child.is_some()
}

pub fn pid(app: &AppHandle) -> Option<u32> {
    let state = app.state::<AppState>();
    let k = lock(&state.kiosk);
    k.pid
}

fn powershell_exe() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let candidate = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if std::path::Path::new(&candidate).exists() {
        candidate
    } else {
        "powershell.exe".into()
    }
}

fn heartbeat_file() -> std::path::PathBuf {
    std::env::temp_dir().join("gancigong-kiosk-heartbeat.txt")
}

fn beat(path: &std::path::Path) {
    let _ = std::fs::write(path, chrono::Local::now().to_rfc3339());
}

/// 装钩子。Ok(()) 只代表钩子真的就绪，失败时调用方应退回应用级锁定
pub fn engage<F>(app: &AppHandle, on_exit: F) -> Result<(), String>
where
    F: FnOnce(Option<i32>, String, bool) + Send + 'static,
{
    let state = app.state::<AppState>();
    {
        let k = lock(&state.kiosk);
        if k.child.is_some() {
            return Ok(());
        }
    }
    let script = crate::dictionary::find_file(&state.resource_dirs, "resources/kiosk-lock.ps1")
        .ok_or_else(|| "Kiosk 锁定脚本缺失".to_string())?;
    let hb = heartbeat_file();
    beat(&hb);

    let hb_stop = Arc::new(AtomicBool::new(false));
    {
        let stop = hb_stop.clone();
        let file = hb.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                beat(&file);
                std::thread::sleep(Duration::from_millis(1000));
            }
        });
    }

    let mut cmd = Command::new(powershell_exe());
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-File")
        .arg(&script)
        .arg("-HeartbeatFile")
        .arg(&hb)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动锁定钩子失败：{e}"))?;
    let stdout = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stderr_text = Arc::new(Mutex::new(String::new()));

    let (tx, rx) = mpsc::channel::<String>();
    if let Some(out) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = stderr_pipe.take() {
        let sink = stderr_text.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                let mut s = lock(&sink);
                if s.len() < 2000 {
                    s.push_str(&line);
                    s.push('\n');
                }
            }
        });
    }

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut ready = false;
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            break;
        }
        match rx.recv_timeout(remain) {
            Ok(line) => {
                if line.contains("READY") {
                    ready = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }

    if !ready {
        hb_stop.store(true, Ordering::SeqCst);
        let _ = child.kill();
        let detail = lock(&stderr_text).trim().chars().take(300).collect::<String>();
        return Err(if detail.is_empty() {
            "键盘钩子 10 秒内没有就绪".into()
        } else {
            detail
        });
    }

    let child = Arc::new(Mutex::new(child));
    let released = Arc::new(AtomicBool::new(false));
    {
        let mut k = lock(&state.kiosk);
        k.child = Some(child.clone());
        k.pid = lock(&child).id().into();
        k.released = Some(released.clone());
        k.hb_stop = Some(hb_stop.clone());
    }
    log_event(
        &lock(&state.db),
        "kiosk_locked",
        Some(json!({ "pid": lock(&child).id() })),
    );

    let app2 = app.clone();
    let child2 = child;
    let released2 = released;
    let stop2 = hb_stop;
    let my_pid = lock(&child2).id();
    std::thread::spawn(move || {
        let code = loop {
            let status = {
                let mut c = lock(&child2);
                c.try_wait()
            };
            match status {
                Ok(Some(status)) => break status.code(),
                Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                Err(_) => break None,
            }
        };
        stop2.store(true, Ordering::SeqCst);
        let was_ours = released2.load(Ordering::SeqCst);
        let state = app2.state::<AppState>();
        {
            let mut k = lock(&state.kiosk);
            // 下一轮可能已经装了新钩子，别把新状态清掉
            if k.pid == Some(my_pid) {
                k.child = None;
                k.pid = None;
                k.released = None;
                k.hb_stop = None;
            }
        }
        let reason = if was_ours {
            "released".to_string()
        } else {
            match code {
                Some(7) => "escape".to_string(),
                Some(8) => "heartbeat".to_string(),
                Some(9) => "cap".to_string(),
                _ => "error".to_string(),
            }
        };
        log_event(
            &lock(&state.db),
            "kiosk_released",
            Some(json!({ "code": code, "reason": reason })),
        );
        on_exit(code, reason, was_ours);
    });

    Ok(())
}

pub fn release(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut k = lock(&state.kiosk);
    if let Some(flag) = &k.released {
        flag.store(true, Ordering::SeqCst);
    }
    if let Some(stop) = &k.hb_stop {
        stop.store(true, Ordering::SeqCst);
    }
    if let Some(child) = k.child.clone() {
        let mut c = lock(&child);
        let _ = c.kill();
    }
    let had = k.child.is_some();
    k.child = None;
    k.pid = None;
    k.released = None;
    k.hb_stop = None;
    if had {
        log_event(&lock(&state.db), "kiosk_unlocked", Some(json!({})));
    }
}
