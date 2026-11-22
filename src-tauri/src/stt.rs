//! Speech-to-text: local whisper.cpp (model downloaded on demand) or ElevenLabs Scribe, plus 1-click ElevenLabs connect.
//! Returns plain words {w,s,e}; the UI marks important words (shared JS logic).
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::util::*;

pub const MODELS: [(&str, &str); 3] = [("base", "ggml-base.bin"), ("small", "ggml-small.bin"), ("medium", "ggml-medium.bin")];
pub fn model_file(name: &str) -> &'static str {
    MODELS.iter().find(|(n, _)| *n == name).map(|(_, f)| *f).unwrap_or("ggml-base.bin")
}

fn download_model(app: &AppHandle, name: &str) -> Res<PathBuf> {
    let file = model_file(name);
    let dest = sub_dir("models").join(file);
    if dest.exists() {
        return Ok(dest);
    }
    let fail = |e: String| format!("Model download failed: {e}. Check your connection.");
    let client = reqwest::blocking::Client::builder().timeout(None).build().map_err(|e| fail(e.to_string()))?;
    let mut res = client.get(format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}")).send().map_err(|e| fail(e.to_string()))?;
    if !res.status().is_success() {
        return Err(format!("Model download failed (HTTP {}). Check your connection.", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(1).max(1) as f64;
    let part = dest.with_extension("bin.part");
    let mut out = std::fs::File::create(&part).map_err(|e| fail(e.to_string()))?;
    let (mut got, mut buf, mut last) = (0u64, vec![0u8; 1 << 16], Instant::now());
    loop {
        let n = res.read(&mut buf).map_err(|e| fail(e.to_string()))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| fail(e.to_string()))?;
        got += n as u64;
        if last.elapsed() > Duration::from_millis(150) {
            last = Instant::now();
            emit(app, "model", json!({ "name": name, "pct": got as f64 / total * 100.0 }));
        }
    }
    drop(out);
    std::fs::rename(&part, &dest).map_err(|e| fail(e.to_string()))?;
    Ok(dest)
}

/// Picks the requested model, downloading it if needed; offline it falls back to any model already on disk.
fn ensure_model(app: &AppHandle, name: &str, clip: &str) -> Res<PathBuf> {
    match download_model(app, name) {
        Ok(p) => Ok(p),
        Err(e) => {
            let have = MODELS.iter().map(|(_, f)| sub_dir("models").join(f)).find(|p| p.exists());
            match have {
                Some(p) if e.starts_with("Model download") => {
                    emit(app, "transcribe", json!({ "clipId": clip, "pct": 1, "msg": "Offline – using an already downloaded model" }));
                    Ok(p)
                }
                _ => Err(e),
            }
        }
    }
}

fn extract_wav(app: &AppHandle, video: &str, start: f64, end: f64, wav: &Path, clean: bool) -> Res<()> {
    let mut args = vec![s("-y"), s("-ss"), s(start), s("-t"), s(end - start), s("-i"), s(video), s("-vn"), s("-ac"), s("1"), s("-ar"), s("16000")];
    if clean {
        args.extend([s("-af"), s("highpass=f=80,lowpass=f=7600,dynaudnorm=f=150:g=15")]);
    }
    args.extend([s("-c:a"), s("pcm_s16le"), wav.to_string_lossy().into_owned()]);
    let a = run_quiet(&tool(app, "ffmpeg"), &args, None)?;
    if a.code != 0 || !wav.exists() {
        return Err("This clip has no audio track to transcribe.".into());
    }
    Ok(())
}

static PROG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"progress\s*=\s*(\d+)%").unwrap());
static NOISE_TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[_[^\]]*\]$|^<\|.*\|>$").unwrap());
static ANNOTATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\[(*♪].*[\])*♪]$").unwrap());

#[derive(Clone)]
struct Word {
    w: String,
    s: f64,
    e: f64,
}

fn whisper(app: &AppHandle, o: &Opts) -> Res<Vec<Word>> {
    let exe = tool(app, "whisper");
    if !exe.exists() {
        return Err("Whisper files are missing from the installation.".into());
    }
    emit(app, "transcribe", json!({ "clipId": o.clip_id, "pct": 1, "msg": "Preparing model…" }));
    let model = ensure_model(app, o.model.as_deref().unwrap_or("small"), &o.clip_id)?;
    let tmp = tempfile::Builder::new().prefix("clipwave-w-").tempdir().map_err(|e| e.to_string())?;
    let wav = tmp.path().join("a.wav");
    emit(app, "transcribe", json!({ "clipId": o.clip_id, "pct": 3, "msg": "Extracting audio…" }));
    extract_wav(app, &o.video_path, o.start, o.end, &wav, true)?;
    let threads = o.threads.filter(|t| *t > 0).unwrap_or_else(|| (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).max(2) as u64);
    let lang = o.lang.as_deref().filter(|l| *l != "auto").unwrap_or("auto");
    let args = [
        s("-m"), model.to_string_lossy().into_owned(), s("-f"), wav.to_string_lossy().into_owned(), s("-ojf"), s("-of"), tmp.path().join("out").to_string_lossy().into_owned(),
        s("-pp"), s("-bs"), s("5"), s("-bo"), s("5"), s("-mc"), s("0"), s("-nth"), s("0.5"), s("-t"), s(threads), s("-l"), s(lang),
    ];
    let r = run(&exe, &args, None, |_| {}, |l| {
        if let Some(m) = PROG.captures(l) {
            let p: f64 = m[1].parse().unwrap_or(0.0);
            emit(app, "transcribe", json!({ "clipId": o.clip_id, "pct": 5.0 + p * 0.93, "msg": "Transcribing…" }));
        }
    })?;
    let jf = tmp.path().join("out.json");
    if r.code != 0 || !jf.exists() {
        return Err(format!("Whisper failed: {}", tail(&r.err, 3, 200)));
    }
    let j: Value = serde_json::from_slice(&std::fs::read(&jf).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // rebuild real words from sub-word tokens: a token starting with a space begins a new word
    let mut words: Vec<Word> = Vec::new();
    let mut cur: Option<Word> = None;
    let flush = |cur: &mut Option<Word>, words: &mut Vec<Word>| {
        if let Some(c) = cur.take() {
            if !c.w.trim().is_empty() {
                words.push(Word { w: c.w.trim().to_string(), s: c.s, e: c.e.max(c.s + 0.08) });
            }
        }
    };
    for seg in j["transcription"].as_array().into_iter().flatten() {
        for tk in seg["tokens"].as_array().into_iter().flatten() {
            let Some(t) = tk["text"].as_str() else { continue };
            if NOISE_TOKEN.is_match(t.trim()) {
                continue;
            }
            let from = tk["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0;
            let to = tk["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0;
            match cur.as_mut() {
                Some(c) if !t.starts_with(char::is_whitespace) => {
                    c.w.push_str(t);
                    c.e = to;
                }
                _ => {
                    flush(&mut cur, &mut words);
                    cur = Some(Word { w: t.to_string(), s: from, e: to });
                }
            }
        }
        flush(&mut cur, &mut words);
    }
    // drop non-speech annotations like [MUSIC] / (laughs)
    let mut clean: Vec<Word> = words.into_iter().filter(|w| !ANNOTATION.is_match(&w.w)).collect();
    // monotonic, overlap-free timings for smooth highlighting
    for i in 0..clean.len() {
        if i > 0 && clean[i].s < clean[i - 1].s {
            clean[i].s = clean[i - 1].s;
        }
        if i + 1 < clean.len() && clean[i].e > clean[i + 1].s {
            clean[i].e = (clean[i].s + 0.05).max(clean[i + 1].s);
        }
    }
    Ok(clean)
}

fn stt_url() -> String {
    std::env::var("CW_STT_URL").unwrap_or_else(|_| "https://api.elevenlabs.io/v1/speech-to-text".into())
}

fn eleven(app: &AppHandle, o: &Opts) -> Res<Vec<Word>> {
    let key = o.api_key.clone().unwrap_or_default();
    let tmp = tempfile::Builder::new().prefix("clipwave-e11-").tempdir().map_err(|e| e.to_string())?;
    let wav = tmp.path().join("a.wav");
    emit(app, "transcribe", json!({ "clipId": o.clip_id, "pct": 8, "msg": "Extracting audio…" }));
    extract_wav(app, &o.video_path, o.start, o.end, &wav, false)?;
    let data = std::fs::read(&wav).map_err(|e| e.to_string())?;
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let call = |model: &str| -> Res<(u16, String)> {
        let mut form = reqwest::blocking::multipart::Form::new()
            .text("model_id", model.to_string())
            .text("timestamps_granularity", "word")
            .text("tag_audio_events", "false")
            .text("diarize", "false");
        if let Some(l) = o.lang.as_deref().filter(|l| *l != "auto") {
            form = form.text("language_code", l.to_string());
        }
        let part = reqwest::blocking::multipart::Part::bytes(data.clone()).file_name("clip.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
        form = form.part("file", part);
        let res = client.post(stt_url()).header("xi-api-key", &key).multipart(form).send().map_err(|e| {
            if e.is_timeout() { "ElevenLabs took too long to answer. Try again.".to_string() } else { "Cannot reach ElevenLabs – check your internet connection.".to_string() }
        })?;
        let code = res.status().as_u16();
        Ok((code, res.text().unwrap_or_default()))
    };
    emit(app, "transcribe", json!({ "clipId": o.clip_id, "pct": 25, "msg": "Uploading to ElevenLabs…" }));
    let mut res = call("scribe_v2")?;
    if (res.0 == 400 || res.0 == 422) && res.1.to_lowercase().contains("model") {
        res = call("scribe_v1")?;
    }
    emit(app, "transcribe", json!({ "clipId": o.clip_id, "pct": 85, "msg": "Processing…" }));
    let (code, body) = res;
    let j: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if !(200..300).contains(&code) {
        let d = &j["detail"];
        let msg = d["message"].as_str().map(String::from).or_else(|| d.as_str().map(String::from)).or_else(|| j["message"].as_str().map(String::from)).unwrap_or_else(|| if d.is_null() { String::new() } else { d.to_string() });
        if code == 401 || code == 403 {
            return Err("ElevenLabs rejected the API key. Check it in Settings.".into());
        }
        if code == 402 || code == 429 || Regex::new("(?i)quota|limit").unwrap().is_match(&msg) {
            return Err(format!("ElevenLabs quota or rate limit reached: {}", msg.chars().take(160).collect::<String>()));
        }
        return Err(format!("ElevenLabs error {code}{}", if msg.is_empty() { String::new() } else { format!(": {}", msg.chars().take(200).collect::<String>()) }));
    }
    let mut words: Vec<Word> = j["words"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|w| w["type"] == "word" && w["text"].as_str().is_some_and(|t| !t.trim().is_empty()))
        .map(|w| {
            let st = w["start"].as_f64().unwrap_or(0.0);
            Word { w: w["text"].as_str().unwrap().trim().to_string(), s: st, e: w["end"].as_f64().unwrap_or(st).max(st + 0.08) }
        })
        .collect();
    for i in 0..words.len().saturating_sub(1) {
        if words[i].e > words[i + 1].s {
            words[i].e = (words[i].s + 0.05).max(words[i + 1].s);
        }
    }
    Ok(words)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opts {
    clip_id: String,
    video_path: String,
    start: f64,
    end: f64,
    lang: Option<String>,
    threads: Option<u64>,
    model: Option<String>,
    engine: Option<String>,
    api_key: Option<String>,
}

#[tauri::command]
pub async fn transcribe(app: AppHandle, opts: Opts) -> Res<Vec<Value>> {
    blocking(move || {
        let words = if opts.engine.as_deref() == Some("elevenlabs") { eleven(&app, &opts)? } else { whisper(&app, &opts)? };
        Ok(words.into_iter().map(|w| json!({ "w": w.w, "s": w.s, "e": w.e })).collect())
    })
    .await
}

// ---------- ElevenLabs 1-click connect: open the key page, watch the clipboard for a copied key ----------
static WATCH: AtomicU64 = AtomicU64::new(0);
static KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^sk_[A-Za-z0-9]{20,}$").unwrap());

#[tauri::command]
pub fn eleven_connect(app: AppHandle) -> Res<()> {
    let gen = WATCH.fetch_add(1, Ordering::SeqCst) + 1;
    let a = app.clone();
    std::thread::spawn(move || {
        let read = || a.clipboard().read_text().map(|t| t.trim().to_string()).unwrap_or_default();
        let mut last = read();
        let until = Instant::now() + Duration::from_secs(600);
        while WATCH.load(Ordering::SeqCst) == gen && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(600));
            let t = read();
            if t != last {
                last = t.clone();
                if KEY_RE.is_match(&t) {
                    emit(&a, "elkey", json!({ "key": t }));
                    break;
                }
            }
        }
    });
    tauri_plugin_opener::open_url("https://elevenlabs.io/app/settings/api-keys", None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn eleven_stop() {
    WATCH.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub async fn eleven_check(key: String) -> Res<Value> {
    blocking(move || {
        let base = Regex::new(r"/speech-to-text.*$").unwrap().replace(&stt_url(), "").into_owned();
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
        let Ok(r) = client.get(format!("{base}/user")).header("xi-api-key", &key).send() else {
            return Ok(json!({ "ok": false, "error": "Cannot reach ElevenLabs - check your internet connection.", "offline": true }));
        };
        let code = r.status().as_u16();
        if (200..300).contains(&code) {
            return Ok(json!({ "ok": true }));
        }
        let j: Value = r.json().unwrap_or(Value::Null);
        // restricted key: valid, it just may not read /user
        if code == 401 && j["detail"]["status"] == "missing_permissions" {
            return Ok(json!({ "ok": true, "restricted": true }));
        }
        let error = if code == 401 { "ElevenLabs does not accept this key.".to_string() } else { format!("ElevenLabs check failed ({code}).") };
        Ok(json!({ "ok": false, "error": error }))
    })
    .await
}
