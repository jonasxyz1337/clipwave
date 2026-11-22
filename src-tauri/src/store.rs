//! Project state, user sounds, small file/shell helpers and the "free up space" cleanup.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::stt::model_file;
use crate::util::*;

fn state_file() -> PathBuf {
    user_dir().join("state.json")
}

#[tauri::command]
pub fn state_load() -> Option<Value> {
    std::fs::read(state_file()).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

/// Atomic save: write a temp file, then rename over the old state.
#[tauri::command]
pub fn state_save(state: Value) -> Res<bool> {
    std::fs::create_dir_all(user_dir()).map_err(|e| e.to_string())?;
    let tmp = state_file().with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, state_file()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn env(app: AppHandle) -> Value {
    json!({
        "videos": app.path().video_dir().ok(),
        "whisper": tool(&app, "whisper").exists(),
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4),
        "version": app.package_info().version.to_string(),
    })
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub async fn pick_dir(app: AppHandle) -> Res<Option<String>> {
    blocking(move || Ok(app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))).await
}

#[tauri::command]
pub fn shell_open(path: String) -> Res<()> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn shell_show(path: String) -> Res<()> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_url(url: String) -> Res<()> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened.".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Adds a sound: keeps our own copy so exports still work if the original file moves.
#[tauri::command]
pub async fn sound_pick(app: AppHandle) -> Res<Option<Value>> {
    blocking(move || {
        let pick = app.dialog().file().set_title("Add sound").add_filter("Audio", &["mp3", "wav", "ogg", "opus", "m4a", "aac", "flac", "wma", "mp4", "webm"]).blocking_pick_file();
        let Some(src) = pick.and_then(|p| p.into_path().ok()) else { return Ok(None) };
        let j = crate::media::probe_json(&app, &src).unwrap_or(Value::Null);
        if !j["streams"].as_array().is_some_and(|a| a.iter().any(|x| x["codec_type"] == "audio")) {
            return Err("That file has no audio.".into());
        }
        let id = uid();
        let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let dest = sub_dir("sounds").join(format!("{id}{ext}"));
        std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        let dur = j["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
        Ok(Some(json!({ "id": id, "path": dest, "name": stem(&src), "dur": dur })))
    })
    .await
}

// ---------- storage / cleanup ----------
fn dir_size(d: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(d) else { return 0 };
    rd.flatten().map(|e| match e.file_type() {
        Ok(t) if t.is_dir() => dir_size(&e.path()),
        _ => e.metadata().map(|m| m.len()).unwrap_or(0),
    }).sum()
}
fn files_size(list: &[PathBuf]) -> u64 {
    list.iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| m.len()).sum()
}
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}
/// Is `child` strictly inside `parent`? (lexical check after normalising separators/case; rejects `..`)
fn inside(child: &Path, parent: &Path) -> bool {
    let (c, p) = (norm(child), norm(parent));
    let p = p.trim_end_matches('\\').to_string() + "\\";
    c.starts_with(&p) && c.len() > p.len() && !c.contains("\\..\\") && !c.ends_with("\\..")
}
/// Cache folders that can always be rebuilt: rendered outro + the old Electron updater download cache.
fn cache_dirs() -> Vec<PathBuf> {
    let mut v = vec![user_dir().join("outro-cache")];
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        v.push(PathBuf::from(l).join("clipwave-updater"));
    }
    v
}
/// Files in the library folder that no project video references any more.
fn library_orphans(keep: &[String]) -> Vec<PathBuf> {
    let keep: HashSet<String> = keep.iter().filter(|k| !k.is_empty()).map(|k| norm(Path::new(k))).collect();
    std::fs::read_dir(lib_dir()).into_iter().flatten().flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| !keep.contains(&norm(p)))
        .collect()
}
fn unused_models(model: &str) -> Vec<PathBuf> {
    let keep = model_file(model);
    let d = user_dir().join("models");
    std::fs::read_dir(&d).into_iter().flatten().flatten().map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n != keep))
        .collect()
}

#[tauri::command]
pub async fn storage_info(keep: Vec<String>, model: String) -> Res<Value> {
    blocking(move || {
        let (o, m) = (files_size(&library_orphans(&keep)), files_size(&unused_models(&model)));
        let cache: u64 = cache_dirs().iter().map(|d| dir_size(d)).sum();
        Ok(json!({ "orphans": o, "models": m, "cache": cache, "total": o + m + cache, "library": dir_size(&lib_dir()) }))
    })
    .await
}

#[tauri::command]
pub async fn storage_clean(keep: Vec<String>, model: String) -> Res<u64> {
    blocking(move || {
        let mut freed = 0;
        for f in library_orphans(&keep).into_iter().chain(unused_models(&model)) {
            let n = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
            if std::fs::remove_file(&f).is_ok() {
                freed += n;
            }
        }
        for d in cache_dirs() {
            let n = dir_size(&d);
            if std::fs::remove_dir_all(&d).is_ok() {
                freed += n;
            }
        }
        Ok(freed)
    })
    .await
}

/// Deletes files of a removed video – but ONLY inside the app's own library folder, never the user's originals.
#[tauri::command]
pub fn video_purge(files: Vec<Option<String>>) -> u32 {
    let lib = lib_dir();
    files.into_iter().flatten().filter(|f| inside(Path::new(f), &lib)).filter(|f| std::fs::remove_file(f).is_ok()).count() as u32
}

