//! Auto-update from GitHub Releases (signed latest.json): checks on start and every 4 h, downloads in the
//! background, installs on request (or the next time the user clicks the pink button).
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::util::*;

static STATE: Mutex<Option<Value>> = Mutex::new(None);
static READY: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
static BUSY: Mutex<bool> = Mutex::new(false);

fn set(app: &AppHandle, v: Value) {
    *STATE.lock().unwrap() = Some(v.clone());
    emit(app, "update", v);
}
fn state() -> Value {
    STATE.lock().unwrap().clone().unwrap_or_else(|| json!({ "state": "idle" }))
}
fn enabled() -> bool {
    !cfg!(debug_assertions) && std::env::var("CW_NO_UPDATE").is_err()
}

async fn check(app: AppHandle) {
    {
        let mut b = BUSY.lock().unwrap();
        if *b || READY.lock().unwrap().is_some() {
            return;
        }
        *b = true;
    }
    let r: Result<(), String> = async {
        set(&app, json!({ "state": "checking" }));
        let upd = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
        let Some(upd) = upd else {
            set(&app, json!({ "state": "uptodate" }));
            return Ok(());
        };
        let ver = upd.version.clone();
        set(&app, json!({ "state": "downloading", "version": ver, "pct": 0 }));
        let (a, v) = (app.clone(), ver.clone());
        let mut got = 0usize;
        let mut last = 0.0f64;
        let bytes = upd
            .download(
                move |n, total| {
                    got += n;
                    let pct = total.map(|t| got as f64 / t as f64 * 100.0).unwrap_or(0.0);
                    if pct - last >= 1.0 {
                        last = pct;
                        set(&a, json!({ "state": "downloading", "version": v, "pct": pct }));
                    }
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        *READY.lock().unwrap() = Some((upd, bytes));
        set(&app, json!({ "state": "ready", "version": ver }));
        Ok(())
    }
    .await;
    if let Err(e) = r {
        set(&app, json!({ "state": "error", "message": e.chars().take(160).collect::<String>() }));
    }
    *BUSY.lock().unwrap() = false;
}

pub fn start(app: &AppHandle) {
    if !enabled() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(4)).await;
        loop {
            check(app.clone()).await;
            tokio_sleep(Duration::from_secs(4 * 3600)).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

#[tauri::command]
pub fn update_check(app: AppHandle) -> Value {
    if !enabled() {
        return json!({ "state": "dev" });
    }
    tauri::async_runtime::spawn(check(app));
    state()
}

/// Runs the downloaded installer (it closes Clipwave, updates and restarts it).
#[tauri::command]
pub fn update_install() -> Res<bool> {
    let Some((upd, bytes)) = READY.lock().unwrap().take() else { return Ok(false) };
    upd.install(bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn update_state() -> Value {
    let mut v = state();
    v["portable"] = json!(false);
    v["packaged"] = json!(enabled());
    v
}
