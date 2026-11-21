use crate::dictionary::Dictionary;
use crate::kiosk::KioskRuntime;
use crate::models::Settings;
use crate::rounds::ActiveRound;
use crate::scheduler::SchedState;
use crate::review_windows::SessionInfo;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Manager};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub resource_dirs: Vec<PathBuf>,
    pub settings: Mutex<Settings>,
    pub rounds: Mutex<HashMap<i64, ActiveRound>>,
    pub sched: Mutex<SchedState>,
    pub session: Mutex<Option<SessionInfo>>,
    pub kiosk: Mutex<KioskRuntime>,
    pub escape_ready: AtomicBool,
    /// 正在应用内背单词：调度器暂停提醒，离开学习页后恢复
    pub learning: AtomicBool,
    pub dict: OnceLock<Dictionary>,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let data_dir = crate::db::data_dir();
        let conn = crate::db::init(&data_dir)?;
        let settings = crate::settings::load(&conn);
        let resource_dirs = resource_dirs(app);
        Ok(Self {
            db: Mutex::new(conn),
            data_dir,
            resource_dirs,
            settings: Mutex::new(settings),
            rounds: Mutex::new(HashMap::new()),
            sched: Mutex::new(SchedState::default()),
            session: Mutex::new(None),
            kiosk: Mutex::new(KioskRuntime::default()),
            escape_ready: AtomicBool::new(false),
            learning: AtomicBool::new(false),
            dict: OnceLock::new(),
        })
    }

    pub fn dict(&self) -> &Dictionary {
        self.dict.get().expect("词典尚未加载")
    }

    pub fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    pub fn is_learning(&self) -> bool {
        self.learning.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn resource_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir);
    }
    if let Some(root) = option_env!("CARGO_MANIFEST_DIR") {
        let root = PathBuf::from(root);
        if let Some(parent) = root.parent() {
            dirs.push(parent.to_path_buf());
        }
        dirs.push(root);
    }
    dirs
}
