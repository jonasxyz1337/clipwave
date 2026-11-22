//! Real chat replay for the moment of a clip: Twitch (clips + VODs, via Twitch's public web API)
//! and YouTube live-stream replays (via yt-dlp's live_chat download).
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::util::*;

// public client id of the twitch.tv website (what the web player itself uses for chat replay)
const TWITCH_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
static TW_CLIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:twitch\.tv/[^/]+/clip/|clips\.twitch\.tv/(?:embed\?clip=)?)([A-Za-z0-9_-]+)").unwrap());
static TW_VOD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"twitch\.tv/(?:[^/]+/)?videos?/(\d+)").unwrap());
static YT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:youtube\.com|youtu\.be)").unwrap());

struct Msg {
    t: f64,
    name: String,
    color: Option<String>,
    text: String,
}

fn gql(client: &reqwest::blocking::Client, query: &str) -> Res<Value> {
    let r = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-ID", TWITCH_CLIENT_ID)
        .json(&json!({ "query": query }))
        .send()
        .map_err(|_| "Cannot reach Twitch – check your internet connection.".to_string())?;
    let v: Value = r.json().map_err(|e| e.to_string())?;
    if let Some(e) = v["errors"].as_array().and_then(|a| a.first()) {
        return Err(format!("Twitch: {}", e["message"].as_str().unwrap_or("request failed")));
    }
    Ok(v["data"].clone())
}

/// Messages of a Twitch VOD between two stream offsets (seconds).
/// Pages are fetched by time offset – like seeking in the Twitch player – not by cursor.
fn twitch_comments(client: &reqwest::blocking::Client, vod: &str, from: f64, to: f64) -> Res<Vec<Msg>> {
    let fields = "edges { node { id contentOffsetSeconds commenter { displayName } message { userColor fragments { text } } } } pageInfo { hasNextPage }";
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut at = from.max(0.0).floor() as i64;
    for _ in 0..40 {
        let page = gql(client, &format!(r#"{{ video(id: "{vod}") {{ comments(contentOffsetSeconds: {at}) {{ {fields} }} }} }}"#))?;
        let c = &page["video"]["comments"];
        if c.is_null() {
            return Err("Twitch has no chat replay for this video (deleted VOD or chat disabled).".into());
        }
        let edges = c["edges"].as_array().cloned().unwrap_or_default();
        let mut last_t = at as f64;
        for e in &edges {
            let n = &e["node"];
            let t = n["contentOffsetSeconds"].as_f64().unwrap_or(0.0);
            last_t = last_t.max(t);
            let text: String = n["message"]["fragments"].as_array().into_iter().flatten().filter_map(|f| f["text"].as_str()).collect();
            let id = n["id"].as_str().map(String::from).unwrap_or_else(|| format!("{t}{text}"));
            if t >= from && t <= to && !text.trim().is_empty() && seen.insert(id) {
                out.push(Msg { t, name: n["commenter"]["displayName"].as_str().unwrap_or("user").to_string(), color: n["message"]["userColor"].as_str().map(String::from), text: text.trim().to_string() });
            }
        }
        let more = c["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false);
        if !more || edges.is_empty() || last_t > to {
            break;
        }
        // continue after the last second of this page (at least one second forward)
        at = (last_t as i64).max(at + 1);
    }
    out.sort_by(|a, b| a.t.total_cmp(&b.t));
    Ok(out)
}

/// YouTube live replay chat via yt-dlp (downloads the chat of the whole stream once).
fn youtube_chat(app: &AppHandle, url: &str, from: f64, to: f64) -> Res<Vec<Msg>> {
    let tmp = tempfile::Builder::new().prefix("clipwave-chat-").tempdir().map_err(|e| e.to_string())?;
    let tpl = tmp.path().join("chat.%(ext)s").to_string_lossy().into_owned();
    let r = run_quiet(&tool(app, "yt-dlp"), &[s("--skip-download"), s("--write-subs"), s("--sub-langs"), s("live_chat"), s("--no-warnings"), s("-o"), tpl, s(url)], None)?;
    let file = std::fs::read_dir(tmp.path()).into_iter().flatten().flatten().map(|e| e.path()).find(|p| p.to_string_lossy().contains("live_chat"));
    let Some(file) = file else {
        return Err(if r.code != 0 { "Could not load the YouTube chat.".into() } else { "This YouTube video has no chat replay (only live-stream replays have one).".into() });
    };
    let mut out = Vec::new();
    for line in std::fs::read_to_string(file).map_err(|e| e.to_string())?.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let act = &v["replayChatItemAction"];
        let t = act["videoOffsetTimeMsec"].as_str().and_then(|x| x.parse::<f64>().ok()).unwrap_or(-1.0) / 1000.0;
        if t < from || t > to {
            continue;
        }
        for a in act["actions"].as_array().into_iter().flatten() {
            let m = &a["addChatItemAction"]["item"]["liveChatTextMessageRenderer"];
            if m.is_null() {
                continue;
            }
            let text: String = m["message"]["runs"].as_array().into_iter().flatten().map(|r| r["text"].as_str().map(String::from).unwrap_or_else(|| r["emoji"]["shortcuts"][0].as_str().unwrap_or("").to_string())).collect();
            if !text.trim().is_empty() {
                out.push(Msg { t, name: m["authorName"]["simpleText"].as_str().unwrap_or("user").to_string(), color: None, text: text.trim().to_string() });
            }
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReq {
    url: String,
    /// where the downloaded file starts inside the stream (seconds), for VODs imported with a range
    range_start: Option<f64>,
    /// window inside the downloaded file (seconds)
    start: f64,
    end: f64,
    /// extra seconds before `start` so the box is not empty when it appears
    lead: Option<f64>,
}

/// Returns `{ offset, msgs: [{ t, name, color, text }] }` – `t` relative to the downloaded file,
/// `offset` = stream time at the start of the downloaded file (for the LIVE badge).
#[tauri::command]
pub async fn chat_replay(app: AppHandle, req: ChatReq) -> Res<Value> {
    blocking(move || {
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
        let lead = req.lead.unwrap_or(20.0);
        let (offset, msgs) = if let Some(m) = TW_CLIP.captures(&req.url) {
            let slug = &m[1];
            let d = gql(&client, &format!(r#"{{ clip(slug: "{slug}") {{ videoOffsetSeconds video {{ id }} }} }}"#))?;
            let vod = d["clip"]["video"]["id"].as_str().ok_or("This clip’s stream (VOD) was deleted, so its chat is gone.")?.to_string();
            let off = d["clip"]["videoOffsetSeconds"].as_f64().unwrap_or(0.0);
            (off, twitch_comments(&client, &vod, off + req.start - lead, off + req.end)?)
        } else if let Some(m) = TW_VOD.captures(&req.url) {
            let off = req.range_start.unwrap_or(0.0);
            (off, twitch_comments(&client, &m[1], off + req.start - lead, off + req.end)?)
        } else if YT.is_match(&req.url) {
            let off = req.range_start.unwrap_or(0.0);
            (off, youtube_chat(&app, &req.url, off + req.start - lead, off + req.end)?)
        } else {
            return Err("Real chat works for Twitch clips/VODs and YouTube live-stream replays.".into());
        };
        let msgs: Vec<Value> = msgs.into_iter().map(|m| json!({ "t": ((m.t - offset) * 100.0).round() / 100.0, "name": m.name, "color": m.color, "text": m.text })).collect();
        Ok(json!({ "offset": offset, "msgs": msgs }))
    })
    .await
}
