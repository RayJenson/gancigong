use std::fs;
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 20 * 1024 * 1024;

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("theme")
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        _ => "",
    }
}

pub fn read_data_url(data_dir: &Path, name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    let path = dir(data_dir).join(name);
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = mime_for(&ext);
    if mime.is_empty() {
        return None;
    }
    Some(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

pub fn store_image(data_dir: &Path, source: &Path) -> Result<(String, String), String> {
    let meta = fs::metadata(source).map_err(|e| format!("读取图片失败：{e}"))?;
    if !meta.is_file() {
        return Err("请选择一张图片文件".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("图片超过 20 MB，换一张小一点的吧".into());
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = mime_for(&ext);
    if mime.is_empty() {
        return Err("只支持 PNG / JPG / WebP / BMP / GIF 图片".into());
    }
    let dir = dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建主题目录：{e}"))?;
    clear(data_dir);
    let name = format!("background.{ext}");
    let target = dir.join(&name);
    fs::copy(source, &target).map_err(|e| format!("保存背景失败：{e}"))?;
    let bytes = fs::read(&target).map_err(|e| format!("读取背景失败：{e}"))?;
    Ok((name, format!("data:{mime};base64,{}", base64_encode(&bytes))))
}

pub fn clear(data_dir: &Path) {
    let Ok(entries) = fs::read_dir(dir(data_dir)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("background") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}
