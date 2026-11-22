//! Rendering: runs the ffmpeg job the UI composed (graph + captions come from the shared JS that also drives
//! the live preview, so preview and export never drift apart), and encodes the canvas-drawn outro.
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::util::*;

static CANCEL: AtomicBool = AtomicBool::new(false);
static PROGRESS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^out_time_(?:us|ms)=(\d+)").unwrap());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    job_id: String,
    /// small text files the graph reads, by plain file name (captions .ass, outro concat list, …)
    files: std::collections::HashMap<String, String>,
    /// font file names to copy for libass (Windows names / macOS names)
    fonts: Vec<String>,
    #[serde(default)]
    fonts_mac: Vec<String>,
    /// ffmpeg argument lists to try in order (e.g. NVENC first, then x264)
    variants: Vec<Vec<String>>,
    out: String,
    /// total seconds (clip + outro) for the progress bar
    total: f64,
}

fn export_one_blocking(app: &AppHandle, sp: Spec) -> Res<u64> {
    let tmp = tempfile::Builder::new().prefix("clipwave-e-").tempdir().map_err(|e| e.to_string())?;
    let fdir = tmp.path().join("fonts");
    std::fs::create_dir_all(&fdir).map_err(|e| e.to_string())?;
    // libass reads the fonts from this folder: copy the ones the captions use from the system font folders
    let (dirs, files) = if cfg!(windows) {
        (vec![PathBuf::from(std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into())).join("Fonts")], &sp.fonts)
    } else {
        let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
        (vec![PathBuf::from("/System/Library/Fonts/Supplemental"), PathBuf::from("/System/Library/Fonts"), PathBuf::from("/Library/Fonts"), home.join("Library/Fonts")], &sp.fonts_mac)
    };
    for f in files {
        if let Some(src) = dirs.iter().map(|d| d.join(f)).find(|p| p.exists()) {
            let _ = std::fs::copy(src, fdir.join(f));
        }
    }
    for (name, content) in &sp.files {
        // only plain file names, written inside our own temp folder
        if name.is_empty() || name.contains(['/', '\\', ':']) || name.starts_with('.') {
            return Err(format!("invalid file name in export job: {name}"));
        }
        let bom = if name.ends_with(".ass") { "\u{feff}" } else { "" };
        std::fs::write(tmp.path().join(name), format!("{bom}{content}")).map_err(|e| e.to_string())?;
    }
    let out = PathBuf::from(&sp.out);
    if let Some(d) = out.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("Cannot create the output folder: {e}"))?;
    }
    let ffmpeg = tool(app, "ffmpeg");
    let mut last_err = String::new();
    for args in &sp.variants {
        let r = run(&ffmpeg, args, Some(tmp.path()), |l| {
            if let Some(m) = PROGRESS.captures(l) {
                let t = m[1].parse::<f64>().unwrap_or(0.0) / 1e6;
                emit(app, "export", json!({ "jobId": sp.job_id, "pct": (t / sp.total.max(0.1) * 100.0).min(99.0) }));
            }
        }, |_| {})?;
        if CANCEL.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        if r.code == 0 && out.exists() {
            return std::fs::metadata(&out).map(|m| m.len()).map_err(|e| e.to_string());
        }
        last_err = r.err;
    }
    Err(format!("ffmpeg failed: {}", tail(&last_err, 4, 400)))
}

#[tauri::command]
pub async fn export_one(app: AppHandle, spec: Spec) -> Res<u64> {
    let out = spec.out.clone();
    let r = blocking(move || export_one_blocking(&app, spec)).await;
    if r.is_err() {
        let _ = std::fs::remove_file(out); // never leave a half-written video behind
    }
    r
}

#[tauri::command]
pub fn export_reset() {
    CANCEL.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn cancel_export() -> bool {
    CANCEL.store(true, Ordering::SeqCst);
    kill_all();
    true
}

// ---------- canvas-drawn video (outro, motion graphics): the UI draws frames, we pipe them into ffmpeg ----------
const OUTRO_VERSION: &str = "v3";

#[tauri::command]
pub fn outro_paths(app: AppHandle, title: String, sub: String) -> Value {
    let dir = sub_dir("outro-cache");
    let key = format!("{:x}", md5::compute(format!("{OUTRO_VERSION}|{title}|{sub}")));
    let (intro, lp) = (dir.join(format!("{}_intro.mp4", &key[..12])), dir.join(format!("{}_loop.mp4", &key[..12])));
    let voice = bin_dir(&app).join("outro-sound.ogg");
    json!({ "intro": intro, "loop": lp, "cached": intro.exists() && lp.exists(), "voice": voice.exists().then_some(voice) })
}

/// Cache file for one rendered motion graphic (key = hash of its look + length, computed by the UI).
#[tauri::command]
pub fn gfx_path(key: String) -> Value {
    let k = format!("{:x}", md5::compute(key));
    let p = sub_dir("outro-cache").join(format!("gfx_{}.mov", &k[..16]));
    json!({ "path": p, "cached": p.exists() })
}

struct Enc {
    child: Child,
    stdin: Option<ChildStdin>,
    path: PathBuf,
    part: PathBuf,
    err: Arc<Mutex<String>>,
}
static ENC: Mutex<Option<Enc>> = Mutex::new(None);

/// `kind`: "rgba" = raw 1080x1920 RGBA frames -> H.264 (opaque outro);
///         "png"  = PNG frames with transparency -> PNG-in-MOV (overlays with alpha).
#[tauri::command]
pub fn enc_begin(app: AppHandle, path: String, kind: String) -> Res<()> {
    let p = PathBuf::from(&path);
    let ext = p.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "mp4".into());
    let part = p.with_extension(format!("part.{ext}"));
    let part_s = part.to_string_lossy().into_owned();
    let args: Vec<&str> = match kind.as_str() {
        "rgba" => vec!["-y", "-hide_banner", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1080x1920", "-r", "30", "-i", "-", "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "13", "-g", "30", "-pix_fmt", "yuv420p", &part_s],
        "png" => vec!["-y", "-hide_banner", "-f", "image2pipe", "-framerate", "30", "-c:v", "png", "-i", "-", "-c:v", "png", "-pix_fmt", "rgba", &part_s],
        k => return Err(format!("unknown encoder kind {k}")),
    };
    let mut cmd = Command::new(tool(&app, "ffmpeg"));
    cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    hidden(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Cannot start ffmpeg: {e}"))?;
    let err = Arc::new(Mutex::new(String::new()));
    let (mut se, e2) = (child.stderr.take().unwrap(), err.clone());
    std::thread::spawn(move || {
        let mut b = [0u8; 4096];
        while let Ok(n) = se.read(&mut b) {
            if n == 0 {
                break;
            }
            let mut e = e2.lock().unwrap();
            e.push_str(&String::from_utf8_lossy(&b[..n]));
            if e.len() > 4000 {
                let cut = e.len() - 2000;
                let cut = (cut..e.len()).find(|i| e.is_char_boundary(*i)).unwrap_or(e.len());
                e.drain(..cut);
            }
        }
    });
    let stdin = child.stdin.take();
    *ENC.lock().unwrap() = Some(Enc { child, stdin, path: p, part, err });
    Ok(())
}

/// One frame (raw RGBA or a PNG file), sent as binary IPC body.
#[tauri::command]
pub fn enc_frame(request: tauri::ipc::Request<'_>) -> Res<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw frame bytes".into()) };
    let mut g = ENC.lock().unwrap();
    let enc = g.as_mut().ok_or("frame encoder not running")?;
    enc.stdin.as_mut().ok_or("frame encoder closed")?.write_all(bytes).map_err(|e| format!("frame encode failed: {e}"))
}

#[tauri::command]
pub fn enc_end() -> Res<()> {
    let mut enc = ENC.lock().unwrap().take().ok_or("frame encoder not running")?;
    drop(enc.stdin.take());
    let ok = enc.child.wait().map(|s| s.success()).unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(&enc.part);
        let e = enc.err.lock().unwrap();
        return Err(format!("Rendering graphics failed: {}", tail(&e, 3, 300)));
    }
    std::fs::rename(&enc.part, &enc.path).map_err(|e| e.to_string())
}
