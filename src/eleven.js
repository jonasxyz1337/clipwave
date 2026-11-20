// ElevenLabs Scribe speech-to-text (word-level timestamps). Needs the user's own API key.
const fs = require('fs');
const os = require('os');
const path = require('path');

const STT_URL = process.env.CW_STT_URL || 'https://api.elevenlabs.io/v1/speech-to-text';

// deps: { run, FFMPEG, emit, Shared }
async function transcribeEleven(deps, { clipId, videoPath, start, end, lang, apiKey }) {
  const { run, FFMPEG, emit, Shared } = deps;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwave-e11-'));
  try {
    const wav = path.join(tmp, 'a.wav');
    emit('transcribe', { clipId, pct: 8, msg: 'Extracting audio…' });
    const a = await run(FFMPEG, ['-y', '-ss', String(start), '-t', String(end - start), '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    if (a.code !== 0 || !fs.existsSync(wav)) throw new Error('This clip has no audio track to transcribe.');
    const data = fs.readFileSync(wav);

    const call = async (modelId) => {
      const fd = new FormData();
      fd.append('model_id', modelId);
      fd.append('timestamps_granularity', 'word');
      fd.append('tag_audio_events', 'false');
      fd.append('diarize', 'false');
      if (lang && lang !== 'auto') fd.append('language_code', lang);
      fd.append('file', new Blob([data], { type: 'audio/wav' }), 'clip.wav');
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 300000);
      try { return await fetch(STT_URL, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: fd, signal: ctl.signal }); }
      catch (e) { throw new Error(e.name === 'AbortError' ? 'ElevenLabs took too long to answer. Try again.' : 'Cannot reach ElevenLabs – check your internet connection.'); }
      finally { clearTimeout(to); }
    };

    emit('transcribe', { clipId, pct: 25, msg: 'Uploading to ElevenLabs…' });
    let res = await call('scribe_v2');
    if (res.status === 400 || res.status === 422) {
      const t = await res.clone().text();
      if (/model/i.test(t)) res = await call('scribe_v1');
    }
    emit('transcribe', { clipId, pct: 85, msg: 'Processing…' });
    if (!res.ok) {
      let msg = '';
      try { const j = await res.json(); msg = (j.detail && (j.detail.message || j.detail)) || j.message || ''; } catch {}
      msg = typeof msg === 'string' ? msg : JSON.stringify(msg);
      if (res.status === 401 || res.status === 403) throw new Error('ElevenLabs rejected the API key. Check it in Settings.');
      if (res.status === 402 || res.status === 429 || /quota|limit/i.test(msg)) throw new Error('ElevenLabs quota or rate limit reached: ' + msg.slice(0, 160));
      throw new Error('ElevenLabs error ' + res.status + (msg ? ': ' + msg.slice(0, 200) : ''));
    }
    const j = await res.json();
    const words = (j.words || [])
      .filter((w) => w.type === 'word' && w.text && w.text.trim())
      .map((w) => ({ w: w.text.trim(), s: w.start, e: Math.max(w.end, w.start + 0.08) }));
    for (let i = 0; i < words.length - 1; i++) if (words[i].e > words[i + 1].s) words[i].e = Math.max(words[i].s + 0.05, words[i + 1].s);
    return Shared.autoImportant(words);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { transcribeEleven };
