const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const Shared = require('./shared.js');
const { transcribeEleven } = require('./eleven.js');

const BIN = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'bin');
const FFMPEG = path.join(BIN, 'ffmpeg.exe');
const FFPROBE = path.join(BIN, 'ffprobe.exe');
const YTDLP = path.join(BIN, 'yt-dlp.exe');
const WHISPER = path.join(BIN, 'whisper', 'Release', 'whisper-cli.exe');
const MODEL = path.join(BIN, 'ggml-base.bin');

if (process.env.CW_DATA) app.setPath('userData', process.env.CW_DATA);
let win;
const procs = new Set();
let cancelExport = false;

const userDir = () => app.getPath('userData');
const libDir = () => { const d = path.join(userDir(), 'library'); fs.mkdirSync(d, { recursive: true }); return d; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const emit = (type, data) => { if (win && !win.isDestroyed()) win.webContents.send('evt', { type, ...data }); };

function run(cmd, args, { cwd, onOut, onErr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    procs.add(p);
    let out = '', err = '', ob = '', eb = '';
    const split = (buf, chunk, cb) => { buf += chunk; const parts = buf.split(/\r\n|\n|\r/); buf = parts.pop(); if (cb) parts.forEach(cb); return buf; };
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; ob = split(ob, d, onOut); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); eb = split(eb, d, onErr); });
    p.on('error', (e) => { procs.delete(p); reject(new Error(`Cannot start ${path.basename(cmd)}: ${e.message}`)); });
    p.on('close', (code, sig) => { procs.delete(p); resolve({ code, sig, out, err }); });
    p.__cancel = () => { try { p.kill(); } catch {} };
  });
}

async function probe(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  if (r.code !== 0) throw new Error('Cannot read this video file (ffprobe failed).');
  const j = JSON.parse(r.out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error('File has no video stream.');
  const [n, d] = (v.avg_frame_rate || '30/1').split('/').map(Number);
  return { w: v.width, h: v.height, duration: parseFloat(j.format.duration || v.duration || 0), fps: d ? n / d : 30, hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio') };
}

async function makeThumb(file, id, at) {
  const out = path.join(libDir(), `${id}.jpg`);
  await run(FFMPEG, ['-y', '-ss', String(Math.max(0, at)), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out]);
  return fs.existsSync(out) ? out : null;
}

// ---------- import ----------
async function importUrl(url, range) {
  const id = uid();
  if (range && !/^\d+(:\d+){0,2}(\.\d+)?-\d+(:\d+){0,2}(\.\d+)?$/.test(range.trim())) throw new Error('Part to download must look like 1:02:00-1:30:00 (start-end).');
  emit('import', { id, stage: 'info', pct: 0, msg: 'Reading video info…' });
  const info = await run(YTDLP, ['--dump-single-json', '--no-playlist', '--no-warnings', '--encoding', 'utf-8', url]);
  if (info.code !== 0) throw new Error(friendlyYtdlp(info.err));
  const meta = JSON.parse(info.out);
  const outTpl = path.join(libDir(), `%(id)s_${id}.%(ext)s`);
  let filePath = null;
  const r = await run(YTDLP, [
    // works for YouTube, Twitch clips + VODs and most other sites: best video up to 1080p, prefer H.264/AAC (plays everywhere)
    '-f', 'bv*+ba/b', '-S', 'res:1080,vcodec:h264,acodec:aac',
    ...(range && range.trim() ? ['--download-sections', '*' + range.trim()] : []),
    '--merge-output-format', 'mp4', '--ffmpeg-location', BIN, '--no-playlist', '--newline', '--no-warnings', '--encoding', 'utf-8',
    '--print', 'after_move:filepath', '-o', outTpl, url,
  ], {
    onOut: (l) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(l);
      if (m) emit('import', { id, stage: 'download', pct: parseFloat(m[1]), msg: 'Downloading…' });
      else if (!l.startsWith('[') && fs.existsSync(l.trim())) filePath = l.trim();
      else if (l.startsWith('[Merger]')) emit('import', { id, stage: 'download', pct: 99, msg: 'Merging streams…' });
    },
  });
  if (r.code !== 0 || !filePath) throw new Error(friendlyYtdlp(r.err));
  return finishVideo(id, filePath, meta.title, url);
}

function friendlyYtdlp(err) {
  const line = (err || '').split('\n').filter((l) => /ERROR/.test(l)).pop() || err || 'Unknown download error';
  if (/subscriber|sub-only|subscribers only/i.test(line)) return 'This Twitch VOD is subscriber-only and cannot be downloaded.';
  if (/Unsupported URL|is not a valid URL/i.test(line)) return 'That link is not supported. Use a YouTube or Twitch link (video, clip or VOD).';
  if (/does not exist|not found|404|expired|deleted/i.test(line)) return 'This video or clip no longer exists (deleted or expired).';
  if (/Private video|Sign in|unavailable|removed/i.test(line)) return 'This video is private, unavailable or age/sign-in restricted.';
  if (/Unable to download|getaddrinfo|Network|timed out/i.test(line)) return 'Network problem – check your connection and try again.';
  return line.replace(/^ERROR:\s*/, '').slice(0, 220);
}

async function finishVideo(id, filePath, title, url) {
  const meta = await probe(filePath);
  const thumb = await makeThumb(filePath, id, Math.min(2, meta.duration / 4));
  return { id, title: title || path.parse(filePath).name, path: filePath, url: url || '', thumb, ...meta, addedAt: Date.now() };
}

// ---------- transcription ----------
const MODELS = { base: ['ggml-base.bin', 148], small: ['ggml-small.bin', 488], medium: ['ggml-medium.bin', 1533] };
const modelsDir = () => { const d = path.join(userDir(), 'models'); fs.mkdirSync(d, { recursive: true }); return d; };
async function ensureModel(name) {
  const [file] = MODELS[name] || MODELS.base;
  if (name === 'base' || !MODELS[name]) return MODEL;
  const dest = path.join(modelsDir(), file);
  if (fs.existsSync(dest)) return dest;
  const https = require('https'); const tmp = dest + '.part';
  await new Promise((resolve, reject) => {
    const get = (url, n = 0) => https.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && n < 6) { res.resume(); return get(res.headers.location, n + 1); }
      if (res.statusCode !== 200) return reject(new Error('Model download failed (HTTP ' + res.statusCode + '). Check your connection.'));
      const total = Number(res.headers['content-length']) || 1; let got = 0; const out = fs.createWriteStream(tmp);
      res.on('data', (d) => { got += d.length; emit('model', { name, pct: (got / total) * 100 }); });
      res.pipe(out); out.on('finish', () => out.close(resolve)); out.on('error', reject); res.on('error', reject);
    }).on('error', (e) => reject(new Error('Model download failed: ' + e.message)));
    get('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + file);
  });
  fs.renameSync(tmp, dest); return dest;
}

async function transcribe({ clipId, videoPath, start, end, lang, threads, model, engine, apiKey }) {
  if (engine === 'elevenlabs') return transcribeEleven({ run, FFMPEG, emit, Shared }, { clipId, videoPath, start, end, lang, apiKey });
  if (!fs.existsSync(WHISPER) || !fs.existsSync(MODEL)) throw new Error('Whisper files are missing from the installation.');
  emit('transcribe', { clipId, pct: 1, msg: 'Preparing model…' });
  let modelPath = MODEL;
  try { modelPath = await ensureModel(model || 'small'); } catch (e) { emit('transcribe', { clipId, pct: 1, msg: 'Using built-in model' }); if (!/Model download/.test(e.message)) throw e; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwave-w-'));
  try {
    const wav = path.join(tmp, 'a.wav');
    emit('transcribe', { clipId, pct: 3, msg: 'Extracting audio…' });
    const a = await run(FFMPEG, ['-y', '-ss', String(start), '-t', String(end - start), '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-af', 'highpass=f=80,lowpass=f=7600,dynaudnorm=f=150:g=15', '-c:a', 'pcm_s16le', wav]);
    if (a.code !== 0 || !fs.existsSync(wav)) throw new Error('This clip has no audio track to transcribe.');
    const args = ['-m', modelPath, '-f', wav, '-ojf', '-of', path.join(tmp, 'out'), '-pp', '-bs', '5', '-bo', '5', '-mc', '0', '-nth', '0.5', '-t', String(threads || Math.max(2, Math.floor(os.cpus().length / 2))), '-l', lang && lang !== 'auto' ? lang : 'auto'];
    const r = await run(WHISPER, args, { onErr: (l) => { const m = /progress\s*=\s*(\d+)%/.exec(l); if (m) emit('transcribe', { clipId, pct: 5 + Number(m[1]) * 0.93, msg: 'Transcribing…' }); } });
    const jf = path.join(tmp, 'out.json');
    if (r.code !== 0 || !fs.existsSync(jf)) throw new Error('Whisper failed: ' + (r.err || '').split('\n').slice(-3).join(' ').slice(0, 200));
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
    // rebuild real words from sub-word tokens: a token starting with a space begins a new word
    const words = []; let cur = null;
    const flush = () => { if (cur && cur.w.trim()) words.push({ w: cur.w.trim(), s: cur.s, e: Math.max(cur.e, cur.s + 0.08) }); cur = null; };
    for (const seg of j.transcription || []) {
      for (const tk of seg.tokens || []) {
        const t = tk.text; if (t == null || /^\[_[^\]]*\]$/.test(t.trim()) || /^<\|.*\|>$/.test(t.trim())) continue;
        const from = tk.offsets.from / 1000, to = tk.offsets.to / 1000;
        if (/^\s/.test(t) || !cur) { flush(); cur = { w: t, s: from, e: to }; } else { cur.w += t; cur.e = to; }
      }
      flush();
    }
    // drop non-speech annotations like [MUSIC] / (laughs)
    const clean = words.filter((w) => !/^[\[(*♪].*[\])*♪]$/.test(w.w));
    // make timings monotonic and gap-free enough for smooth highlighting
    for (let i = 0; i < clean.length; i++) { if (i && clean[i].s < clean[i - 1].s) clean[i].s = clean[i - 1].s; if (i < clean.length - 1 && clean[i].e > clean[i + 1].s) clean[i].e = Math.max(clean[i].s + 0.05, clean[i + 1].s); }
    return Shared.autoImportant(clean);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- export ----------
function stageFonts(tmp, fonts) {
  const dir = path.join(tmp, 'fonts'); fs.mkdirSync(dir, { recursive: true });
  const src = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const files = new Set(['arial.ttf', 'arialbd.ttf']);
  fonts.forEach((f) => (Shared.FONTS[f] || []).forEach((x) => files.add(x)));
  files.forEach((f) => { try { fs.copyFileSync(path.join(src, f), path.join(dir, f)); } catch {} });
}


// ---------- outro renderer (canvas motion graphics -> mp4 segments, cached) ----------
const crypto = require('crypto');
const OUTRO_VERSION = 'v3';
let outroJob = null;
ipcMain.handle('outro:begin', (e, name) => new Promise((resolve, reject) => {
  const p = spawn(FFMPEG, ['-y', '-hide_banner', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1080x1920', '-r', '30', '-i', '-', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '13', '-g', '30', '-pix_fmt', 'yuv420p', outroJob.files[name] + '.part.mp4'], { windowsHide: true });
  procs.add(p); outroJob.cur = { p, name, err: '' };
  p.stderr.on('data', (d) => { outroJob.cur.err = (outroJob.cur.err + d).slice(-2000); });
  p.stdin.on('error', () => {});
  p.on('close', (code) => { procs.delete(p); outroJob.cur.closed = code; if (outroJob.cur.onclose) outroJob.cur.onclose(code); });
  resolve(true);
}));
ipcMain.handle('outro:frame', (e, buf) => new Promise((resolve) => {
  const st = outroJob && outroJob.cur; if (!st || st.closed != null) return resolve(false);
  const ok = st.p.stdin.write(Buffer.from(buf)); if (ok) resolve(true); else st.p.stdin.once('drain', () => resolve(true));
}));
ipcMain.handle('outro:end', () => new Promise((resolve, reject) => {
  const st = outroJob.cur; const fin = (code) => { if (code !== 0) return reject(new Error('outro encode failed: ' + st.err.slice(-300))); fs.renameSync(outroJob.files[st.name] + '.part.mp4', outroJob.files[st.name]); resolve(true); };
  if (st.closed != null) fin(st.closed); else { st.onclose = fin; st.p.stdin.end(); }
}));
ipcMain.handle('outro:done', (e, err) => { if (outroJob && outroJob.finish) outroJob.finish(err); return true; });

async function ensureOutroSegments(o) {
  const dir = path.join(userDir(), 'outro-cache'); fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash('md5').update(OUTRO_VERSION + '|' + (o.title || '') + '|' + (o.sub || '')).digest('hex').slice(0, 12);
  const files = { intro: path.join(dir, key + '_intro.mp4'), loop: path.join(dir, key + '_loop.mp4') };
  if (fs.existsSync(files.intro) && fs.existsSync(files.loop)) return files;
  const ow = new BrowserWindow({ show: false, width: 1080, height: 1920, webPreferences: { preload: path.join(__dirname, 'outro-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await new Promise((resolve, reject) => {
      outroJob = { files, cur: null, finish: (err) => (err ? reject(new Error('Outro render failed: ' + err)) : resolve()) };
      ow.loadFile(path.join(__dirname, 'outro.html'), { hash: encodeURIComponent(JSON.stringify({ title: o.title, sub: o.sub })) }).catch(reject);
      setTimeout(() => reject(new Error('Outro render timed out.')), 240000);
    });
  } finally { outroJob = null; if (!ow.isDestroyed()) ow.destroy(); }
  return files;
}

async function exportOne(job) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwave-e-'));
  const dur = job.end - job.start;
  try {
    const { sub, head, layout, words } = job;
    stageFonts(tmp, [sub.font, head.font, 'Bahnschrift']);
    fs.writeFileSync(path.join(tmp, 'subs.ass'), '﻿' + Shared.buildAss({ words, dur, sub, head, showSubs: job.subsOn, showHead: job.headOn }), 'utf8');
    const od = job.outroDur || 0;
    const fps = job.fps || 30, d3 = dur.toFixed(3);
    const fmtA = 'aformat=channel_layouts=stereo:sample_rates=48000';
    const sounds = (job.sounds || []).filter((x) => x && x.path && fs.existsSync(x.path));
    const origVol = job.origVol == null ? 1 : job.origVol;
    const g = []; let extraIn = [];

    // ---- video: layout -> timed effect boxes -> captions
    const fx = Shared.fxGraph(job.fx || [], 'vc');
    g.push(`${Shared.filterGraph(layout, job.w, job.h)}[vc]`);
    if (fx.graph) g.push(fx.graph);
    g.push(`[${fx.out}]ass=subs.ass:fontsdir=fonts,format=yuv420p${od ? `,fps=${fps},setsar=1` : ''}[va]`);

    // ---- outro (video + its own audio parts)
    let outroAudio = [], vmap = '[va]';
    let nextIn = 1;
    if (od) {
      emit('export', { jobId: job.jobId, pct: 0, msg: 'Preparing outro…' });
      const seg = await ensureOutroSegments(job.outro);
      if (cancelExport) throw new Error('Cancelled');
      const loops = Math.max(1, Math.ceil((od - 2.5) / 3.5) + 1);
      const fwd = (f) => f.replace(/\\/g, '/').replace(/'/g, "'\\''");
      fs.writeFileSync(path.join(tmp, 'outro.txt'), [`file '${fwd(seg.intro)}'`, ...Array.from({ length: loops }, () => `file '${fwd(seg.loop)}'`)].join('\n'));
      const voiceFile = path.join(BIN, 'outro-sound.ogg'), hasVoice = fs.existsSync(voiceFile);
      const D = od.toFixed(2), t0 = Math.max(0, od - 0.45).toFixed(2);
      extraIn.push('-t', D, '-f', 'concat', '-safe', '0', '-i', 'outro.txt'); nextIn = 2;
      if (hasVoice) { extraIn.push('-i', voiceFile); nextIn = 3; }
      g.push(`[1:v]trim=duration=${D},setpts=PTS-STARTPTS,fps=${fps},fade=t=out:st=${t0}:d=0.45,format=yuv420p,setsar=1[vb]`, '[va][vb]concat=n=2:v=1:a=0[v]');
      vmap = '[v]';
      outroAudio = [
        `anoisesrc=d=1.1:c=pink:a=0.5,highpass=f=350,lowpass=f=5000,afade=t=in:st=0:d=0.9,afade=t=out:st=0.9:d=0.2,volume=0.16,${fmtA}[w]`,
        `sine=f=392:d=2.2,afade=t=in:st=0:d=0.05,afade=t=out:st=0.1:d=2.0,volume=0.20,adelay=900|900,${fmtA}[s1]`,
        `sine=f=587.33:d=2.2,afade=t=in:st=0:d=0.05,afade=t=out:st=0.1:d=2.0,volume=0.15,adelay=900|900,${fmtA}[s2]`,
        `sine=f=783.99:d=2.2,afade=t=in:st=0:d=0.05,afade=t=out:st=0.1:d=2.0,volume=0.10,adelay=900|900,${fmtA}[s3]`,
        ...(hasVoice ? ['[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=1.5,adelay=800|800,alimiter=limit=0.95[vo]'] : []),
        `[w][s1][s2][s3]${hasVoice ? '[vo]' : ''}amix=inputs=${hasVoice ? 5 : 4}:duration=longest:normalize=0,apad=whole_dur=${D},atrim=duration=${D},asetpts=N/SR/TB[ao]`,
      ];
    }

    // ---- audio: original track + user sounds (trimmed, timed, faded)
    let amap;
    const needGraph = od || sounds.length || origVol !== 1;
    if (!needGraph) amap = '0:a:0?';
    else {
      g.push(job.hasAudio
        ? `[0:a:0]aresample=48000,aformat=channel_layouts=stereo,volume=${origVol},apad=whole_dur=${d3},atrim=duration=${d3},asetpts=N/SR/TB[a0]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${d3},asetpts=N/SR/TB[a0]`);
      let aOut = 'a0';
      if (sounds.length) {
        sounds.forEach((sn, i) => {
          extraIn.push('-i', sn.path);
          const idx = nextIn + i, tin = Math.max(0, sn.trimIn || 0), tout = sn.trimOut > tin ? sn.trimOut : (sn.dur || tin + 60);
          const at = Math.max(0, sn.at || 0), len = Math.max(0.05, Math.min(tout - tin, dur - at)), fade = Math.min(sn.fade || 0, len / 2);
          const ms = Math.round(at * 1000);
          g.push(`[${idx}:a:0]atrim=start=${tin.toFixed(3)}:duration=${len.toFixed(3)},asetpts=N/SR/TB,aresample=48000,aformat=channel_layouts=stereo,volume=${sn.vol == null ? 1 : sn.vol}${fade > 0 ? `,afade=t=in:st=0:d=${fade.toFixed(2)},afade=t=out:st=${(len - fade).toFixed(3)}:d=${fade.toFixed(2)}` : ''},adelay=${ms}|${ms}[sd${i}]`);
        });
        g.push(`[a0]${sounds.map((_, i) => `[sd${i}]`).join('')}amix=inputs=${sounds.length + 1}:duration=first:normalize=0,alimiter=limit=0.97[am]`);
        aOut = 'am';
      }
      if (od) { g.push(...outroAudio, `[${aOut}][ao]concat=n=2:v=0:a=1[a]`); amap = '[a]'; }
      else amap = `[${aOut}]`;
    }
    const graph = g.join(';');
    const maps = ['-map', vmap, '-map', amap];

    fs.mkdirSync(path.dirname(job.out), { recursive: true });
    const tries = job.encoder === 'nvenc' ? ['nvenc', 'x264'] : ['x264'];
    let last;
    for (const enc of tries) {
      const venc = enc === 'nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', String(job.crf), '-b:v', '0'] : ['-c:v', 'libx264', '-preset', job.preset, '-crf', String(job.crf), '-threads', String(job.threads || 0)];
      const args = ['-y', '-hide_banner', '-ss', String(job.start), '-t', String(dur), '-i', job.videoPath, ...extraIn, '-filter_complex', graph, ...maps, ...venc,
        ...(job.fps && !od ? ['-r', String(job.fps)] : []), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', job.out];
      last = await run(FFMPEG, args, { cwd: tmp, onOut: (l) => { const m = /^out_time_(?:us|ms)=(\d+)/.exec(l); if (m) emit('export', { jobId: job.jobId, pct: Math.min(99, (Number(m[1]) / 1e6 / (dur + od)) * 100) }); } });
      if (cancelExport) throw new Error('Cancelled');
      if (last.code === 0 && fs.existsSync(job.out)) return;
    }
    throw new Error('ffmpeg failed: ' + (last.err || '').split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 400));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function exportBatch(jobs) {
  cancelExport = false;
  const results = [];
  for (const job of jobs) {
    if (cancelExport) { results.push({ jobId: job.jobId, error: 'Cancelled' }); emit('export', { jobId: job.jobId, done: true, error: 'Cancelled' }); continue; }
    emit('export', { jobId: job.jobId, pct: 0, started: true });
    try {
      await exportOne(job);
      const size = fs.statSync(job.out).size;
      results.push({ jobId: job.jobId, out: job.out, size });
      emit('export', { jobId: job.jobId, pct: 100, done: true, out: job.out, size });
    } catch (e) {
      try { fs.rmSync(job.out, { force: true }); } catch {}
      results.push({ jobId: job.jobId, error: e.message });
      emit('export', { jobId: job.jobId, done: true, error: e.message });
    }
  }
  return results;
}

// ---------- window / ipc ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, backgroundColor: '#7a3a9e', title: 'Clipwave', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));
  if (process.env.CW_TEST) {
    const log = (m) => fs.appendFileSync(path.join(path.dirname(process.env.CW_TEST), 'log.txt'), m + '\n');
    global.cwlog = log; log('window created');
    ['dom-ready','did-finish-load','did-start-loading'].forEach((n) => win.webContents.on(n, () => log(n)));
    win.webContents.on('console-message', (e, l, m) => log('CONSOLE ' + (m && m.message ? m.message : m)));
    win.webContents.on('preload-error', (e, p, err) => log('PRELOAD ' + err));
    win.webContents.on('did-fail-load', (e, c, d) => log('FAILLOAD ' + d));
    win.webContents.on('render-process-gone', (e, d) => log('GONE ' + d.reason));
  }
  if (process.env.CW_TEST) win.webContents.once('did-finish-load', () => setTimeout(() => require(process.env.CW_TEST)(win), 800));
}

const stateFile = () => path.join(userDir(), 'state.json');
const wrap = (fn) => async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; } };

ipcMain.handle('state:load', wrap(() => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; } }));
ipcMain.handle('state:save', wrap((s) => { fs.mkdirSync(userDir(), { recursive: true }); const t = stateFile() + '.tmp'; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, stateFile()); return true; }));
ipcMain.handle('env', wrap(() => ({ videos: app.getPath('videos'), whisper: fs.existsSync(WHISPER) && fs.existsSync(MODEL), cpus: os.cpus().length, version: app.getVersion() })));
ipcMain.handle('video:url', wrap(importUrl));
ipcMain.handle('video:file', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import video', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'] }] });
  if (r.canceled) return null;
  const id = uid();
  return finishVideo(id, r.filePaths[0], path.parse(r.filePaths[0]).name, '');
}));
ipcMain.handle('video:path', wrap((p) => finishVideo(uid(), p, path.parse(p).name, '')));
ipcMain.handle('whisper:run', wrap(transcribe));
ipcMain.handle('export:run', wrap(exportBatch));
ipcMain.handle('export:cancel', wrap(() => { cancelExport = true; procs.forEach((p) => p.__cancel && p.__cancel()); return true; }));
ipcMain.handle('dir:pick', wrap(async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; }));
ipcMain.handle('shell:open', wrap((p) => shell.openPath(p)));
ipcMain.handle('shell:show', wrap((p) => shell.showItemInFolder(p)));
ipcMain.handle('fs:exists', wrap((p) => fs.existsSync(p)));


// ---------- ElevenLabs 1-click connect ----------
const KEY_RE = /^sk_[A-Za-z0-9]{20,}$/;
let clipTimer = null;
function stopClipWatch() { if (clipTimer) { clearInterval(clipTimer); clipTimer = null; } }
function startClipWatch() {
  stopClipWatch();
  const read = async () => { try { return String((await clipboard.readText()) || '').trim(); } catch { return ''; } };
  let last = null; const until = Date.now() + 10 * 60 * 1000; let busy = false;
  read().then((t) => { last = t; });
  clipTimer = setInterval(async () => {
    if (Date.now() > until) return stopClipWatch();
    if (busy || last === null) return; busy = true;
    try {
      const t = await read();
      if (t !== last) { last = t; if (KEY_RE.test(t)) { stopClipWatch(); emit('elkey', { key: t }); } }
    } finally { busy = false; }
  }, 600);
}
async function checkElevenKey(key) {
  const base = (process.env.CW_STT_URL || 'https://api.elevenlabs.io/v1/speech-to-text').replace(/\/speech-to-text.*$/, '');
  try {
    const r = await fetch(base + '/user', { headers: { 'xi-api-key': key } });
    if (r.ok) return { ok: true };
    let d = null; try { d = (await r.json()).detail; } catch {}
    if (r.status === 401 && d && d.status === 'missing_permissions') return { ok: true, restricted: true }; // restricted key: valid, just cannot read /user
    return { ok: false, error: r.status === 401 ? 'ElevenLabs does not accept this key.' : 'ElevenLabs check failed (' + r.status + ').' };
  } catch { return { ok: false, error: 'Cannot reach ElevenLabs - check your internet connection.', offline: true }; }
}
ipcMain.handle('eleven:connect', wrap(() => { startClipWatch(); return shell.openExternal('https://elevenlabs.io/app/settings/api-keys'); }));
ipcMain.handle('eleven:stop', wrap(() => { stopClipWatch(); return true; }));
ipcMain.handle('eleven:check', wrap(checkElevenKey));
ipcMain.handle('open:url', wrap((u) => { if (/^https:\/\//.test(u)) return shell.openExternal(u); }));


// ---------- user sounds ----------
ipcMain.handle('sound:pick', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add sound', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac', 'wma', 'mp4', 'webm'] }] });
  if (r.canceled) return null;
  const src = r.filePaths[0];
  const info = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', src]);
  let j = {}; try { j = JSON.parse(info.out); } catch {}
  if (!(j.streams || []).some((x) => x.codec_type === 'audio')) throw new Error('That file has no audio.');
  const dir = path.join(userDir(), 'sounds'); fs.mkdirSync(dir, { recursive: true });
  const id = uid(), dest = path.join(dir, id + path.extname(src));
  fs.copyFileSync(src, dest); // keep our own copy so exports still work if the original moves
  return { id, path: dest, name: path.parse(src).name, dur: parseFloat((j.format && j.format.duration) || 0) };
}));

// ---------- storage / cleanup ----------
const dirSize = (d) => { let n = 0; try { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, f.name); n += f.isDirectory() ? dirSize(fp) : fs.statSync(fp).size; } } catch {} return n; };
const updaterDir = () => path.join(process.env.LOCALAPPDATA || '', 'clipwave-updater');
const inside = (child, parent) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
function libraryOrphans(keep) {
  const keepSet = new Set((keep || []).filter(Boolean).map((f) => path.resolve(f).toLowerCase()));
  const out = []; const d = libDir();
  for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (!f.isFile()) continue; const fp = path.join(d, f.name); if (!keepSet.has(path.resolve(fp).toLowerCase())) out.push(fp); }
  return out;
}
function unusedModels(model) { const d = path.join(userDir(), 'models'); const keepFile = (MODELS[model] || MODELS.base)[0]; try { return fs.readdirSync(d).filter((f) => f !== keepFile).map((f) => path.join(d, f)); } catch { return []; } }
const sizeOf = (list) => list.reduce((a, f) => { try { return a + fs.statSync(f).size; } catch { return a; } }, 0);
ipcMain.handle('storage:info', wrap(({ keep, model }) => {
  const orphans = libraryOrphans(keep), models = unusedModels(model);
  const cache = dirSize(path.join(userDir(), 'outro-cache')) + dirSize(updaterDir());
  return { orphans: sizeOf(orphans), models: sizeOf(models), cache, total: sizeOf(orphans) + sizeOf(models) + cache, library: dirSize(libDir()) };
}));
ipcMain.handle('storage:clean', wrap(({ keep, model }) => {
  let freed = 0; const rm = (f) => { try { freed += fs.statSync(f).size; fs.rmSync(f, { force: true }); } catch {} };
  libraryOrphans(keep).forEach(rm); unusedModels(model).forEach(rm);
  for (const d of [path.join(userDir(), 'outro-cache'), updaterDir()]) { freed += dirSize(d); try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  return freed;
}));
// delete files of a removed video, but ONLY inside the app's own library folder (never the user's originals)
ipcMain.handle('video:purge', wrap((files) => { let n = 0; for (const f of files || []) { if (f && inside(f, libDir())) { try { fs.rmSync(f, { force: true }); n++; } catch {} } } return n; }));


// ---------- auto update (GitHub Releases) ----------
const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;
let updaterReady = false, updateState = { state: 'idle' };
const sendUpd = (o) => { updateState = o; emit('update', o); };
function setupUpdater() {
  if (!app.isPackaged || isPortable) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => sendUpd({ state: 'checking' }));
    autoUpdater.on('update-available', (i) => sendUpd({ state: 'downloading', version: i.version, pct: 0 }));
    autoUpdater.on('download-progress', (p) => sendUpd({ state: 'downloading', version: updateState.version, pct: p.percent }));
    autoUpdater.on('update-downloaded', (i) => sendUpd({ state: 'ready', version: i.version }));
    autoUpdater.on('update-not-available', () => sendUpd({ state: 'uptodate' }));
    autoUpdater.on('error', (e) => sendUpd({ state: 'error', message: String((e && e.message) || e).slice(0, 160) }));
    updaterReady = true; global.__updater = autoUpdater;
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    setTimeout(check, 4000); setInterval(check, 4 * 3600 * 1000);
  } catch (e) { sendUpd({ state: 'error', message: e.message }); }
}
ipcMain.handle('update:check', wrap(() => {
  if (isPortable) return { state: 'portable' };
  if (!app.isPackaged) return { state: 'dev' };
  if (updaterReady) global.__updater.checkForUpdates().catch(() => {});
  return updateState;
}));
ipcMain.handle('update:install', wrap(() => { if (updaterReady && updateState.state === 'ready') { global.__updater.quitAndInstall(false, true); return true; } return false; }));
ipcMain.handle('update:state', wrap(() => ({ ...updateState, portable: isPortable, packaged: app.isPackaged })));

app.whenReady().then(() => { createWindow(); setupUpdater(); });
app.on('window-all-closed', () => { procs.forEach((p) => p.__cancel && p.__cancel()); app.quit(); });
