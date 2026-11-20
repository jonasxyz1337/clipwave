'use strict';
const { clone, clamp, FONTS, SUB_PRESETS, HEAD_PRESETS, DEFAULT_LAYOUT } = Shared;

// ================= helpers =================
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat(9).forEach((c) => c != null && c !== false && e.append(c.nodeType ? c : document.createTextNode(c)));
  return e;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fileUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
const fmt = (t, d = 1) => {
  t = Math.max(0, t || 0); const hh = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = s.toFixed(d).padStart(d ? d + 3 : 2, '0');
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
function parseTime(str) {
  str = String(str).trim().replace(',', '.'); if (!str) return NaN;
  const p = str.split(':').map(Number); if (p.some((x) => isNaN(x))) return NaN;
  return p.reduce((a, x) => a * 60 + x, 0);
}
const bytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB');
const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };

function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg); $('#toasts').append(t);
  setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = 0; setTimeout(() => t.remove(), 400); }, err ? 7000 : 3800);
}
function ask(title, value = '', ok = 'OK') {
  return new Promise((res) => {
    const m = $('#modal'); const inp = h('input', { value, spellcheck: 'false' });
    const close = (v) => { m.classList.add('hidden'); m.replaceChildren(); res(v); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') close(inp.value); if (e.key === 'Escape') close(null); });
    m.replaceChildren(h('div', { class: 'dlg' }, h('h3', {}, title), inp, h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn fill', onclick: () => close(inp.value) }, ok))));
    m.classList.remove('hidden'); inp.focus(); inp.select();
  });
}

// ================= state =================
const DEF = { lang: 'auto', outDir: '', quality: 'high', fps: 'source', encoder: 'x264', speed: 'veryfast', threads: 0, accent: 'Magenta', motion: true, palms: true, uiScale: 100, autoTranscribe: false, model: 'small', engine: 'auto', elKey: '', subPreset: 'Impact Pop', filename: '{title}_clip{n}', openWhenDone: false };
const S = { videos: [], clips: [], history: [], presets: { sub: {}, head: {} }, settings: { ...DEF }, selVideo: null, selClip: null, tab: 'home' };
const T = { audios: {}, fxSel: null, sndSel: null, row: 0, busy: {}, jobs: {}, importing: null, urlText: '', range: { start: 0, end: 10 }, view: null, exporting: false, env: {}, sel: {} };
const TABS = [['home', 'Home'], ['editor', 'Clip Editor'], ['subtitles', 'Subtitles'], ['layout', 'Layout'], ['headlines', 'Headlines'], ['effects', 'Effects'], ['sounds', 'Sounds'], ['export', 'Export'], ['settings', 'Settings']];
const LANGS = [['auto', 'Auto-detect'], ['en', 'English'], ['de', 'Deutsch'], ['es', 'Español'], ['fr', 'Français'], ['it', 'Italiano'], ['pt', 'Português'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['ru', 'Русский'], ['ja', '日本語']];
const ACCENTS = { Magenta: ['#b955bd', '#6b2c93', '#3c1458'], Violet: ['#8b62dc', '#47309a', '#22134f'], 'Ultra Blue': ['#6478e8', '#3238a0', '#16185a'], Rose: ['#e0559f', '#80256f', '#40103f'] };
const QUALITY = { draft: ['Draft', 24], standard: ['Standard', 20], high: ['High', 17], max: ['Maximum', 14] };

const curClip = () => S.clips.find((c) => c.id === S.selClip) || null;
const vidOf = (c) => S.videos.find((v) => v.id === (c ? c.videoId : S.selVideo)) || null;
let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => api.saveState({ videos: S.videos, clips: S.clips, history: S.history, presets: S.presets, settings: S.settings, selVideo: S.selVideo, selClip: S.selClip, tab: S.tab }).catch(() => {}), 400); }

// ================= video element + stage =================
const V = document.createElement('video'); V.preload = 'auto'; V.playsInline = true;
let stageDirty = true;
['seeked', 'loadeddata', 'timeupdate'].forEach((ev) => V.addEventListener(ev, () => (stageDirty = true)));
V.addEventListener('error', () => toast('This video cannot be played in the preview (unsupported codec).', true));
function loadVideo(v) {
  if (!v) return;
  if (V.dataset.id !== v.id) { V.dataset.id = v.id; V.src = fileUrl(v.path); }
}
function playToggle() { if (!V.src) return; if (V.paused) { const c = T.stageClip; if (c && (V.currentTime < c.start - 0.1 || V.currentTime >= c.end - 0.05)) V.currentTime = c.start; V.play(); } else V.pause(); }

const Stage = { cv: null, ctx: null, el: null, clipId: null };
function buildStage() {
  const ch = clamp(Math.floor(innerHeight - 340), 300, 620), cw = Math.round((ch * 9) / 16 / 2) * 2;
  if (Stage.cv && Stage.cv.height === ch) return;
  Stage.cv = h('canvas', { width: cw, height: ch }); Stage.ctx = Stage.cv.getContext('2d');
  Stage.msg = h('div', { class: 'msg hidden' });
  Stage.ovl = h('div', { class: 'ovl' });
  Stage.el = h('div', { class: 'stage' }, Stage.cv, Stage.msg, Stage.ovl);
  Stage.scrub = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, oninput: () => { const c = T.stageClip; if (c) { V.currentTime = c.start + Number(Stage.scrub.value); stageDirty = true; } } });
  Stage.time = h('span', { class: 'time' }, '0:00.0');
  Stage.play = h('button', { class: 'ibtn', title: 'Play / pause (Space)', onclick: playToggle }, '▶');
  Stage.bar = h('div', { class: 'stagebar', style: `width:${cw}px` }, Stage.play, Stage.scrub, Stage.time);
  stageDirty = true;
}

function drawText(ctx, txt, cx, cy, fill, o, k, scale = 1, shadowCol, shadow, outCol, outline) {
  ctx.save(); ctx.translate(cx, cy); ctx.scale(scale, scale); ctx.textAlign = 'center'; ctx.lineJoin = 'round';
  if (shadow > 0) { ctx.strokeStyle = ctx.fillStyle = shadowCol; ctx.lineWidth = outline * 2 * k; if (outline) ctx.strokeText(txt, shadow * k, shadow * k); ctx.fillText(txt, shadow * k, shadow * k); }
  if (outline > 0) { ctx.strokeStyle = outCol; ctx.lineWidth = outline * 2 * k; ctx.strokeText(txt, 0, 0); }
  ctx.fillStyle = fill; ctx.fillText(txt, 0, 0); ctx.restore();
}
const evCache = new WeakMap();
function drawSubs(ctx, k, clip, t) {
  const sub = clip.sub; if (!clip.words || !clip.words.length) return;
  const key = JSON.stringify([sub.mode, sub.maxWords, clip.words.length, clip.words[0].s]);
  let c = evCache.get(clip); if (!c || c.key !== key || c.words !== clip.words) { c = { key, words: clip.words, ev: Shared.subEvents(clip.words, sub) }; evCache.set(clip, c); }
  const ev = c.ev.find((e) => t >= e.s && t < e.e); if (!ev) return;
  const fs = sub.size * 0.86 * k; ctx.font = `${sub.bold ? 'bold ' : ''}${fs}px "${sub.font}", sans-serif`; ctx.textBaseline = 'middle';
  const items = ev.group.map((w, j) => ({ t: sub.uppercase ? w.w.toUpperCase() : w.w, imp: w.imp, act: j === ev.idx }));
  const sp = ctx.measureText(' ').width; items.forEach((i) => (i.w = ctx.measureText(i.t).width));
  const maxW = 1000 * k, lines = [[]]; let lw = 0;
  items.forEach((i) => { if (lw && lw + sp + i.w > maxW) { lines.push([]); lw = 0; } lines[lines.length - 1].push(i); lw += (lw ? sp : 0) + i.w; });
  const lh = fs * 1.22; let y = sub.y * 1920 * k - (lines.length * lh) / 2 + lh / 2;
  const age = (t - ev.s) * 1000;
  for (const ln of lines) {
    const total = ln.reduce((a, i) => a + i.w, 0) + sp * (ln.length - 1); let x = ctx.canvas.width / 2 - total / 2;
    for (const i of ln) {
      let col = i.imp ? sub.impColor : sub.color, sc = 1;
      if (sub.mode === 'word') { sc = age < 90 ? 0.7 + ((sub.scale / 100 - 0.7) * age) / 90 : age < 170 ? sub.scale / 100 - ((sub.scale / 100 - 1) * (age - 90)) / 80 : 1; }
      else if (i.act) { col = sub.hiColor; sc = sub.scale / 100; }
      drawText(ctx, i.t, x + i.w / 2, y, col, sub, k, sc, sub.shadowColor, sub.shadow, sub.outlineColor, sub.outline);
      x += i.w + sp;
    }
    y += lh;
  }
}
function drawHead(ctx, k, clip, t) {
  const hd = clip.head; if (!hd.text || !hd.text.trim()) return;
  const end = hd.duration > 0 ? hd.duration : Infinity; if (t > end) return;
  if (hd.card) {
    const g = Shared.cardGeom(hd); let a = 1; if (hd.anim !== 'none' && !V.paused) a = clamp(t / 0.2, 0, 1);
    ctx.save(); ctx.globalAlpha = a * 0.85; ctx.fillStyle = hd.boxColor; ctx.beginPath(); ctx.roundRect(g.x * k, g.y * k, g.w * k, g.h * k, g.r * k); ctx.fill();
    ctx.textBaseline = 'middle'; ctx.fillStyle = hd.color;
    g.lines.forEach((l, i) => { ctx.globalAlpha = a * (i ? 0.82 : 1); ctx.font = `${i ? '' : 'bold '}${l.sz * 0.86 * k}px "${hd.font}", sans-serif`; ctx.fillText(l.t, l.x * k, l.y * k); });
    ctx.restore(); return;
  }
  const lines = Shared.wrapHeadline(hd.text, hd.size, hd.font), fs = hd.size * 0.86 * k, lh = fs * 1.22;
  ctx.font = `${hd.box ? '' : 'bold '}${fs}px "${hd.font}", sans-serif`; ctx.textBaseline = 'middle';
  let a = 1; if (hd.anim !== 'none' && !V.paused) a = clamp(t / 0.25, 0, 1); if (hd.anim === 'fade' && hd.duration > 0) a = Math.min(a, clamp((hd.duration - t) / 0.35, 0, 1));
  ctx.save(); ctx.globalAlpha = a;
  let y = hd.y * 1920 * k - (lines.length * lh) / 2 + lh / 2;
  for (const l of lines) {
    if (hd.box) { const w = ctx.measureText(l).width, p = hd.outline * k; ctx.fillStyle = hd.outlineColor; ctx.fillRect(ctx.canvas.width / 2 - w / 2 - p, y - lh / 2 - p * 0.2, w + 2 * p, lh + p * 0.4); }
    drawText(ctx, l, ctx.canvas.width / 2, y, hd.color, hd, k, 1, '#000', hd.box ? 0 : hd.shadow, hd.outlineColor, hd.box ? 0 : hd.outline);
    y += lh;
  }
  ctx.restore();
}

const fxTmp = document.createElement('canvas');
function applyFxPreview(ctx, k, clip, t) {
  for (const f of clip.fx || []) {
    if (t < f.start || t >= f.end) continue;
    const r = Shared.fxRect(f), x = r.x * k, y = r.y * k, w = r.w * k, hh = r.h * k;
    if (f.type === 'pixelate') {
      const a = Math.max(2, f.amount || 28) * k, tw = Math.max(1, Math.ceil(w / a)), th = Math.max(1, Math.ceil(hh / a));
      fxTmp.width = tw; fxTmp.height = th; fxTmp.getContext('2d').drawImage(ctx.canvas, x, y, w, hh, 0, 0, tw, th);
      ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(fxTmp, 0, 0, tw, th, x, y, w, hh); ctx.restore();
    } else {
      fxTmp.width = Math.ceil(w); fxTmp.height = Math.ceil(hh); fxTmp.getContext('2d').drawImage(ctx.canvas, x, y, w, hh, 0, 0, fxTmp.width, fxTmp.height);
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, hh); ctx.clip();
      ctx.filter = f.type === 'blur' ? `blur(${(f.amount || 24) * 0.5 * k}px)` : 'grayscale(1)'; ctx.drawImage(fxTmp, x, y, w, hh); ctx.restore();
    }
  }
}
function syncSounds(c) {
  const playing = !V.paused, rel = V.currentTime - c.start;
  for (const sn of c.sounds || []) {
    let a = T.audios[sn.id]; if (!a) { a = new Audio(fileUrl(sn.path)); T.audios[sn.id] = a; }
    const tin = sn.trimIn || 0, tout = sn.trimOut > tin ? sn.trimOut : sn.dur, pos = rel - sn.at + tin;
    a.volume = clamp(sn.vol == null ? 1 : sn.vol, 0, 1);
    if (playing && rel >= sn.at && pos < tout) { if (a.paused || Math.abs(a.currentTime - pos) > 0.25) { try { a.currentTime = pos; } catch {} a.play().catch(() => {}); } }
    else if (!a.paused) a.pause();
  }
  V.volume = clamp(c.origVol == null ? 1 : c.origVol, 0, 1);
}
function stopSounds() { for (const a of Object.values(T.audios)) if (!a.paused) a.pause(); if (V.volume !== 1) V.volume = 1; }
function drawComposite(ctx, clip, v, t) {
  const cw = ctx.canvas.width, k = cw / 1080;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ctx.canvas.height);
  if (V.readyState >= 2) {
    const { boxes } = Shared.computeLayout(clip.layout, V.videoWidth || v.w, V.videoHeight || v.h);
    ctx.filter = clip.layout.filter === 'bw' ? 'grayscale(1)' : clip.layout.filter === 'bwc' ? 'grayscale(1) contrast(1.3) brightness(.97)' : 'none';
    for (const b of boxes) ctx.drawImage(V, b.crop.x, b.crop.y, b.crop.w, b.crop.h, b.dx * k, b.dy * k, b.dw * k, b.dh * k);
    ctx.filter = 'none';
    applyFxPreview(ctx, k, clip, t);
  }
  if (clip.subsOn) drawSubs(ctx, k, clip, t);
  if (clip.headOn) drawHead(ctx, k, clip, t);
}
function frame() {
  const c = T.stageClip;
  if (Stage.cv && c && Stage.el.isConnected) {
    const v = vidOf(c);
    if (!V.paused && V.currentTime >= c.end - 0.03) { V.currentTime = c.start; }
    if (!V.paused || stageDirty) {
      drawComposite(Stage.ctx, c, v, V.currentTime - c.start); stageDirty = false;
      const rel = clamp(V.currentTime - c.start, 0, c.end - c.start);
      Stage.scrub.max = c.end - c.start; if (document.activeElement !== Stage.scrub) Stage.scrub.value = rel;
      Stage.time.textContent = `${fmt(rel)} / ${fmt(c.end - c.start)}`; Stage.play.textContent = V.paused ? '▶' : '❚❚';
    }
  }
  if (c && Stage.el && Stage.el.isConnected) syncSounds(c); else stopSounds();
  if (T.tickHook) T.tickHook();
  requestAnimationFrame(frame);
}

// ================= row model =================
const sec = (label) => ({ type: 'sec', label });
const opt = (o) => (Array.isArray(o) ? o : [o, String(o)]);
function enumRow(label, get, set, opts, extra = {}) { return { type: 'enum', label, get, set, opts: opts.map(opt), ...extra }; }
function rangeRow(label, get, set, min, max, step, f, extra = {}) { return { type: 'range', label, get, set, min, max, step, f: f || ((v) => String(+v.toFixed(2))), ...extra }; }
function toggleRow(label, get, set, extra = {}) { return { type: 'toggle', label, get, set, ...extra }; }
function colorRow(label, get, set, extra = {}) { return { type: 'color', label, get, set, ...extra }; }
function actionRow(label, fn, extra = {}) { return { type: 'action', label, fn, ...extra }; }
const FONT_OPTS = Object.keys(FONTS);

let items = [];
function focusable() { return items.map((it, i) => [it, i]).filter(([it]) => it.type !== 'sec' && it.type !== 'custom' && !it.disabled); }

function valueNode(it) {
  const v = it.get ? it.get() : null;
  if (it.type === 'enum') { const i = Math.max(0, it.opts.findIndex((o) => o[0] === v)); return h('div', { class: 'val' }, h('span', { class: 't' }, it.opts[i]?.[1] ?? String(v)), it.opts.length > 2 || true ? h('span', { class: 'n' }, `${i + 1} / ${it.opts.length}`) : null, h('span', { class: 'arr', onclick: (e) => { e.stopPropagation(); nudge(it, -1); } }, '‹'), h('span', { class: 'arr', onclick: (e) => { e.stopPropagation(); nudge(it, 1); } }, '›')); }
  if (it.type === 'range') return h('div', { class: 'val' }, h('span', { class: 't' }, it.f(v)), h('span', { class: 'arr', onclick: (e) => { e.stopPropagation(); nudge(it, -1); } }, '‹'), h('span', { class: 'arr', onclick: (e) => { e.stopPropagation(); nudge(it, 1); } }, '›'));
  if (it.type === 'toggle') return h('div', { class: 'val' }, h('span', { class: 'tog' + (v ? ' on' : '') }));
  if (it.type === 'color') return h('div', { class: 'val' }, h('span', { class: 't' }, String(v).toUpperCase()), h('span', { class: 'sw', style: `background:${v}` }));
  if (it.type === 'action') return it.value ? h('div', { class: 'val' }, h('span', { class: 't' }, typeof it.value === 'function' ? it.value() : it.value)) : h('div', { class: 'val' });
  return h('div', { class: 'val' });
}
function buildRow(it, i) {
  if (it.type === 'sec') return h('div', { class: 'sec' }, it.label);
  if (it.type === 'custom') return it.node;
  const row = h('div', { class: 'row ' + it.type + (it.big ? ' big' : '') + (i === T.row ? ' sel' : ''), 'data-i': i, onclick: () => { selectRow(i); if (['action', 'toggle', 'color', 'video', 'clip', 'hist', 'text'].includes(it.type)) activate(it); } });
  if (it.type === 'text') {
    const inp = h('input', { class: 'inl', type: it.secret ? 'password' : 'text', value: it.get(), placeholder: it.placeholder || '', spellcheck: 'false', oninput: () => it.set(inp.value), onkeydown: (e) => { if (e.key === 'Enter') { it.submit?.(); inp.blur(); } if (e.key === 'Escape') inp.blur(); e.stopPropagation(); }, onfocus: () => selectRow(i, true) });
    row.append(h('span', { class: 'lbl' }, it.label), inp); return row;
  }
  if (it.type === 'video' || it.type === 'clip' || it.type === 'hist') {
    row.append(...[it.thumb ? h('div', { class: 'thumb', style: `background-image:url('${fileUrl(it.thumb)}')` }) : ''].filter(Boolean), h('span', { class: 'lbl' }, it.label), h('div', { class: 'val' }, h('span', { class: 't n' }, it.value || ''), it.mini ? h('div', { class: 'mini' }, it.mini.map(([ic, tip, fn]) => h('button', { title: tip, onclick: (e) => { e.stopPropagation(); fn(); } }, ic))) : null));
    return row;
  }
  row.append(h('span', { class: 'lbl' }, it.label), valueNode(it));
  if (it.type === 'range') { const f = h('i', { class: 'fill' }); f.style.width = (((it.get() - it.min) / (it.max - it.min)) * 100).toFixed(1) + '%'; row.append(f); attachDrag(row, it); }
  if (it.type === 'color') { const ci = h('input', { type: 'color', value: it.get(), oninput: () => { it.set(ci.value); refreshRow(i, true); } }); row.append(ci); it._ci = ci; }
  if (it.progress) row.append(it.progress);
  return row;
}
function attachDrag(row, it) {
  row.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('arr')) return;
    const r = row.getBoundingClientRect(); let moved = false;
    const set = (ev) => { const p = clamp((ev.clientX - r.left) / r.width, 0, 1); let v = it.min + p * (it.max - it.min); v = Math.round(v / it.step) * it.step; it.set(clamp(+v.toFixed(4), it.min, it.max)); refreshRow(+row.dataset.i, true); };
    const move = (ev) => { moved = true; set(ev); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up); row.setPointerCapture?.(e.pointerId);
    setTimeout(() => { if (!moved) { /* click without drag: plain select */ } }, 0);
  });
}
function refreshRow(i, soft) {
  const it = items[i]; const old = $(`#list [data-i="${i}"]`); if (!it || !old) return;
  const nu = buildRow(it, i); nu.style.animation = 'none'; old.replaceWith(nu);
  stageDirty = true; save();
  if (it.rebuild && !soft) softRender();
  else if (it.rebuild) { clearTimeout(T.rb); T.rb = setTimeout(() => softRender(), 250); }
  if (it.onchange) it.onchange();
}
function nudge(it, dir) {
  const i = items.indexOf(it);
  if (it.type === 'enum') { const idx = it.opts.findIndex((o) => o[0] === it.get()); it.set(it.opts[(idx + dir + it.opts.length) % it.opts.length][0]); }
  else if (it.type === 'range') { it.set(clamp(+(it.get() + dir * it.step).toFixed(4), it.min, it.max)); }
  else if (it.type === 'toggle') it.set(!it.get());
  else return;
  refreshRow(i);
}
function activate(it) {
  if (it.type === 'action' || it.type === 'video' || it.type === 'clip' || it.type === 'hist') it.fn?.();
  else if (it.type === 'toggle') nudge(it, 1);
  else if (it.type === 'color') it._ci?.click();
  else if (it.type === 'text') $(`#list [data-i="${items.indexOf(it)}"] input`)?.focus();
}
function selectRow(i, noScroll) {
  if (i === T.row && $('#list .row.sel')) return;
  T.row = i; document.querySelectorAll('#list .row').forEach((r) => r.classList.toggle('sel', +r.dataset.i === i));
  const el = $(`#list [data-i="${i}"]`); if (el && !noScroll) el.scrollIntoView({ block: 'nearest' });
  renderRight(); updateCounter();
}
function updateCounter() { const f = focusable(); const n = f.findIndex(([, i]) => i === T.row); $('#counter').textContent = f.length ? `${n + 1} / ${f.length}` : ''; }

// ================= pages =================
function needClipItems(msg) {
  return [sec('No clip selected'), actionRow('Open the Clip Editor', () => go('editor'), { desc: msg || 'Import a video and mark a clip first – this tab styles the selected clip.' })];
}
function leaveNote(t) { return `<b>${t}</b>`; }
const SUB_DESCS = {
  'Generate subtitles': 'Runs Whisper locally on this clip\'s audio and creates word-accurate timings. Nothing leaves your computer.',
  Language: 'Spoken language of the clip. Auto-detect works well, but choosing it explicitly is faster and more accurate.',
  Mode: '<b>Highlight</b> shows a short line and lights up the spoken word. <b>Single word</b> pops one word at a time. <b>Static</b> shows the whole line.',
};

const pages = {};

// ---------- HOME ----------
pages.home = () => {
  const L = [sec('Import')];
  L.push({ type: 'text', label: 'YouTube / Twitch link', placeholder: 'Paste a YouTube or Twitch link…', get: () => T.urlText, set: (v) => (T.urlText = v), submit: () => importUrl(), desc: 'Paste a <b>YouTube</b> link (videos, Shorts, streams) or a <b>Twitch</b> link (clips, VODs, highlights) and press <b>Enter</b>. Downloaded in up to 1080p so you can clip it offline.' });
  L.push({ type: 'text', label: 'Part to download (optional)', placeholder: 'e.g. 1:02:00-1:30:00', get: () => T.rangeText || '', set: (v) => (T.rangeText = v), submit: () => importUrl(), desc: 'For long <b>Twitch VODs</b> or streams: download only the part you need (start-end, like <b>1:02:00-1:30:00</b>). Leave empty to download everything – hours-long VODs can be several GB.' });
  const prog = T.importing ? h('div', { class: 'pbar' + (T.importing.pct > 0 ? '' : ' ind') }, h('i', { style: `width:${T.importing.pct || 0}%` })) : null;
  L.push(actionRow(T.importing ? T.importing.msg || 'Importing…' : 'Import from link', importUrl, { value: T.importing ? `${Math.round(T.importing.pct || 0)}%` : '', progress: prog, desc: 'Downloads the video from the link above using yt-dlp.' }));
  L.push(actionRow('Open a video file…', importFile, { desc: 'Already have the footage? Pick a local file (MP4, MKV, MOV, WebM) – or simply drag it onto this window.' }));
  L.push(sec('Recent videos'));
  if (!S.videos.length) L.push({ type: 'custom', node: h('div', { class: 'empty' }, 'No videos yet – paste a link above.') });
  S.videos.slice(0, 6).forEach((v) => L.push({ type: 'video', big: true, label: v.title, thumb: v.thumb, value: `${fmt(v.duration, 0)} · ${S.clips.filter((c) => c.videoId === v.id).length} clips`, video: v, fn: () => { S.selVideo = v.id; S.selClip = S.clips.find((c) => c.videoId === v.id)?.id || null; go('editor'); }, mini: [['✕', 'Remove from library', () => removeVideo(v)]] }));
  L.push(sec('Recent projects'));
  const rc = S.clips.slice(0, 5);
  if (!rc.length) L.push({ type: 'custom', node: h('div', { class: 'empty' }, 'Clips you create appear here.') });
  rc.forEach((c) => { const v = vidOf(c); L.push({ type: 'clip', label: c.name, thumb: v?.thumb, value: `${v ? v.title.slice(0, 24) : '?'} · ${fmt(c.start, 0)}–${fmt(c.end, 0)}`, clipRef: c, fn: () => { S.selClip = c.id; S.selVideo = c.videoId; go('editor'); } }); });
  L.push(sec('Quick access'));
  L.push(actionRow('Continue clipping', () => go('editor'), { value: S.videos[0] ? S.videos[0].title.slice(0, 28) : '', desc: 'Jump straight back into the Clip Editor.' }));
  L.push(actionRow('Open export folder', async () => { const d = outDir(); await api.open(d).catch(() => {}); }, { desc: 'Opens the folder where finished clips are saved.' }));
  return L;
};
function rightHome(it) {
  if (it && it.type === 'video') { const v = it.video; return h('div', {}, h('div', { class: 'ptitle' }, v.title), h('div', { class: 'preview-img', style: v.thumb ? `background-image:url('${fileUrl(v.thumb)}')` : '' }), h('div', { class: 'facts' }, h('span', {}, 'Length'), h('b', {}, fmt(v.duration, 0)), h('span', {}, 'Resolution'), h('b', {}, `${v.w} × ${v.h}`), h('span', {}, 'Frame rate'), h('b', {}, `${Math.round(v.fps)} fps`), h('span', {}, 'Source'), h('b', {}, v.url ? 'YouTube' : 'Local file')), h('div', { class: 'btnrow' }, h('button', { class: 'btn fill', onclick: it.fn }, 'Open in clip editor'))); }
  if (it && it.type === 'clip') { const c = it.clipRef, v = vidOf(c); return h('div', {}, h('div', { class: 'ptitle' }, c.name), h('div', { class: 'preview-img', style: v?.thumb ? `background-image:url('${fileUrl(v.thumb)}')` : '' }), h('div', { class: 'facts' }, h('span', {}, 'Range'), h('b', {}, `${fmt(c.start)} → ${fmt(c.end)}`), h('span', {}, 'Duration'), h('b', {}, fmt(c.end - c.start)), h('span', {}, 'Subtitles'), h('b', {}, c.words ? `${c.words.length} words` : 'not generated')), h('div', { class: 'btnrow' }, h('button', { class: 'btn fill', onclick: it.fn }, 'Open clip'))); }
  return h('div', { class: 'hero' }, h('div', { class: 'logo' }, 'CLIPWAVE'), h('div', { class: 'tag' }, 'Turn YouTube and Twitch videos, clips and VODs into polished vertical clips for TikTok, Shorts and Reels.'), h('div', { class: 'steps' }, ['Paste a YouTube or Twitch link', 'Mark the moments you want', 'Set gameplay + facecam layout', 'Generate animated subtitles', 'Add a headline and export in 1080×1920'].map((s) => h('div', {}, s))));
}

// ---------- EDITOR ----------
function pageEditor() {
  const v = vidOf(null); const L = [];
  if (!v) return [sec('Clip editor'), actionRow('Import a video first', () => go('home'), { desc: 'The editor needs a source video. Paste a YouTube or Twitch link on the Home tab.' })];
  loadVideo(v);
  if (!T.view || T.view.id !== v.id) { T.view = { id: v.id, a: 0, b: v.duration }; const c = curClip(); T.range = c && c.videoId === v.id ? { start: c.start, end: c.end } : { start: 0, end: Math.min(v.duration, 30) }; }
  L.push({ type: 'custom', node: buildPlayer(v) });
  L.push(sec(`Clips from this video (${S.clips.filter((c) => c.videoId === v.id).length})`));
  const cl = S.clips.filter((c) => c.videoId === v.id);
  if (!cl.length) L.push({ type: 'custom', node: h('div', { class: 'empty' }, 'Set In/Out above, then press “Add clip”. Repeat for as many moments as you like.') });
  cl.forEach((c, n) => L.push({ type: 'clip', label: c.name, value: `${fmt(c.start)} → ${fmt(c.end)} · ${fmt(c.end - c.start, 0)}s${c.words ? ' · ✓ subs' : ''}`, clipRef: c, sel: c.id === S.selClip, fn: () => selectClip(c), mini: [['▶', 'Preview clip', () => { selectClip(c); V.currentTime = c.start; V.play(); }], ['✎', 'Rename', async () => { const n2 = await ask('Rename clip', c.name); if (n2 && n2.trim()) { c.name = n2.trim(); save(); render(true); } }], ['✕', 'Delete clip', () => deleteClip(c)]] }));
  L.push(actionRow('Add clip from selection', addClip, { value: `${fmt(T.range.start)} → ${fmt(T.range.end)}`, desc: 'Creates a new clip from the current In/Out range. Layout, subtitle and headline style are copied from the selected clip.' }));
  const c = curClip();
  if (c && c.videoId === v.id) L.push(actionRow('Update selected clip range', () => { if (!validRange()) return; c.start = T.range.start; c.end = T.range.end; c.words = null; toast('Range updated. Subtitles must be regenerated for the new range.'); save(); render(true); }, { desc: 'Applies the current In/Out range to the selected clip. Existing subtitles are cleared because their timings no longer match.' }));
  return L;
}
function validRange() { const { start, end } = T.range; const v = vidOf(null); if (!(end - start >= 1)) { toast('The clip must be at least 1 second long (Out must be after In).', true); return false; } if (v && end > v.duration + 0.05) { toast('Out point is beyond the end of the video.', true); return false; } return true; }
function addClip() {
  if (!validRange()) return; const v = vidOf(null); const base = curClip();
  const sub = clone(base ? base.sub : SUB_PRESETS[S.settings.subPreset] ? { ...SUB_PRESETS[S.settings.subPreset], preset: S.settings.subPreset } : { ...SUB_PRESETS['Impact Pop'], preset: 'Impact Pop' });
  const head = clone(base ? { ...base.head, text: '' } : { ...HEAD_PRESETS['Bold Statement'], text: '' });
  const n = S.clips.filter((c) => c.videoId === v.id).length + 1;
  const c = { id: uid(), videoId: v.id, name: `Clip ${n}`, start: T.range.start, end: T.range.end, words: null, subsOn: true, headOn: true, layout: clone(base ? base.layout : DEFAULT_LAYOUT), sub, head, outro: clone(base && base.outro ? base.outro : Shared.DEFAULT_OUTRO), fx: [], sounds: [], origVol: 1 };
  S.clips.unshift(c); S.selClip = c.id; save(); toast(`${c.name} added (${fmt(c.end - c.start)}s).`);
  if (S.settings.autoTranscribe) transcribeClip(c);
  render(true);
}
function selectClip(c) { S.selClip = c.id; T.range = { start: c.start, end: c.end }; V.currentTime = c.start; save(); render(true); }
function deleteClip(c) { S.clips = S.clips.filter((x) => x.id !== c.id); if (S.selClip === c.id) S.selClip = null; save(); render(true); }
function removeVideo(v) { api.purgeVideo([v.path, v.thumb]).catch(() => {}); S.videos = S.videos.filter((x) => x.id !== v.id); S.clips = S.clips.filter((c) => c.videoId !== v.id); if (S.selVideo === v.id) { S.selVideo = null; S.selClip = null; } save(); render(true); toast('Video removed. Downloaded files were deleted; your own files are never touched.'); }

function buildPlayer(v) {
  const view = T.view;
  const screen = h('div', { class: 'screen' }, h('div', { class: 'ph' }, 'Loading video…'));
  const was = !V.paused; screen.replaceChildren(V); if (was) V.play().catch(() => {});
  V.controls = false; V.onclick = playToggle; V.style.cursor = 'pointer';
  const tl = h('div', { class: 'tl' }), track = h('div', { class: 'track' }), rangeEl = h('div', { class: 'range' }), hs = h('div', { class: 'hnd', title: 'In point' }), he = h('div', { class: 'hnd', title: 'Out point' }), head = h('div', { class: 'head' });
  tl.append(track, rangeEl, hs, he, head);
  const pos = (t) => ((t - view.a) / (view.b - view.a)) * 100;
  const timeAt = (ev) => { const r = tl.getBoundingClientRect(); return view.a + clamp((ev.clientX - r.left) / r.width, 0, 1) * (view.b - view.a); };
  const timeLbl = h('span', { class: 'time' }, '0:00.0');
  const inI = h('input', { value: fmt(T.range.start), title: 'In (mm:ss.s)', onkeydown: (e) => e.key === 'Enter' && applyFields(), onblur: () => applyFields() });
  const outI = h('input', { value: fmt(T.range.end), title: 'Out (mm:ss.s)', onkeydown: (e) => e.key === 'Enter' && applyFields(), onblur: () => applyFields() });
  const durL = h('span', { class: 'time', style: 'min-width:70px' });
  function applyFields() {
    const a = parseTime(inI.value), b = parseTime(outI.value);
    inI.classList.toggle('bad', isNaN(a)); outI.classList.toggle('bad', isNaN(b));
    if (!isNaN(a)) T.range.start = clamp(a, 0, v.duration); if (!isNaN(b)) T.range.end = clamp(b, 0, v.duration);
    syncTl(true);
  }
  function setIn(t) { T.range.start = clamp(t, 0, v.duration); if (T.range.end <= T.range.start + 0.5) T.range.end = Math.min(v.duration, T.range.start + 15); syncTl(true); }
  function setOut(t) { T.range.end = clamp(t, 0, v.duration); if (T.range.end <= T.range.start + 0.5) T.range.start = Math.max(0, T.range.end - 15); syncTl(true); }
  T.setIn = () => setIn(V.currentTime); T.setOut = () => setOut(V.currentTime);
  function syncTl(fields) {
    const sp = view.b - view.a;
    rangeEl.style.left = pos(T.range.start) + '%'; rangeEl.style.width = Math.max(0, pos(T.range.end) - pos(T.range.start)) + '%';
    hs.style.left = pos(T.range.start) + '%'; he.style.left = pos(T.range.end) + '%'; head.style.left = pos(V.currentTime) + '%';
    head.style.display = V.currentTime >= view.a && V.currentTime <= view.b ? '' : 'none';
    if (fields) { if (document.activeElement !== inI) inI.value = fmt(T.range.start); if (document.activeElement !== outI) outI.value = fmt(T.range.end); durL.textContent = `= ${fmt(T.range.end - T.range.start)}s`; const ad = $('#list .row .val .t'); updateAddValue(); }
    timeLbl.textContent = `${fmt(V.currentTime)} / ${fmt(v.duration, 0)}`;
  }
  function buildTrack() {
    track.replaceChildren(); tl.querySelectorAll('.tick').forEach((x) => x.remove());
    S.clips.filter((c) => c.videoId === v.id).forEach((c) => track.append(h('div', { class: 'seg', style: `left:${pos(c.start)}%;width:${pos(c.end) - pos(c.start)}%;${c.id === S.selClip ? 'background:rgba(255,255,255,.6)' : ''}` })));
    const sp = view.b - view.a, steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]; const st = steps.find((s) => sp / s <= 8) || 3600;
    for (let t = Math.ceil(view.a / st) * st; t < view.b; t += st) tl.append(h('div', { class: 'tick', style: `left:${pos(t)}%` }, fmt(t, 0)));
  }
  function drag(el, fn) { el.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); el.setPointerCapture(e.pointerId); fn(e); const mv = (ev) => fn(ev); const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); }; el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); }); }
  drag(hs, (e) => setIn(timeAt(e))); drag(he, (e) => setOut(timeAt(e)));
  drag(tl, (e) => { V.currentTime = timeAt(e); stageDirty = true; });
  tl.addEventListener('wheel', (e) => { e.preventDefault(); const t = timeAt(e), f = e.deltaY > 0 ? 1.25 : 0.8; let a = t - (t - view.a) * f, b = t + (view.b - t) * f; const sp = clamp(b - a, 3, v.duration); a = clamp(a, 0, v.duration - sp); view.a = a; view.b = a + sp; buildTrack(); syncTl(); }, { passive: false });
  const playB = h('button', { class: 'ibtn', title: 'Play / pause (Space)', onclick: playToggle }, '▶');
  const tools = h('div', { class: 'tools' }, playB, timeLbl,
    h('button', { class: 'btn sm', onclick: T.setIn, title: 'Set In at playhead (I)' }, 'Set In  [I]'), h('button', { class: 'btn sm', onclick: T.setOut, title: 'Set Out at playhead (O)' }, 'Set Out  [O]'),
    h('button', { class: 'btn sm', onclick: () => { if (validRange()) { V.currentTime = T.range.start; V.play(); T.rangePlay = T.range.end; } } }, '▶ Range'),
    h('button', { class: 'ibtn', title: 'Reset zoom', onclick: () => { view.a = 0; view.b = v.duration; buildTrack(); syncTl(); } }, '⤢'));
  const fields = h('div', { class: 'fields' }, h('label', {}, 'In'), inI, h('label', {}, 'Out'), outI, durL);
  const updateAddValue = () => { const r = items.findIndex((x) => x.label === 'Add clip from selection'); if (r >= 0) { items[r].value = `${fmt(T.range.start)} → ${fmt(T.range.end)}`; const el = $(`#list [data-i="${r}"] .val .t`); if (el) el.textContent = items[r].value; } };
  buildTrack(); syncTl(true);
  T.tickHook = () => { syncTl(); playB.textContent = V.paused ? '▶' : '❚❚'; if (T.rangePlay && V.currentTime >= T.rangePlay) { V.pause(); T.rangePlay = null; } };
  return h('div', { class: 'player' }, screen, tools, tl, fields);
}
function rightEditor() {
  const c = curClip();
  const p = h('div', {}, h('div', { class: 'ptitle' }, c ? c.name : 'Clip preview'));
  if (!c) { p.append(h('div', { class: 'pdesc', html: 'Select or add a clip to see the finished <b>9:16</b> composition here – gameplay, facecam, subtitles and headline update live.' })); return p; }
  mountStage(c); p.append(h('div', { class: 'stage-wrap' }, h('div', {}, Stage.el, Stage.bar)), h('div', { class: 'pdesc', html: `<b>${fmt(c.end - c.start)}s</b> · ${c.words ? c.words.length + ' words transcribed' : 'no subtitles yet'}. Tip: <b>I</b> / <b>O</b> set In/Out at the playhead, <b>Space</b> plays.` }));
  return p;
}
function mountStage(c) { buildStage(); loadVideo(vidOf(c)); T.stageClip = c; stageDirty = true; renderFxOverlay(c); if (V.currentTime < c.start - 0.1 || V.currentTime > c.end + 0.1) { try { V.currentTime = c.start; } catch {} } }

// ---------- SUBTITLES ----------
function pageSubs() {
  const c = curClip(); if (!c) return needClipItems('Create a clip first, then generate and style its subtitles here.');
  const s = () => curClip().sub; const L = [];
  const presets = { ...SUB_PRESETS, ...S.presets.sub };
  const busy = T.busy[c.id];
  L.push(sec('Transcription'));
  L.push(actionRow(busy ? 'Transcribing…' : c.words ? 'Re-generate subtitles' : 'Generate subtitles (Whisper)', () => transcribeClip(c), { value: busy ? `${Math.round(busy.pct)}%` : c.words ? `${c.words.length} words` : 'not generated', progress: busy ? h('div', { class: 'pbar' }, h('i', { style: `width:${busy.pct}%` })) : null, desc: SUB_DESCS['Generate subtitles'] }));
  if (S.settings.engine !== 'whisper' && !(S.settings.elKey || '').trim()) L.push(actionRow('Connect ElevenLabs for accurate subtitles (1 click)', connectEleven, { desc: 'Without a key the offline Whisper model is used, which is less accurate. Add an ElevenLabs API key in Settings for much better words and timing.' }));
  L.push(enumRow('Language', () => S.settings.lang, (v) => (S.settings.lang = v), LANGS, { desc: SUB_DESCS.Language }));
  L.push(toggleRow('Show subtitles', () => c.subsOn, (v) => (c.subsOn = v), { desc: 'Burn the subtitles into the exported video.' }));
  L.push(sec('Style'));
  L.push(enumRow('Preset', () => s().preset || 'Custom', (v) => { const p = presets[v]; c.sub = { ...clone(p), preset: v }; }, Object.keys(presets), { rebuild: true, desc: 'Start from a ready-made look. Everything below can still be tweaked.' }));
  L.push(enumRow('Animation', () => s().mode, (v) => (s().mode = v), [['highlight', 'Word highlight'], ['word', 'Single word'], ['static', 'Static line']], { rebuild: true, desc: SUB_DESCS.Mode }));
  if (s().mode !== 'word') L.push(rangeRow('Words per line', () => s().maxWords, (v) => (s().maxWords = v), 1, 7, 1, (v) => String(v), { desc: 'Maximum number of words shown at once.' }));
  L.push(enumRow('Font', () => s().font, (v) => (s().font = v), FONT_OPTS, { desc: 'Fonts are installed system fonts, so preview and export match exactly.' }));
  L.push(rangeRow('Size', () => s().size, (v) => (s().size = v), 40, 180, 2, (v) => v + ' px', { desc: 'Text size on the 1080 × 1920 canvas.' }));
  L.push(toggleRow('Bold', () => s().bold, (v) => (s().bold = v)));
  L.push(toggleRow('Uppercase', () => s().uppercase, (v) => (s().uppercase = v)));
  L.push(colorRow('Text color', () => s().color, (v) => (s().color = v)));
  L.push(colorRow('Active word color', () => s().hiColor, (v) => (s().hiColor = v), { desc: 'The word currently being spoken.' }));
  L.push(colorRow('Important word color', () => s().impColor, (v) => (s().impColor = v), { desc: 'Color for words marked as important (click words in the list below).' }));
  L.push(colorRow('Outline color', () => s().outlineColor, (v) => (s().outlineColor = v)));
  L.push(rangeRow('Outline', () => s().outline, (v) => (s().outline = v), 0, 16, 1, (v) => v + ' px'));
  L.push(rangeRow('Shadow', () => s().shadow, (v) => (s().shadow = v), 0, 14, 1, (v) => v + ' px'));
  L.push(colorRow('Shadow color', () => s().shadowColor, (v) => (s().shadowColor = v)));
  L.push(rangeRow('Pop scale', () => s().scale, (v) => (s().scale = v), 100, 140, 2, (v) => v + ' %', { desc: 'How much the active word grows.' }));
  L.push(rangeRow('Vertical position', () => s().y, (v) => (s().y = v), 0.1, 0.92, 0.01, (v) => Math.round(v * 100) + ' %', { desc: 'Distance from the top of the video. Keep captions clear of platform UI (≈ 60–75 %).' }));
  L.push(rangeRow('Timing offset', () => (s().offset == null ? -0.15 : s().offset), (v) => (s().offset = v), -0.6, 0.6, 0.05, (v) => (v > 0 ? '+' : '') + v.toFixed(2) + ' s', { desc: 'Shifts all subtitles in time. <b>Negative</b> = captions appear earlier. If they feel late, go further left; if they pop up too early, go right.' }));
  L.push(sec('Words'));
  L.push({ type: 'custom', node: wordChips(c) });
  L.push(actionRow('Auto-detect important words', () => { if (!c.words) return toast('Generate subtitles first.', true); c.words = Shared.autoImportant(c.words); save(); render(true); }, { desc: 'Marks long words, numbers and SHOUTED words as important.' }));
  L.push(actionRow('Clear highlights', () => { if (c.words) { c.words.forEach((w) => (w.imp = false)); save(); render(true); } }));
  L.push(actionRow('Save style as preset…', async () => { const n = await ask('Preset name'); if (n && n.trim()) { S.presets.sub[n.trim()] = clone({ ...c.sub, preset: undefined }); c.sub.preset = n.trim(); save(); render(true); toast('Preset saved.'); } }));
  L.push(actionRow('Apply style to all clips', () => { S.clips.forEach((x) => { x.sub = clone(c.sub); }); save(); toast(`Subtitle style applied to ${S.clips.length} clips.`); }));
  return L;
}
function wordChips(c) {
  if (!c.words) return h('div', { class: 'empty' }, 'No transcript yet. Generate subtitles to see every word here.');
  const wrap = h('div', { class: 'chips' });
  c.words.forEach((w, i) => wrap.append(h('span', { class: 'chip' + (w.imp ? ' imp' : ''), title: 'Click: toggle highlight · Double-click: edit', onclick: () => { w.imp = !w.imp; wrap.children[i].classList.toggle('imp', w.imp); stageDirty = true; save(); }, ondblclick: async () => { const t = await ask('Edit word (empty = delete)', w.w); if (t == null) return; if (!t.trim()) c.words.splice(i, 1); else w.w = t.trim(); save(); render(true); } }, w.w)));
  return wrap;
}
async function transcribeClip(c) {
  if (T.busy[c.id]) return; const v = vidOf(c);
  if (!T.env.whisper) return toast('Whisper is not available in this installation.', true);
  const st = S.settings, key = (st.elKey || '').trim();
  if (st.engine === 'elevenlabs' && !key) { connectEleven(); return; }
  const useEl = st.engine !== 'whisper' && !!key;
  T.busy[c.id] = { pct: 1 }; if (S.tab === 'subtitles') render(true);
  try {
    c.words = await api.transcribe({ clipId: c.id, videoPath: v.path, start: c.start, end: c.end, lang: st.lang, threads: st.threads, model: st.model, engine: useEl ? 'elevenlabs' : 'whisper', apiKey: key });
    if (useEl && (c.sub.offset == null || c.sub.offset === -0.15)) c.sub.offset = 0;
    if (!useEl && c.sub.offset === 0) c.sub.offset = -0.15;
    toast(c.words.length ? `${c.name}: ${c.words.length} words transcribed.` : `${c.name}: no speech found.`);
  } catch (e) { toast(e.message, true); }
  delete T.busy[c.id]; save(); stageDirty = true; if (['subtitles', 'editor', 'export'].includes(S.tab)) render(true);
}
function rightStage(it, extra) {
  const c = curClip(); const p = h('div', {}, h('div', { class: 'ptitle' }, it ? it.label : 'Live preview'));
  if (!c) return p;
  mountStage(c);
  p.append(h('div', { class: 'stage-wrap' }, h('div', {}, Stage.el, Stage.bar), extra ? extra() : null));
  if (it?.desc) p.append(h('div', { class: 'pdesc', html: it.desc }));
  return p;
}

// ---------- LAYOUT ----------
function pageLayout() {
  const c = curClip(); if (!c) return needClipItems('Create a clip first, then arrange gameplay and facecam here.');
  const l = () => curClip().layout; const L = [];
  const m = l().mode;
  L.push(sec('Format'));
  L.push(enumRow('Layout', () => l().mode, (v) => (l().mode = v), [['stack', 'Split screen'], ['pip', 'Facecam overlay'], ['full', 'Gameplay only']], { rebuild: true, desc: '<b>Split screen</b> stacks gameplay and facecam. <b>Facecam overlay</b> floats the facecam over full-screen gameplay. <b>Gameplay only</b> crops the video to 9:16.' }));
  if (m === 'stack') {
    L.push(enumRow('Facecam position', () => l().camPos, (v) => (l().camPos = v), [['bottom', 'Bottom'], ['top', 'Top']], { desc: 'Where the facecam strip sits.' }));
    L.push(rangeRow('Facecam height', () => l().camHeight, (v) => (l().camHeight = v), 0.15, 0.6, 0.01, (v) => Math.round(v * 100) + ' %', { desc: 'Share of the vertical frame used by the facecam.' }));
  }
  if (m === 'pip') {
    L.push(rangeRow('Overlay size', () => l().pipSize, (v) => (l().pipSize = v), 0.2, 0.8, 0.01, (v) => Math.round(v * 100) + ' %', { desc: 'Width of the facecam overlay relative to the frame.' }));
    L.push(rangeRow('Overlay X', () => l().pipX, (v) => (l().pipX = v), 0, 1, 0.01, (v) => Math.round(v * 100) + ' %'));
    L.push(rangeRow('Overlay Y', () => l().pipY, (v) => (l().pipY = v), 0, 1, 0.01, (v) => Math.round(v * 100) + ' %'));
  }
  L.push(sec('Gameplay crop'));
  L.push(rangeRow('Zoom', () => l().gpZoom, (v) => (l().gpZoom = v), 1, 3, 0.05, (v) => v.toFixed(2) + '×', { desc: 'Zoom into the gameplay. 1× shows as much as fits.' }));
  L.push(rangeRow('Pan horizontal', () => l().gpX, (v) => (l().gpX = v), 0, 1, 0.01, (v) => Math.round(v * 100) + ' %', { desc: 'Slide the crop window left / right across the source.' }));
  L.push(rangeRow('Pan vertical', () => l().gpY, (v) => (l().gpY = v), 0, 1, 0.01, (v) => Math.round(v * 100) + ' %'));
  if (m !== 'full') {
    L.push(sec('Facecam source'));
    L.push(rangeRow('Crop size', () => l().camSize, (v) => (l().camSize = v), 0.08, 0.7, 0.01, (v) => Math.round(v * 100) + ' %', { desc: 'How much of the source width is taken as the facecam. You can also <b>drag the pink box</b> on the source map.' }));
    L.push(rangeRow('Crop X', () => l().camX, (v) => (l().camX = v), 0, 1, 0.01, (v) => Math.round(v * 100) + ' %', { desc: 'Where the facecam is located in the source video (most streamers: bottom right).' }));
    L.push(rangeRow('Crop Y', () => l().camY, (v) => (l().camY = v), 0, 1, 0.01, (v) => Math.round(v * 100) + ' %'));
  }
  L.push(sec('Look'));
  L.push(enumRow('Color filter', () => l().filter || 'none', (v) => (l().filter = v), [['none', 'Off'], ['bw', 'Black & white'], ['bwc', 'Black & white – high contrast']], { desc: 'Turns the video black & white. Subtitles and headline keep their colors.' }));
  L.push(sec('Tools'));
  L.push(actionRow('Reset layout', () => { c.layout = clone(DEFAULT_LAYOUT); save(); render(true); }));
  L.push(actionRow('Apply to all clips of this video', () => { S.clips.filter((x) => x.videoId === c.videoId).forEach((x) => (x.layout = clone(c.layout))); save(); toast('Layout applied to all clips of this video.'); }));
  return L;
}
function srcMap(c) {
  const v = vidOf(c); const map = h('div', { class: 'srcmap', style: v.thumb ? `background-image:url('${fileUrl(v.thumb)}')` : '' });
  const { boxes } = Shared.computeLayout(c.layout, v.w, v.h);
  boxes.forEach((b) => { const r = b.crop; const el = h('div', { class: 'rc ' + (b.role === 'cam' ? 'cam' : 'g'), style: `left:${(r.x / v.w) * 100}%;top:${(r.y / v.h) * 100}%;width:${(r.w / v.w) * 100}%;height:${(r.h / v.h) * 100}%` }); map.append(el);
    if (b.role === 'cam') el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); const mr = map.getBoundingClientRect(); const sx = e.clientX, sy = e.clientY, ox = c.layout.camX, oy = c.layout.camY;
      const fx = (1 - r.w / v.w) * mr.width, fy = (1 - r.h / v.h) * mr.height;
      const mv = (ev) => { if (fx > 0) c.layout.camX = clamp(ox + (ev.clientX - sx) / fx, 0, 1); if (fy > 0) c.layout.camY = clamp(oy + (ev.clientY - sy) / fy, 0, 1); const nb = Shared.computeLayout(c.layout, v.w, v.h).boxes.find((x) => x.role === 'cam').crop; el.style.left = (nb.x / v.w) * 100 + '%'; el.style.top = (nb.y / v.h) * 100 + '%'; stageDirty = true; };
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); save(); refreshList(); renderFxOverlay(T.stageClip); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); }); });
  return h('div', {}, h('div', { class: 'cap' }, 'Source map'), map, h('div', { class: 'pdesc', style: 'font-size:12px', html: 'White: gameplay crop.<br><b>Pink: facecam – drag to move.</b>' }));
}

// ---------- HEADLINES ----------
function pageHeads() {
  const c = curClip(); if (!c) return needClipItems('Create a clip first, then add a headline here.');
  const hd = () => curClip().head; const L = []; const presets = { ...HEAD_PRESETS, ...S.presets.head };
  L.push(sec('Headline'));
  L.push({ type: 'text', label: 'Text', placeholder: 'Type your headline…', get: () => hd().text, set: (v) => { hd().text = v; stageDirty = true; save(); }, desc: 'Big text at the top of the video. Long text wraps automatically; use <b>Enter</b> to confirm.' });
  L.push(toggleRow('Show headline', () => c.headOn, (v) => (c.headOn = v)));
  L.push(enumRow('Preset', () => hd().preset || 'Custom', (v) => { const p = clone(presets[v]); const t = hd().text; c.head = { ...p, preset: v, text: t || p.text }; }, Object.keys(presets), { rebuild: true, desc: 'Ready-made headline looks. Your text is kept when switching.' }));
  L.push(sec('Typography'));
  L.push(enumRow('Font', () => hd().font, (v) => (hd().font = v), FONT_OPTS));
  L.push(rangeRow('Size', () => hd().size, (v) => (hd().size = v), 40, 180, 2, (v) => v + ' px'));
  L.push(colorRow('Text color', () => hd().color, (v) => (hd().color = v)));
  L.push(toggleRow('Rounded card', () => !!hd().card, (v) => (hd().card = v), { desc: 'Clean rounded window behind the text (like a navigation popup). First line bold, further lines smaller. Card color = Box color.' }));
  L.push(toggleRow('Background box', () => hd().box, (v) => (hd().box = v), { desc: 'Draws a solid box behind the text using the outline color.' }));
  L.push(colorRow('Outline / box color', () => hd().outlineColor, (v) => (hd().outlineColor = v)));
  L.push(rangeRow('Outline / padding', () => hd().outline, (v) => (hd().outline = v), 0, 30, 1, (v) => v + ' px'));
  L.push(rangeRow('Shadow', () => hd().shadow, (v) => (hd().shadow = v), 0, 14, 1, (v) => v + ' px'));
  L.push(sec('Position & timing'));
  L.push(rangeRow('Vertical position', () => hd().y, (v) => (hd().y = v), 0.05, 0.9, 0.01, (v) => Math.round(v * 100) + ' %', { desc: 'Distance from the top of the frame.' }));
  L.push(enumRow('Animation', () => hd().anim, (v) => (hd().anim = v), [['pop', 'Pop in'], ['fade', 'Fade'], ['none', 'None']]));
  L.push(rangeRow('Visible for', () => hd().duration, (v) => (hd().duration = v), 0, 30, 0.5, (v) => (v === 0 ? 'Whole clip' : v + ' s'), { desc: 'How long the headline stays on screen.' }));
  L.push(sec('Tools'));
  L.push(actionRow('Save style as preset…', async () => { const n = await ask('Preset name'); if (n && n.trim()) { S.presets.head[n.trim()] = clone({ ...hd(), preset: undefined }); hd().preset = n.trim(); save(); render(true); toast('Preset saved.'); } }));
  L.push(actionRow('Apply style to all clips', () => { S.clips.forEach((x) => { x.head = { ...clone(c.head), text: x.head.text || c.head.text }; }); save(); toast('Headline style applied to all clips (texts kept).'); }));
  return L;
}


// ---------- EFFECTS ----------
// effects/sounds: refresh list + boxes only, never remount the preview
function softRender() { if (S.tab === 'effects' || S.tab === 'sounds') { refreshList(); renderFxOverlay(T.stageClip); } else render(true); }
const FX_NAMES = { pixelate: 'Pixelate', blur: 'Blur', bw: 'Black & white' };
const relNow = (c) => clamp(V.currentTime - c.start, 0, c.end - c.start);
function renderFxOverlay(c) {
  const ov = Stage.ovl; if (!ov) return; ov.replaceChildren();
  if (S.tab !== 'effects' || !c) { ov.style.pointerEvents = 'none'; return; }
  ov.style.pointerEvents = 'auto';
  (c.fx || []).forEach((f) => {
    const r = Shared.fxRect(f), sel = f.id === T.fxSel;
    const b = h('div', { class: 'fxbox' + (sel ? ' sel' : ''), style: `left:${r.x / 10.8}%;top:${r.y / 19.2}%;width:${r.w / 10.8}%;height:${r.h / 19.2}%` }, h('span', { class: 'fxl' }, FX_NAMES[f.type]));
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); T.fxSel = f.id; dragFx(e, f, 'move', b); });
    if (sel) ['nw', 'ne', 'sw', 'se'].forEach((cn) => { const hd = h('i', { class: 'hd ' + cn }); hd.addEventListener('pointerdown', (e) => { e.stopPropagation(); dragFx(e, f, cn, b); }); b.append(hd); });
    ov.append(b);
  });
}
function dragFx(e, f, mode, el) {
  e.preventDefault(); el.setPointerCapture(e.pointerId);
  const rect = Stage.ovl.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, o = Shared.fxRect(f); let moved = false;
  const mv = (ev) => {
    moved = true; const dx = ((ev.clientX - sx) / rect.width) * 1080, dy = ((ev.clientY - sy) / rect.height) * 1920; let { x, y, w, h: hh } = o;
    if (mode === 'move') { x += dx; y += dy; } else { if (mode.includes('e')) w += dx; if (mode.includes('s')) hh += dy; if (mode.includes('w')) { x += dx; w -= dx; } if (mode.includes('n')) { y += dy; hh -= dy; } }
    w = Math.max(48, w); hh = Math.max(48, hh); x = clamp(x, 0, 1080 - w); y = clamp(y, 0, 1920 - hh);
    Object.assign(f, { x, y, w, h: hh }); el.style.left = x / 10.8 + '%'; el.style.top = y / 19.2 + '%'; el.style.width = w / 10.8 + '%'; el.style.height = hh / 19.2 + '%'; stageDirty = true;
  };
  const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); save(); refreshList(); renderFxOverlay(T.stageClip); };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
}
function pageEffects() {
  const c = curClip(); if (!c) return needClipItems('Create a clip first, then add pixelate / blur / black & white areas to it.');
  c.fx = c.fx || []; const dur = c.end - c.start, L = [];
  if (!c.fx.find((f) => f.id === T.fxSel)) T.fxSel = c.fx[0] ? c.fx[0].id : null;
  const f = c.fx.find((x) => x.id === T.fxSel);
  L.push(sec('Effect areas'));
  if (!c.fx.length) L.push({ type: 'custom', node: h('div', { class: 'empty' }, 'No effects yet. Add one below, then drag the box on the preview.') });
  c.fx.forEach((x) => L.push({ type: 'clip', label: (x.id === T.fxSel ? '▶ ' : '') + FX_NAMES[x.type], value: `${fmt(x.start)} → ${fmt(x.end)}`, fn: () => { T.fxSel = x.id; softRender(); }, mini: [['✕', 'Delete', () => { c.fx = c.fx.filter((y) => y !== x); save(); softRender(); }]], desc: 'Click to select. Drag the box on the preview to move it, drag the corner dots to resize.' }));
  const add = (type) => () => { const s0 = relNow(c), nf = { id: uid(), type, x: 340, y: 700, w: 400, h: 400, start: s0, end: Math.min(dur, s0 + 3), amount: type === 'pixelate' ? 28 : 24 }; if (nf.end - nf.start < 0.5) { nf.start = Math.max(0, dur - 3); nf.end = dur; } c.fx.push(nf); T.fxSel = nf.id; save(); softRender(); };
  L.push(actionRow('Add pixelate area', add('pixelate'), { desc: 'Censors something (faces, names, chat, numbers) with big pixels. Starts at the current playhead and lasts 3 s – change the timing below.' }));
  L.push(actionRow('Add blur area', add('blur'), { desc: 'Soft blur over an area, timed.' }));
  L.push(actionRow('Add black & white area', add('bw'), { desc: 'Turns just this area black & white for a moment. Make it cover the whole frame for a full-screen B&W moment.' }));
  if (f) {
    const setS = (v) => { f.start = v; if (f.end <= f.start + 0.1) f.end = Math.min(dur, f.start + 0.5); if (f.end <= f.start + 0.1) f.start = Math.max(0, f.end - 0.5); };
    const setE = (v) => { f.end = v; if (f.end <= f.start + 0.1) f.start = Math.max(0, f.end - 0.5); };
    L.push(sec('Selected effect'));
    L.push(enumRow('Type', () => f.type, (v) => { f.type = v; }, [['pixelate', 'Pixelate'], ['blur', 'Blur'], ['bw', 'Black & white']], { rebuild: true }));
    if (f.type !== 'bw') L.push(rangeRow(f.type === 'pixelate' ? 'Pixel size' : 'Blur strength', () => f.amount || 28, (v) => (f.amount = v), 4, 100, 2, (v) => v + ' px', { desc: 'Larger = stronger censoring.' }));
    L.push(rangeRow('Starts at', () => f.start, setS, 0, dur, 0.1, (v) => fmt(v) + ' s', { rebuild: true, desc: 'When the effect switches on (seconds from the start of the clip).' }));
    L.push(rangeRow('Ends at', () => f.end, setE, 0, dur, 0.1, (v) => fmt(v) + ' s', { rebuild: true, desc: 'When the effect switches off.' }));
    L.push(actionRow('Start = playhead', () => { setS(relNow(c)); save(); softRender(); }, { desc: 'Scrub the preview to the right moment, then use this to set the start exactly.' }));
    L.push(actionRow('End = playhead', () => { setE(relNow(c)); save(); softRender(); }));
    L.push(rangeRow('Position X', () => Shared.fxRect(f).x / 1080, (v) => { const r = Shared.fxRect(f); f.x = v * 1080; f.w = r.w; f.y = r.y; f.h = r.h; }, 0, 1, 0.01, (v) => Math.round(v * 100) + ' %', { rebuild: true }));
    L.push(rangeRow('Position Y', () => Shared.fxRect(f).y / 1920, (v) => { const r = Shared.fxRect(f); f.y = v * 1920; f.w = r.w; f.x = r.x; f.h = r.h; }, 0, 1, 0.01, (v) => Math.round(v * 100) + ' %', { rebuild: true }));
    L.push(rangeRow('Width', () => Shared.fxRect(f).w / 1080, (v) => { f.w = Math.max(48, v * 1080); }, 0.05, 1, 0.01, (v) => Math.round(v * 100) + ' %', { rebuild: true }));
    L.push(rangeRow('Height', () => Shared.fxRect(f).h / 1920, (v) => { f.h = Math.max(48, v * 1920); }, 0.03, 1, 0.01, (v) => Math.round(v * 100) + ' %', { rebuild: true }));
  }
  return L;
}

// ---------- SOUNDS ----------
function pageSounds() {
  const c = curClip(); if (!c) return needClipItems('Create a clip first, then add sounds (music, sound effects, voice) to it.');
  c.sounds = c.sounds || []; const dur = c.end - c.start, L = [];
  if (!c.sounds.find((x) => x.id === T.sndSel)) T.sndSel = c.sounds[0] ? c.sounds[0].id : null;
  const sn = c.sounds.find((x) => x.id === T.sndSel);
  L.push(sec('Sounds on this clip'));
  if (!c.sounds.length) L.push({ type: 'custom', node: h('div', { class: 'empty' }, 'No sounds yet. Add a file, then trim it and place it on the timeline.') });
  c.sounds.forEach((x) => { const len = Math.min((x.trimOut > (x.trimIn || 0) ? x.trimOut : x.dur) - (x.trimIn || 0), dur - x.at); L.push({ type: 'clip', label: (x.id === T.sndSel ? '▶ ' : '') + x.name, value: `at ${fmt(x.at)} · ${fmt(Math.max(0, len))}s`, fn: () => { T.sndSel = x.id; softRender(); }, mini: [['✕', 'Remove sound', () => { c.sounds = c.sounds.filter((y) => y !== x); delete T.audios[x.id]; save(); softRender(); }]], desc: 'Click to select and edit this sound.' }); });
  L.push(actionRow('Add sound from file…', async () => {
    try { const r = await api.pickSound(); if (!r) return; const at = Math.min(relNow(c), Math.max(0, dur - 0.5)); const nsn = { id: r.id, path: r.path, name: r.name, dur: r.dur, at, trimIn: 0, trimOut: r.dur, vol: 1, fade: 0.2 }; c.sounds.push(nsn); T.sndSel = nsn.id; save(); toast(`“${r.name}” added at ${fmt(at)}.`); softRender(); }
    catch (e) { toast(e.message, true); }
  }, { desc: 'MP3, WAV, OGG, M4A, FLAC … The sound starts at the current playhead position. Press <b>Space</b> in the preview to hear the mix.' }));
  if (sn) {
    L.push(sec('Selected sound'));
    L.push(rangeRow('Starts in clip at', () => sn.at, (v) => (sn.at = v), 0, Math.max(0.1, dur - 0.1), 0.1, (v) => fmt(v) + ' s', { rebuild: true, desc: 'Where in the clip the sound begins.' }));
    L.push(actionRow('Place at playhead', () => { sn.at = Math.min(relNow(c), Math.max(0, dur - 0.1)); save(); softRender(); }, { desc: 'Scrub the preview to the right moment, then click to place the sound exactly there.' }));
    L.push(rangeRow('Trim: start', () => sn.trimIn || 0, (v) => { sn.trimIn = v; if ((sn.trimOut || sn.dur) <= v + 0.1) sn.trimOut = Math.min(sn.dur, v + 0.5); }, 0, Math.max(0.1, sn.dur - 0.1), 0.05, (v) => v.toFixed(2) + ' s', { rebuild: true, desc: 'Cut off the beginning of the sound file.' }));
    L.push(rangeRow('Trim: end', () => sn.trimOut > (sn.trimIn || 0) ? sn.trimOut : sn.dur, (v) => { sn.trimOut = v; if (v <= (sn.trimIn || 0) + 0.1) sn.trimIn = Math.max(0, v - 0.5); }, 0.1, sn.dur, 0.05, (v) => v.toFixed(2) + ' s', { rebuild: true, desc: 'Cut off the end of the sound file.' }));
    L.push(rangeRow('Volume', () => (sn.vol == null ? 1 : sn.vol), (v) => (sn.vol = v), 0, 2, 0.05, (v) => Math.round(v * 100) + ' %', { desc: 'Above 100 % boosts the sound in the export (the preview plays at most 100 %).' }));
    L.push(rangeRow('Fade in / out', () => sn.fade || 0, (v) => (sn.fade = v), 0, 3, 0.1, (v) => (v === 0 ? 'Off' : v.toFixed(1) + ' s'), { desc: 'Smooth fade at the start and end of the sound.' }));
  }
  L.push(sec('Original audio'));
  L.push(rangeRow('Video volume', () => (c.origVol == null ? 1 : c.origVol), (v) => (c.origVol = v), 0, 1.5, 0.05, (v) => (v === 0 ? 'Muted' : Math.round(v * 100) + ' %'), { desc: 'Turn the original sound down (or off) so your added sounds stand out.' }));
  return L;
}

// ---------- EXPORT ----------
const outDir = () => S.settings.outDir || (T.env.videos ? T.env.videos + '\\Clipwave' : '');
function pageExport() {
  const L = [sec('Output')];
  L.push(actionRow('Folder', async () => { const d = await api.pickDir().catch(() => null); if (d) { S.settings.outDir = d; save(); render(true); } }, { value: () => outDir().replace(/^.*[\\/](.+[\\/].+)$/, '…\\$1'), desc: 'Where finished videos are saved. Click to choose another folder.' }));
  L.push(enumRow('Quality', () => S.settings.quality, (v) => (S.settings.quality = v), Object.entries(QUALITY).map(([k, [n, crf]]) => [k, `${n} (CRF ${crf})`]), { desc: 'Lower CRF = better quality and bigger files. <b>High</b> is ideal for TikTok / Shorts uploads.' }));
  L.push(enumRow('Frame rate', () => S.settings.fps, (v) => (S.settings.fps = v), [['source', 'Same as source'], ['30', '30 fps'], ['60', '60 fps']]));
  L.push({ type: 'custom', node: h('div', { class: 'empty' }, 'Resolution: 1080 × 1920 (9:16) · H.264 + AAC · MP4') });
  L.push(sec('Outro'));
  const oc = curClip(); const ou = () => (oc.outro || (oc.outro = clone(Shared.DEFAULT_OUTRO)));
  if (!oc) L.push({ type: 'custom', node: h('div', { class: 'empty' }, 'Select a clip to set up its outro.') });
  else {
    L.push(toggleRow('Add animated Clipwave outro', () => ou().on, (v) => (ou().on = v), { rebuild: true, desc: 'Appends a short animated outro (pulsing rings, glowing logo, chime) to the end of the video.' }));
    if (ou().on) {
      L.push(enumRow('Outro length', () => ou().mode, (v) => (ou().mode = v), [['pad', 'Fill up to 1 minute'], ['fixed', 'Fixed length']], { rebuild: true, desc: '<b>Fill up to 1 minute</b> makes the outro exactly as long as needed so the finished video is 60 s (outro 3–30 s). Handy for platforms that need videos over one minute.' }));
      if (ou().mode === 'fixed') L.push(rangeRow('Seconds', () => ou().seconds, (v) => (ou().seconds = v), 2, 30, 1, (v) => v + ' s', { rebuild: true }));
      L.push({ type: 'text', label: 'Outro title', placeholder: 'CLIPWAVE', get: () => ou().title, set: (v) => (ou().title = v) });
      L.push({ type: 'text', label: 'Outro tagline', placeholder: 'Follow for more', get: () => ou().sub, set: (v) => (ou().sub = v) });
      const clipLen = oc.end - oc.start, od = Shared.outroDuration(ou(), clipLen);
      L.push({ type: 'custom', node: h('div', { class: 'empty' }, `Clip ${fmt(clipLen, 0)}s + outro ${od.toFixed(1)}s = ${fmt(clipLen + od, 0)} total` + (ou().mode === 'pad' && clipLen + od < 59.5 ? ' – clip is too short to reach 1:00 (outro is capped at 30 s).' : '')) });
      L.push(actionRow('Apply outro to all clips', () => { S.clips.forEach((x) => (x.outro = clone(ou()))); save(); toast('Outro applied to all clips.'); }));
    }
  }
  L.push(sec('Queue'));
  if (!S.clips.length) L.push({ type: 'custom', node: h('div', { class: 'empty' }, 'No clips yet – create some in the Clip Editor.') });
  S.clips.forEach((c) => {
    const j = Object.values(T.jobs).find((x) => x.clipId === c.id); const v = vidOf(c);
    const on = T.sel[c.id] ?? c.id === S.selClip; const state = j ? (j.error ? 'Failed' : j.done ? 'Done' : `${Math.round(j.pct || 0)}%`) : '';
    L.push({ type: 'clip', label: c.name + (v ? ` – ${v.title.slice(0, 26)}` : ''), thumb: v?.thumb, value: `${state || (on ? '✓ selected' : '–')}  ${fmt(c.end - c.start, 0)}s`, clipRef: c, fn: () => { T.sel[c.id] = !on; S.selClip = c.id; render(true); } });
  });
  L.push(actionRow(T.exporting ? 'Rendering…' : 'Export selected clips', () => runExport(S.clips.filter((c) => T.sel[c.id] ?? c.id === S.selClip)), { value: `${S.clips.filter((c) => T.sel[c.id] ?? c.id === S.selClip).length} clip(s)`, desc: 'Renders every ticked clip in the background – you can keep working while it runs.' }));
  L.push(actionRow('Select all clips', () => { S.clips.forEach((c) => (T.sel[c.id] = true)); render(true); }));
  if (T.exporting) L.push(actionRow('Cancel rendering', () => api.cancelExport()));
  L.push(sec('Export history'));
  if (!S.history.length) L.push({ type: 'custom', node: h('div', { class: 'empty' }, 'Finished exports appear here.') });
  S.history.slice(0, 12).forEach((e) => L.push({ type: 'hist', label: e.name, value: `${bytes(e.size)} · ${ago(e.at)}`, fn: () => api.open(e.out).catch((x) => toast(x.message, true)), hist: e, mini: [['▶', 'Play', () => api.open(e.out)], ['📂', 'Show in folder', () => api.show(e.out)], ['✕', 'Remove from history', () => { S.history = S.history.filter((x) => x !== e); save(); render(true); }]] }));
  return L;
}
function rightExport(it) {
  if (it && it.type === 'hist') return h('div', {}, h('div', { class: 'ptitle' }, it.hist.name), h('div', { class: 'facts' }, h('span', {}, 'File'), h('b', {}, it.hist.out), h('span', {}, 'Size'), h('b', {}, bytes(it.hist.size)), h('span', {}, 'Rendered'), h('b', {}, ago(it.hist.at))), h('div', { class: 'btnrow' }, h('button', { class: 'btn fill', onclick: () => api.open(it.hist.out) }, 'Play'), h('button', { class: 'btn', onclick: () => api.show(it.hist.out) }, 'Show in folder')));
  if (it && it.type === 'clip') { const old = S.selClip; return rightStageFor(it.clipRef, it); }
  return rightStage(it);
}
function rightStageFor(c, it) { const p = h('div', {}, h('div', { class: 'ptitle' }, c.name)); mountStage(c); p.append(h('div', { class: 'stage-wrap' }, h('div', {}, Stage.el, Stage.bar)), h('div', { class: 'pdesc', html: 'Exactly what will be rendered: 1080 × 1920, with subtitles and headline.' })); return p; }

async function runExport(clips) {
  if (T.exporting) return toast('A render is already running.', true);
  if (!clips.length) return toast('Tick at least one clip to export.', true);
  T.exporting = true; render(true);
  try {
    const dir = outDir(); const [, crf] = QUALITY[S.settings.quality]; const jobs = [];
    for (const c of clips) {
      const v = vidOf(c); if (!v || !(await api.exists(v.path))) { toast(`${c.name}: source video file is missing.`, true); continue; }
      if (c.subsOn && !c.words && T.env.whisper) { toast(`Transcribing ${c.name} first…`); await transcribeClip(c); }
      const base = S.settings.filename.replace('{title}', v.title).replace('{n}', String(S.clips.filter((x) => x.videoId === c.videoId).reverse().indexOf(c) + 1)).replace('{name}', c.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80) || 'clip';
      let out = `${dir}\\${base}.mp4`, k = 2; while (await api.exists(out)) out = `${dir}\\${base}_${k++}.mp4`;
      const jobId = uid(); T.jobs[jobId] = { clipId: c.id, pct: 0, name: c.name };
      jobs.push({ jobId, videoPath: v.path, w: v.w, h: v.h, start: c.start, end: c.end, words: c.words || [], sub: c.sub, head: c.head, layout: c.layout, subsOn: c.subsOn, headOn: c.headOn, out, crf, preset: S.settings.speed, fps: S.settings.fps === 'source' ? (c.outro && c.outro.on ? Math.min(60, Math.round(v.fps || 30)) : 0) : Number(S.settings.fps), encoder: S.settings.encoder, threads: S.settings.threads, fx: c.fx || [], sounds: c.sounds || [], origVol: c.origVol == null ? 1 : c.origVol, outro: c.outro || null, outroDur: Shared.outroDuration(c.outro, c.end - c.start), hasAudio: v.hasAudio !== false });
    }
    if (jobs.length) { toast(`Rendering ${jobs.length} clip(s) in the background…`); await api.exportBatch(jobs); const ok = jobs.filter((j) => T.jobs[j.jobId]?.done && !T.jobs[j.jobId].error).length; toast(`Export finished: ${ok} of ${jobs.length} succeeded.`, ok < jobs.length); }
  } catch (e) { toast(e.message, true); }
  T.exporting = false; updateBgJob(); if (['export'].includes(S.tab)) render(true);
}

// ---------- SETTINGS ----------
function pageSettings() {
  const st = S.settings; const set = (k) => (v) => (st[k] = v); const L = [];
  L.push(sec('General'));
  L.push(enumRow('Transcription language', () => st.lang, set('lang'), LANGS, { desc: 'Default spoken language for Whisper.' }));
  L.push(actionRow('Output folder', async () => { const d = await api.pickDir().catch(() => null); if (d) { st.outDir = d; save(); render(true); } }, { value: () => outDir().slice(-34), desc: 'Where exports are saved by default.' }));
  L.push({ type: 'text', label: 'File name', placeholder: '{title}_clip{n}', get: () => st.filename, set: set('filename'), desc: 'Template for exported files. Use <b>{title}</b>, <b>{n}</b> and <b>{name}</b>.' });
  L.push(enumRow('Transcription engine', () => st.engine, set('engine'), [['auto', 'Automatic (ElevenLabs if key set)'], ['elevenlabs', 'ElevenLabs Scribe - most accurate'], ['whisper', 'Whisper - offline']], { desc: '<b>ElevenLabs Scribe</b> gives much more accurate words and timing, but needs an internet connection and your own API key (the clip audio is uploaded). <b>Whisper</b> runs fully offline on your PC.' }));
  L.push(actionRow(st.elKey ? 'ElevenLabs connected ✓ – reconnect' : T.connecting ? 'Waiting for the key you copy…' : 'Connect ElevenLabs (1 click)', connectEleven, { value: st.elKey ? 'connected' : '', desc: '<b>1.</b> Click here – the ElevenLabs website opens. <b>2.</b> Sign up / log in (free). <b>3.</b> Click <b>Create API Key</b>, then <b>Copy</b>. <br>Clipwave notices the copied key by itself and connects. Nothing to paste.' }));
  L.push(actionRow('Disconnect ElevenLabs', () => { st.elKey = ''; save(); render(true); toast('ElevenLabs disconnected.'); }, { disabled: !st.elKey }));
  L.push({ type: 'text', secret: true, label: 'ElevenLabs API key (manual)', submit: () => st.elKey && acceptElevenKey(st.elKey.trim()), placeholder: 'Paste key from elevenlabs.io', get: () => st.elKey, set: set('elKey'), desc: 'Create a key at <b>elevenlabs.io</b> (Developers - API Keys, enable Speech to Text). It is stored only on this computer and used only for transcription.' });
  L.push(enumRow('Whisper model', () => st.model, set('model'), [['base', 'Base – fast, built in'], ['small', 'Small – accurate (488 MB)'], ['medium', 'Medium – best (1.5 GB)']], { desc: 'Bigger models understand words far better, especially German and fast speech. <b>Small</b> and <b>Medium</b> are downloaded once on first use.' }));
  L.push(toggleRow('Auto-transcribe new clips', () => st.autoTranscribe, set('autoTranscribe'), { desc: 'Starts Whisper automatically when a clip is added.' }));
  L.push(sec('Appearance'));
  L.push(enumRow('Color theme', () => st.accent, (v) => { st.accent = v; applyTheme(); }, Object.keys(ACCENTS), { desc: 'Atmosphere color of the whole interface.' }));
  L.push(toggleRow('Animated background', () => st.motion, (v) => { st.motion = v; applyTheme(); }, { desc: 'Slow drifting gradient and transitions. Turn off for the calmest UI.' }));
  L.push(toggleRow('Palm silhouettes', () => st.palms, (v) => { st.palms = v; applyTheme(); }));
  L.push(rangeRow('Interface scale', () => st.uiScale, (v) => { st.uiScale = v; applyTheme(); }, 80, 130, 5, (v) => v + ' %', { desc: 'Scales the entire interface.' }));
  L.push(sec('Subtitle defaults'));
  L.push(enumRow('Default style for new clips', () => st.subPreset, set('subPreset'), Object.keys({ ...SUB_PRESETS, ...S.presets.sub }), { desc: 'First clip of a session starts with this subtitle look.' }));
  L.push(sec('Export'));
  L.push(enumRow('Quality', () => st.quality, set('quality'), Object.entries(QUALITY).map(([k, [n, crf]]) => [k, `${n} (CRF ${crf})`])));
  L.push(enumRow('Frame rate', () => st.fps, set('fps'), [['source', 'Same as source'], ['30', '30 fps'], ['60', '60 fps']]));
  L.push(sec('Performance'));
  L.push(enumRow('Video encoder', () => st.encoder, set('encoder'), [['x264', 'CPU (x264)'], ['nvenc', 'NVIDIA GPU (NVENC)']], { desc: 'NVENC is much faster on NVIDIA cards and falls back to CPU automatically if unavailable.' }));
  L.push(enumRow('CPU speed preset', () => st.speed, set('speed'), [['ultrafast', 'Fastest'], ['veryfast', 'Fast'], ['fast', 'Balanced'], ['medium', 'Small files']], { desc: 'Slower presets create smaller files at the same quality.' }));
  L.push(rangeRow('Threads', () => st.threads, set('threads'), 0, Math.max(4, T.env.cpus || 8), 1, (v) => (v === 0 ? 'Auto' : String(v)), { desc: 'CPU threads for rendering and Whisper. Auto is recommended.' }));
  L.push(sec('Updates'));
  L.push(actionRow('Check for updates', async () => { try { const r = await api.updateCheck(); if (r.state === 'portable') toast('Portable version: download new versions manually from GitHub.'); else if (r.state === 'dev') toast('Updates only work in the installed app.'); else toast('Checking for updates…'); } catch (e) { toast(e.message, true); } }, { value: () => { const u = T.upd || {}; return `v${T.env.version || '?'}` + ({ ready: ' · update ready', downloading: ' · downloading…', uptodate: ' · up to date', error: ' · check failed' }[u.state] || ''); }, desc: 'Clipwave checks GitHub for new versions on start and every few hours, downloads them in the background and installs on the next restart. ' + (T.upd && T.upd.state === 'error' ? '<br><b>Last error:</b> ' + T.upd.message : '') }));
  if (T.upd && T.upd.state === 'ready') L.push(actionRow('Restart and install update ' + T.upd.version, () => api.updateInstall()));
  L.push(sec('Storage'));
  const gb = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.round(n / 1e6) + ' MB');
  L.push(actionRow('Free up space', cleanStorage, { value: () => (T.storage ? gb(T.storage.total) + ' can be freed' : 'checking…'), desc: 'Deletes leftovers: downloaded videos you removed from the library, unused Whisper models, the outro cache and old installer files. <b>Your projects, clips, exports and the selected model stay.</b>' + (T.storage ? '<br>Library on disk: ' + gb(T.storage.library) : '') }));
  L.push(sec('About'));
  L.push({ type: 'custom', node: h('div', { class: 'empty' }, `Clipwave ${T.env.version || ''} · FFmpeg · whisper.cpp (base) · yt-dlp · ${T.env.cpus || '?'} CPU threads`) });
  L.push(actionRow('Restore default settings', () => { S.settings = { ...DEF }; applyTheme(); save(); render(true); }));
  return L;
}


// ================= ElevenLabs connect =================
async function connectEleven() {
  try { await api.elevenConnect(); } catch (e) { return toast(e.message, true); }
  T.connecting = true; if (S.tab === 'settings') render(true);
  toast('ElevenLabs opened in your browser: sign in, click “Create API Key”, then “Copy”. Clipwave detects the key automatically.');
}
async function acceptElevenKey(key, quiet) {
  const r = await api.elevenCheck(key).catch((e) => ({ ok: false, error: e.message }));
  T.connecting = false;
  if (!r.ok && !r.offline) { toast(r.error || 'Key rejected.', true); if (S.tab === 'settings') render(true); return false; }
  S.settings.elKey = key; if (S.settings.engine === 'whisper') S.settings.engine = 'auto'; save();
  toast(r.offline ? 'Key saved (could not verify it offline).' : 'ElevenLabs connected ✓ – subtitles will now be much more accurate.');
  if (S.tab === 'settings' || S.tab === 'subtitles') render(true); return true;
}


const keepList = () => S.videos.flatMap((v) => [v.path, v.thumb]);
async function refreshStorage() { try { T.storage = await api.storageInfo({ keep: keepList(), model: S.settings.model }); if (S.tab === 'settings') render(true); } catch {} }
async function cleanStorage() {
  if (T.importing) return toast('Wait until the import has finished.', true);
  try { const n = await api.storageClean({ keep: keepList(), model: S.settings.model }); toast(`Freed ${n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.round(n / 1e6) + ' MB'}.`); } catch (e) { toast(e.message, true); }
  T.storage = null; refreshStorage(); if (S.tab === 'settings') render(true);
}


function onUpdate(u) {
  T.upd = u; let chip = $('#updchip');
  if (u.state === 'downloading' || u.state === 'ready') {
    if (!chip) { chip = h('button', { id: 'updchip', class: 'bgjob', onclick: () => T.upd && T.upd.state === 'ready' && api.updateInstall() }); $('.titlebar').insertBefore(chip, $('#bgjob')); }
    chip.textContent = u.state === 'ready' ? `Update ${u.version} ready – click to restart` : `Downloading update ${u.version || ''} · ${Math.round(u.pct || 0)}%`;
    chip.style.background = u.state === 'ready' ? 'var(--pop)' : '';
    if (u.state === 'ready' && !T.updToasted) { T.updToasted = true; toast(`Clipwave ${u.version} is ready. It installs when you close the app, or click the pink button now.`); }
  } else if (chip) chip.remove();
  if (S.tab === 'settings') render(true);
}

// ================= engine =================
const PAGE = { home: [pages.home, rightHome], editor: [pageEditor, null], subtitles: [pageSubs, null], layout: [pageLayout, null], headlines: [pageHeads, null], effects: [pageEffects, null], sounds: [pageSounds, null], export: [pageExport, null], settings: [pageSettings, null] };
function rightFor(it) {
  const t = S.tab;
  if (t === 'home') return rightHome(it);
  if (t === 'editor') return rightEditor();
  if (t === 'export') return rightExport(it);
  if (t === 'subtitles' || t === 'headlines' || t === 'sounds') return rightStage(it);
  if (t === 'effects') return curClip() ? rightStage(it, null) : h('div');
  if (t === 'layout') return curClip() ? rightStage(it, () => srcMap(curClip())) : h('div');
  const p = h('div', {}, h('div', { class: 'ptitle' }, it ? it.label : 'Settings'));
  if (it?.desc) p.append(h('div', { class: 'pdesc', html: it.desc })); return p;
}
function renderRight() {
  const it = items[T.row]; const r = $('#right');
  if (!['editor', 'subtitles', 'layout', 'headlines', 'effects', 'sounds', 'export'].includes(S.tab)) { T.stageClip = null; }
  const node = rightFor(it && it.type !== 'sec' ? it : null);
  if (node && !(it && it.desc == null && S.tab === 'settings')) r.replaceChildren(node);
  if (it && it.desc && ['home', 'editor'].includes(S.tab) && it.type !== 'video' && it.type !== 'clip' && node) node.append(h('div', { class: 'pdesc', html: it.desc }));
}
// rebuild only the left list (keeps the preview/video untouched, no flicker)
function refreshList() {
  const list = $('#list'), scroll = list.scrollTop; items = PAGE[S.tab][0]();
  if (!items[T.row]) T.row = 0; list.replaceChildren(...items.map((it, i) => buildRow(it, i))); list.scrollTop = scroll; updateCounter();
}
let lastTab = null;
function render(keep) {
  const [pg] = PAGE[S.tab]; const scroll = $('#list').scrollTop;
  if (!keep) T.row = 0; T.tickHook = null; if (S.tab !== 'editor') T.rangePlay = null;
  if (S.tab !== 'editor' && lastTab === 'editor') V.onclick = null;
  items = pg();
  const f = focusable(); if (!items[T.row] || !f.some(([, i]) => i === T.row)) T.row = f.length ? f[0][1] : 0;
  const preferSel = items.findIndex((x) => x.sel); if (!keep && preferSel >= 0) T.row = preferSel;
  const list = $('#list'); list.replaceChildren(...items.map((it, i) => buildRow(it, i)));
  if (lastTab !== S.tab) { list.classList.remove('page-in'); void list.offsetWidth; list.classList.add('page-in'); $('#right').classList.remove('page-in'); void $('#right').offsetWidth; $('#right').classList.add('page-in'); }
  list.scrollTop = keep ? scroll : 0; lastTab = S.tab;
  $('#tablist').querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.t === S.tab));
  const v = vidOf(null); const c = curClip(); $('#crumb').textContent = v ? `${v.title}${c ? '  ›  ' + c.name : ''}` : 'No video loaded';
  renderRight(); updateCounter();
}
function go(tab) {
  if (tab === 'settings') refreshStorage(); if (S.tab !== tab) { S.tab = tab; T.row = 0; } else T.row = 0; if (tab !== 'editor') T.view = T.view; render(false); save(); }

// ================= import =================
async function importUrl() {
  if (T.importing) return; const url = T.urlText.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return toast('Paste a full YouTube or Twitch link first (video, clip or VOD).', true);
  T.importing = { pct: 0, msg: 'Starting…' }; render(true);
  try { const v = await api.importUrl(url, (T.rangeText || '').trim()); addVideo(v); T.urlText = ''; T.rangeText = ''; toast(`Imported “${v.title}”.`); }
  catch (e) { toast(e.message, true); }
  T.importing = null; if (S.tab === 'home') render(true);
}
async function importFile() { try { const v = await api.importFile(); if (v) addVideo(v); } catch (e) { toast(e.message, true); } }
function addVideo(v) { S.videos.unshift(v); S.selVideo = v.id; S.selClip = null; T.view = null; save(); go('editor'); }

function updateBgJob() {
  const jobs = Object.values(T.jobs).filter((j) => !j.done); const el = $('#bgjob'); const busy = Object.keys(T.busy).length;
  if (!jobs.length && !busy && !T.importing) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const pct = jobs.length ? jobs.reduce((a, j) => a + (j.pct || 0), 0) / jobs.length : busy ? Object.values(T.busy)[0].pct : T.importing.pct;
  $('.bar i', el).style.width = pct + '%'; $('span', el).textContent = jobs.length ? `Rendering ${jobs.length} · ${Math.round(pct)}%` : busy ? `Transcribing · ${Math.round(pct)}%` : `Importing · ${Math.round(pct)}%`;
}
api.onEvent((e) => {
  if (e.type === 'import' && T.importing) { T.importing.pct = e.pct; T.importing.msg = e.msg; if (S.tab === 'home') { const i = items.findIndex((x) => x.type === 'action' && x.progress !== undefined); if (i >= 0) { items[i].value = `${Math.round(e.pct)}%`; items[i].label = e.msg; const old = $(`#list [data-i="${i}"]`); const bar = h('div', { class: 'pbar' }, h('i', { style: `width:${e.pct}%` })); items[i].progress = bar; if (old) { const nu = buildRow(items[i], i); old.replaceWith(nu); } } } updateBgJob(); }
  if (e.type === 'update') onUpdate(e);
  if (e.type === 'elkey') acceptElevenKey(e.key);
  if (e.type === 'model') { const b = $('#list .pbar i'); if (b) b.style.width = e.pct + '%'; const o = $('#bgjob span'); $('#bgjob').classList.remove('hidden'); if (o) o.textContent = `Downloading model · ${Math.round(e.pct)}%`; $('#bgjob .bar i').style.width = e.pct + '%'; }
  if (e.type === 'transcribe') { if (T.busy[e.clipId]) T.busy[e.clipId].pct = e.pct; const b = $('#list .pbar i'); if (b && S.tab === 'subtitles') b.style.width = e.pct + '%'; const v = $('#list .row .val .t'); updateBgJob(); }
  if (e.type === 'export') {
    const j = T.jobs[e.jobId]; if (!j) return;
    if (e.pct != null) j.pct = e.pct;
    if (e.done) { j.done = true; j.error = e.error; if (!e.error) { S.history.unshift({ name: e.out.split('\\').pop(), out: e.out, size: e.size, at: Date.now() }); S.history = S.history.slice(0, 60); save(); } else if (e.error !== 'Cancelled') toast(`${j.name}: ${e.error}`, true); if (S.tab === 'export') render(true); }
    else if (S.tab === 'export') { const idx = items.findIndex((x) => x.clipRef && x.clipRef.id === j.clipId); const el = idx >= 0 && $(`#list [data-i="${idx}"] .val .t`); if (el) el.textContent = `${Math.round(j.pct)}%  ${fmt(items[idx].clipRef.end - items[idx].clipRef.start, 0)}s`; }
    updateBgJob();
  }
});

// ================= input =================
addEventListener('keydown', (e) => {
  if (!$('#modal').classList.contains('hidden')) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' && e.target.type !== 'range') { if (e.key === 'Escape') e.target.blur(); return; }
  const f = focusable(); const pos = f.findIndex(([, i]) => i === T.row);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = f[clamp(pos + (e.key === 'ArrowDown' ? 1 : -1), 0, f.length - 1)]; if (n) selectRow(n[1]); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const it = items[T.row]; if (it && ['enum', 'range', 'toggle'].includes(it.type)) { e.preventDefault(); nudge(it, e.key === 'ArrowRight' ? 1 : -1); } }
  else if (e.key === 'Enter') { const it = items[T.row]; if (it) activate(it); }
  else if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); playToggle(); }
  else if (e.key.toLowerCase() === 'q' || e.key.toLowerCase() === 'e') { const i = TABS.findIndex(([k]) => k === S.tab); go(TABS[(i + (e.key.toLowerCase() === 'e' ? 1 : TABS.length - 1)) % TABS.length][0]); }
  else if (S.tab === 'editor' && e.key.toLowerCase() === 'i') T.setIn?.();
  else if (S.tab === 'editor' && e.key.toLowerCase() === 'o') T.setOut?.();
  else if (S.tab === 'home' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') navigator.clipboard.readText().then((t) => { if (/^https?:\/\//i.test(t.trim())) { T.urlText = t.trim(); render(true); toast('Link pasted – press Enter on “Import from link”.'); } }).catch(() => {});
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (!f) return; const p = api.pathOf(f); if (!/\.(mp4|mkv|mov|webm|avi|m4v)$/i.test(p)) return toast('That is not a supported video file.', true); try { addVideo(await api.importPath(p)); } catch (x) { toast(x.message, true); } });
addEventListener('resize', () => { Stage.cv = null; if (['editor', 'subtitles', 'layout', 'headlines', 'effects', 'sounds', 'export'].includes(S.tab)) renderRight(); });
window.onerror = (m) => toast('Unexpected error: ' + m, true);
addEventListener('unhandledrejection', (e) => toast('Error: ' + (e.reason?.message || e.reason), true));

// ================= theme / palms / boot =================
function applyTheme() {
  const a = ACCENTS[S.settings.accent] || ACCENTS.Magenta; const r = document.documentElement.style;
  r.setProperty('--a1', a[0]); r.setProperty('--a2', a[1]); r.setProperty('--a3', a[2]);
  document.body.classList.toggle('nomotion', !S.settings.motion); document.body.classList.toggle('nopalms', !S.settings.palms);
  document.documentElement.style.zoom = S.settings.uiScale / 100;
}
function palm(x, y, ht, lean) {
  const tx = x + lean, ty = y - ht; let d = '';
  const trunk = `<path d="M${x - 7},${y} Q${x + lean * 0.3},${y - ht * 0.5} ${tx - 3},${ty} L${tx + 3},${ty} Q${x + lean * 0.3 + 8},${y - ht * 0.5} ${x + 7},${y}Z"/>`;
  const L = ht * 0.62;
  for (const a of [-168, -140, -112, -84, -56, -28, -4, 22, 48]) {
    const r = ((a - 90) * Math.PI) / 180, dx = Math.cos(r), dy = Math.sin(r);
    const ex = tx + dx * L, ey = ty + dy * L * 0.55 + L * 0.42 * Math.abs(dx), mx = tx + dx * L * 0.5, my = ty + dy * L * 0.5 - L * 0.18;
    const px = -dy * L * 0.09, py = dx * L * 0.09;
    d += `<path d="M${tx},${ty} Q${mx + px},${my + py} ${ex},${ey} Q${mx - px},${my - py + L * 0.1} ${tx},${ty}Z"/>`;
  }
  return `<g class="palm-sway" style="animation-delay:${-Math.abs(lean) / 10}s" fill="#26073d">${trunk}${d}</g>`;
}
$('#palms').innerHTML = palm(720, 620, 440, -50) + palm(560, 620, 300, 40) + palm(850, 620, 330, 25) + palm(430, 620, 190, -15);

(async function boot() {
  $('#tablist').replaceChildren(...TABS.map(([k, n]) => h('button', { class: 'tab', 'data-t': k, onclick: () => go(k) }, n)));
  try { T.env = await api.env(); } catch {}
  try {
    const st = await api.loadState();
    if (st) { Object.assign(S, { videos: st.videos || [], clips: st.clips || [], history: st.history || [], presets: st.presets || { sub: {}, head: {} }, settings: { ...DEF, ...(st.settings || {}) }, selVideo: st.selVideo, selClip: st.selClip, tab: 'home' }); }
  } catch {}
  // drop references to files that vanished
  for (const v of [...S.videos]) { if (!(await api.exists(v.path).catch(() => true))) { S.videos = S.videos.filter((x) => x !== v); S.clips = S.clips.filter((c) => c.videoId !== v.id); } }
  if (!S.videos.find((v) => v.id === S.selVideo)) { S.selVideo = S.videos[0]?.id || null; }
  if (!curClip()) S.selClip = null;
  applyTheme(); buildStage(); render(false); requestAnimationFrame(frame);
  window.__app = { S, T, go, render, runExport, V, addClip }; // debug handle
})();
