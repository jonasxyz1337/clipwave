//! Shared helpers: app paths, events, ids and running the bundled command-line tools.
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type Res<T> = Result<T, String>;

/// Folder with ffmpeg / ffprobe / yt-dlp / whisper (bundled resources, or ../bin while developing).
pub fn bin_dir(app: &AppHandle) -> PathBuf {
    if let Ok(d) = std::env::var("CW_BIN") {
        return d.into();
    }
    if let Ok(r) = app.path().resource_dir() {
        let b = r.join("bin");
        if b.join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX)).exists() {
            return b;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("bin")
}
pub fn tool(app: &AppHandle, name: &str) -> PathBuf {
    let b = bin_dir(app);
    let exe = std::env::consts::EXE_SUFFIX;
    match name {
        // Windows ships the MSVC build folder, macOS a single static binary
        "whisper" if cfg!(windows) => b.join("whisper").join("Release").join("whisper-cli.exe"),
        "whisper" => b.join("whisper").join("whisper-cli"),
        n => b.join(format!("{n}{exe}")),
    }
}

/// Windows: %APPDATA%\Clipwave (same folder as the Electron versions, so projects carry over).
/// macOS: ~/Library/Application Support/Clipwave.
pub fn user_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CW_DATA") {
        return d.into();
    }
    if cfg!(windows) {
        PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into())).join("Clipwave")
    } else {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join("Library").join("Application Support").join("Clipwave")
    }
}
pub fn sub_dir(name: &str) -> PathBuf {
    let d = user_dir().join(name);
    let _ = std::fs::create_dir_all(&d);
    d
}
pub fn lib_dir() -> PathBuf {
    sub_dir("library")
}

pub fn uid() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let ms = n.as_millis() as u64;
    let rnd = (n.subsec_nanos() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 40;
    format!("{}{}", radix36(ms), &format!("{:0>4}", radix36(rnd))[..4])
}
fn radix36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut s = Vec::new();
    loop {
        s.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// Sends `{type, ...data}` to the window – same event shape the UI always used.
pub fn emit(app: &AppHandle, kind: &str, data: Value) {
    let mut v = json!({ "type": kind });
    if let (Some(o), Value::Object(d)) = (v.as_object_mut(), data) {
        o.extend(d);
    }
    let _ = app.emit("evt", v);
}

pub fn stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

// ---------- running tools ----------
static PIDS: LazyLock<Mutex<HashSet<u32>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Kills every running tool (and its children, e.g. ffmpeg started by yt-dlp).
pub fn kill_all() {
    let pids: Vec<u32> = PIDS.lock().unwrap().iter().copied().collect();
    for pid in pids {
        let p = pid.to_string();
        if cfg!(windows) {
            let mut c = Command::new("taskkill");
            c.args(["/PID", &p, "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            c.creation_flags(CREATE_NO_WINDOW);
            let _ = c.status();
        } else {
            // children first (e.g. ffmpeg started by yt-dlp), then the tool itself
            let _ = Command::new("pkill").args(["-9", "-P", &p]).status();
            let _ = Command::new("kill").args(["-9", &p]).status();
        }
    }
}

pub fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub struct RunOut {
    pub code: i32,
    pub out: String,
    pub err: String,
}

/// Runs a tool, calling the callbacks for every stdout / stderr line (split on \n and \r for progress bars).
pub fn run<O, E>(exe: &Path, args: &[String], cwd: Option<&Path>, mut on_out: O, mut on_err: E) -> Res<RunOut>
where
    O: FnMut(&str) + Send,
    E: FnMut(&str) + Send,
{
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");
    hidden(&mut cmd);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    let name = exe.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut child = cmd.spawn().map_err(|e| format!("Cannot start {name}: {e}"))?;
    let pid = child.id();
    PIDS.lock().unwrap().insert(pid);
    let so = child.stdout.take().unwrap();
    let se = child.stderr.take().unwrap();
    let (out, err) = std::thread::scope(|s| {
        let h = s.spawn(move || pump(se, &mut on_err, 20_000));
        let out = pump(so, &mut on_out, usize::MAX / 4);
        (out, h.join().unwrap_or_default())
    });
    let status = child.wait();
    PIDS.lock().unwrap().remove(&pid);
    let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
    Ok(RunOut { code, out, err })
}

pub fn run_quiet(exe: &Path, args: &[String], cwd: Option<&Path>) -> Res<RunOut> {
    run(exe, args, cwd, |_| {}, |_| {})
}

fn pump<R: Read>(mut r: R, cb: &mut dyn FnMut(&str), cap: usize) -> String {
    let (mut all, mut line, mut buf) = (Vec::new(), Vec::new(), [0u8; 8192]);
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !line.is_empty() {
                    cb(&String::from_utf8_lossy(&line));
                    line.clear();
                }
            } else {
                line.push(b);
            }
        }
        all.extend_from_slice(&buf[..n]);
        if all.len() > cap.saturating_mul(2) {
            let cut = all.len() - cap;
            all.drain(..cut);
        }
    }
    if !line.is_empty() {
        cb(&String::from_utf8_lossy(&line));
    }
    String::from_utf8_lossy(&all).into_owned()
}

pub fn s(v: impl ToString) -> String {
    v.to_string()
}

/// Runs blocking work off the UI thread and flattens the join error.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Last few non-empty lines of a tool's stderr, for error messages.
pub fn tail(err: &str, n: usize, max: usize) -> String {
    let lines: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
    let t = lines[lines.len().saturating_sub(n)..].join(" | ");
    t.chars().take(max).collect()
}
