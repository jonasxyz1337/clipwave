//! Importing videos: links (YouTube, Twitch clips/VODs, …) via yt-dlp, local files, probing and thumbnails.
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::util::*;

static RANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+(:\d+){0,2}(\.\d+)?-\d+(:\d+){0,2}(\.\d+)?$").unwrap());
static PCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[download\]\s+([\d.]+)%").unwrap());

pub struct Probe {
    pub w: u64,
    pub h: u64,
    pub duration: f64,
    pub fps: f64,
    pub has_audio: bool,
}

pub fn probe_json(app: &AppHandle, file: &Path) -> Res<Value> {
    let r = run_quiet(&tool(app, "ffprobe"), &[s("-v"), s("error"), s("-print_format"), s("json"), s("-show_streams"), s("-show_format"), file.to_string_lossy().into_owned()], None)?;
    if r.code != 0 {
        return Err("Cannot read this file (ffprobe failed).".into());
    }
    serde_json::from_str(&r.out).map_err(|_| "Cannot read this file (ffprobe failed).".to_string())
}

fn num(v: &Value) -> f64 {
    v.as_f64().or_else(|| v.as_str().and_then(|x| x.parse().ok())).unwrap_or(0.0)
}

pub fn probe(app: &AppHandle, file: &Path) -> Res<Probe> {
    let j = probe_json(app, file)?;
    let streams = j["streams"].as_array().cloned().unwrap_or_default();
    let v = streams.iter().find(|s| s["codec_type"] == "video").ok_or("File has no video stream.")?;
    let rate = v["avg_frame_rate"].as_str().unwrap_or("30/1");
    let (n, d) = rate.split_once('/').map(|(a, b)| (a.parse::<f64>().unwrap_or(30.0), b.parse::<f64>().unwrap_or(1.0))).unwrap_or((30.0, 1.0));
    let mut duration = num(&j["format"]["duration"]);
    if duration == 0.0 {
        duration = num(&v["duration"]);
    }
    Ok(Probe {
        w: v["width"].as_u64().unwrap_or(0),
        h: v["height"].as_u64().unwrap_or(0),
        duration,
        fps: if d != 0.0 { n / d } else { 30.0 },
        has_audio: streams.iter().any(|s| s["codec_type"] == "audio"),
    })
}

fn make_thumb(app: &AppHandle, file: &Path, id: &str, at: f64) -> Option<PathBuf> {
    let out = lib_dir().join(format!("{id}.jpg"));
    let args = [s("-y"), s("-ss"), s(at.max(0.0)), s("-i"), file.to_string_lossy().into_owned(), s("-frames:v"), s("1"), s("-vf"), s("scale=640:-2"), s("-q:v"), s("4"), out.to_string_lossy().into_owned()];
    let _ = run_quiet(&tool(app, "ffmpeg"), &args, None);
    out.exists().then_some(out)
}

pub fn finish_video(app: &AppHandle, id: &str, file: &Path, title: Option<String>, url: &str) -> Res<Value> {
    let m = probe(app, file)?;
    let thumb = make_thumb(app, file, id, (m.duration / 4.0).min(2.0));
    Ok(json!({
        "id": id, "title": title.filter(|t| !t.is_empty()).unwrap_or_else(|| stem(file)),
        "path": file, "url": url, "thumb": thumb,
        "w": m.w, "h": m.h, "duration": m.duration, "fps": m.fps, "hasAudio": m.has_audio, "addedAt": now_ms(),
    }))
}

fn friendly_ytdlp(err: &str) -> String {
    let line = err.lines().filter(|l| l.contains("ERROR")).last().unwrap_or(if err.is_empty() { "Unknown download error" } else { err });
    let has = |re: &str| Regex::new(&format!("(?i){re}")).unwrap().is_match(line);
    if has("subscriber|sub-only|subscribers only") {
        return "This Twitch VOD is subscriber-only and cannot be downloaded.".into();
    }
    if has("Unsupported URL|is not a valid URL") {
        return "That link is not supported. Use a YouTube or Twitch link (video, clip or VOD).".into();
    }
    if has("does not exist|not found|404|expired|deleted") {
        return "This video or clip no longer exists (deleted or expired).".into();
    }
    if has("Private video|Sign in|unavailable|removed") {
        return "This video is private, unavailable or age/sign-in restricted.".into();
    }
    if has("Unable to download|getaddrinfo|Network|timed out") {
        return "Network problem – check your connection and try again.".into();
    }
    line.trim_start_matches("ERROR:").trim().chars().take(220).collect()
}

fn import_url(app: &AppHandle, url: &str, range: &str) -> Res<Value> {
    let id = uid();
    let range = range.trim();
    if !range.is_empty() && !RANGE.is_match(range) {
        return Err("Part to download must look like 1:02:00-1:30:00 (start-end).".into());
    }
    emit(app, "import", json!({ "id": id, "stage": "info", "pct": 0, "msg": "Reading video info…" }));
    let ytdlp = tool(app, "yt-dlp");
    let info = run_quiet(&ytdlp, &[s("--dump-single-json"), s("--no-playlist"), s("--no-warnings"), s("--encoding"), s("utf-8"), s(url)], None)?;
    if info.code != 0 {
        return Err(friendly_ytdlp(&info.err));
    }
    let meta: Value = serde_json::from_str(&info.out).map_err(|_| "Could not read the video info.".to_string())?;
    let tpl = lib_dir().join(format!("%(id)s_{id}.%(ext)s"));
    // best video up to 1080p, prefer H.264/AAC (plays everywhere); works for YouTube, Twitch clips + VODs and most sites
    let mut args = vec![s("-f"), s("bv*+ba/b"), s("-S"), s("res:1080,vcodec:h264,acodec:aac")];
    if !range.is_empty() {
        args.extend([s("--download-sections"), format!("*{range}")]);
    }
    args.extend([
        s("--merge-output-format"), s("mp4"), s("--ffmpeg-location"), bin_dir(app).to_string_lossy().into_owned(),
        s("--no-playlist"), s("--newline"), s("--no-warnings"), s("--encoding"), s("utf-8"),
        s("--print"), s("after_move:filepath"), s("-o"), tpl.to_string_lossy().into_owned(), s(url),
    ]);
    let mut file: Option<PathBuf> = None;
    let r = run(&ytdlp, &args, None, |l| {
        if let Some(m) = PCT.captures(l) {
            let p: f64 = m[1].parse().unwrap_or(0.0);
            emit(app, "import", json!({ "id": id, "stage": "download", "pct": p, "msg": "Downloading…" }));
        } else if l.starts_with("[Merger]") {
            emit(app, "import", json!({ "id": id, "stage": "download", "pct": 99, "msg": "Merging streams…" }));
        } else if !l.starts_with('[') && Path::new(l.trim()).exists() {
            file = Some(PathBuf::from(l.trim()));
        }
    }, |_| {})?;
    let file = match file {
        Some(f) if r.code == 0 => f,
        _ => return Err(friendly_ytdlp(&r.err)),
    };
    finish_video(app, &id, &file, meta["title"].as_str().map(String::from), url)
}

#[tauri::command]
pub async fn video_url(app: AppHandle, url: String, range: Option<String>) -> Res<Value> {
    blocking(move || import_url(&app, &url, &range.unwrap_or_default())).await
}

#[tauri::command]
pub async fn video_file(app: AppHandle) -> Res<Option<Value>> {
    blocking(move || {
        let pick = app.dialog().file().set_title("Import video").add_filter("Video", &["mp4", "mkv", "mov", "webm", "avi", "m4v"]).blocking_pick_file();
        let Some(p) = pick.and_then(|p| p.into_path().ok()) else { return Ok(None) };
        finish_video(&app, &uid(), &p, None, "").map(Some)
    })
    .await
}

#[tauri::command]
pub async fn video_path(app: AppHandle, path: String) -> Res<Value> {
    blocking(move || finish_video(&app, &uid(), Path::new(&path), None, "")).await
}
