'use strict';
// Rendered inside the app window: window.renderOutro(params, sink) draws every frame and hands it to sink.frame().
window.renderOutro = async function renderOutro(params, sink) {
// Motion-graphics outro, drawn frame by frame. Everything after the intro is periodic (period P),
// so the "loop" part can be repeated seamlessly to fill any outro length.
const W = 1080, H = 1920, FPS = 30, P = 3.5, T_INTRO = 2.5;
params = params || {};
const TITLE = (params.title || 'CLIPWAVE').toUpperCase().slice(0, 24);
const TAG = (params.sub || '').slice(0, 40);

const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
const ctx = cv.getContext('2d', { willReadFrequently: true });
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const eOutCubic = (x) => 1 - Math.pow(1 - clamp(x), 3);
const eInOutCubic = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const eOutExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(x)));
const eOutBack = (x) => { x = clamp(x); const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const lerp = (a, b, t) => a + (b - a) * t;
const FONT = '"Bahnschrift", "Segoe UI", Arial, sans-serif';

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = rng(7);
const particles = Array.from({ length: 90 }, () => ({ x: rnd() * W, y: rnd() * H, r: 1.2 + rnd() * 4.2, k: 1 + Math.floor(rnd() * 2), ph: rnd() * 6.283, a: 0.25 + rnd() * 0.6, pink: rnd() > 0.45 }));

// pre-rendered vignette
const vig = document.createElement('canvas'); vig.width = W; vig.height = H;
{ const v = vig.getContext('2d'); const g = v.createRadialGradient(W / 2, H * 0.45, H * 0.25, W / 2, H * 0.5, H * 0.75); g.addColorStop(0, 'rgba(10,0,25,0)'); g.addColorStop(1, 'rgba(10,0,25,.62)'); v.fillStyle = g; v.fillRect(0, 0, W, H); }
const tcv = document.createElement('canvas'); tcv.width = W; tcv.height = 420; const tctx = tcv.getContext('2d');

// title layout
const tsize = Math.min(176, Math.floor(900 / (TITLE.length * 0.66)));
tctx.font = `700 ${tsize}px ${FONT}`;
const track = tsize * 0.1;
const widths = [...TITLE].map((ch) => tctx.measureText(ch).width);
const totalW = widths.reduce((a, b) => a + b, 0) + track * (TITLE.length - 1);

const CX = W / 2, EY = 740, ER = 150, TY = 1090;

function draw(t) {
  const ph = (2 * Math.PI * t) / P;
  const ramp = eOutCubic((t - 2.0) / 0.5);
  const fadeIn = eOutCubic(t / 0.7);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.shadowBlur = 0;

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1d0836'); bg.addColorStop(0.5, '#3a1260'); bg.addColorStop(1, '#2a0c47');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // drifting light blobs (periodic)
  ctx.globalCompositeOperation = 'lighter';
  const blobs = [[255, 79, 216, 0.34, 0, 0.0, 1], [124, 58, 237, 0.42, 2.1, 1.7, 1], [255, 140, 235, 0.2, 4.2, 3.1, 1]];
  blobs.forEach(([r, g, b, a, pa, pb], i) => {
    const x = CX + 380 * Math.cos(ph + pa), y = 760 + 520 * Math.sin(ph + pb) * (i === 1 ? -1 : 1);
    const gr = ctx.createRadialGradient(x, y, 0, x, y, 820);
    gr.addColorStop(0, `rgba(${r},${g},${b},${a * fadeIn})`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  });

  // particles rising
  for (const p of particles) {
    const y = (((p.y - (p.k * H * t) / P) % H) + H) % H;
    const tw = 0.55 + 0.45 * Math.sin(ph * p.k + p.ph);
    const a = p.a * tw * fadeIn;
    const gr = ctx.createRadialGradient(p.x, y, 0, p.x, y, p.r * 4);
    const col = p.pink ? '255,120,230' : '190,160,255';
    gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = gr; ctx.fillRect(p.x - p.r * 4, y - p.r * 4, p.r * 8, p.r * 8);
  }
  ctx.globalCompositeOperation = 'source-over';

  // foreground group: gentle push-in during intro, breathing afterwards
  const sc = 1 + 0.07 * (1 - eOutCubic(t / T_INTRO)) + 0.005 * ramp * Math.sin(ph);
  ctx.save(); ctx.translate(CX, 960); ctx.scale(sc, sc); ctx.translate(-CX, -960);

  // ripples
  const rin = eOutCubic((t - 1.0) / 0.6);
  for (let j = 0; j < 2; j++) {
    const s = (((t / P) + j / 2) % 1 + 1) % 1;
    ctx.beginPath(); ctx.arc(CX, EY, ER + 30 + 560 * eOutCubic(s), 0, 6.2832);
    ctx.strokeStyle = `rgba(255,150,240,${0.38 * (1 - s) * rin})`; ctx.lineWidth = 3 + 3 * (1 - s); ctx.stroke();
  }

  // emblem disc + ring
  const discA = eOutCubic((t - 0.45) / 0.7);
  const dg = ctx.createRadialGradient(CX, EY, 0, CX, EY, ER);
  dg.addColorStop(0, `rgba(255,79,216,${0.38 * discA})`); dg.addColorStop(1, `rgba(124,58,237,${0.1 * discA})`);
  ctx.fillStyle = dg; ctx.beginPath(); ctx.arc(CX, EY, ER - 6, 0, 6.2832); ctx.fill();
  const p1 = eInOutCubic((t - 0.15) / 0.95);
  if (p1 > 0) {
    const rg = ctx.createLinearGradient(CX - ER, EY - ER, CX + ER, EY + ER); rg.addColorStop(0, '#ff6fe5'); rg.addColorStop(1, '#8b5cf6');
    ctx.save(); ctx.shadowColor = 'rgba(255,79,216,.9)'; ctx.shadowBlur = 34 + 14 * ramp * Math.sin(ph);
    ctx.lineWidth = 15; ctx.lineCap = 'round'; ctx.strokeStyle = rg;
    ctx.beginPath(); ctx.arc(CX, EY, ER, -Math.PI / 2, -Math.PI / 2 + 6.2832 * p1); ctx.stroke(); ctx.restore();
  }
  // play triangle
  const ts = eOutBack((t - 0.5) / 0.7);
  if (ts > 0) {
    ctx.save(); ctx.translate(CX + 9, EY); ctx.scale(ts, ts); ctx.shadowColor = 'rgba(255,79,216,.95)'; ctx.shadowBlur = 36;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(-36, -54); ctx.lineTo(62, 0); ctx.lineTo(-36, 54); ctx.closePath();
    ctx.lineJoin = 'round'; ctx.lineWidth = 10; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.fill(); ctx.restore();
  }

  // title letters on offscreen (staggered reveal + moving shine)
  tctx.clearRect(0, 0, tcv.width, tcv.height); tctx.font = `700 ${tsize}px ${FONT}`; tctx.textBaseline = 'alphabetic'; tctx.fillStyle = '#fff';
  const stagger = Math.min(0.07, 0.7 / TITLE.length);
  let x = (W - totalW) / 2;
  [...TITLE].forEach((ch, i) => {
    const e = eOutExpo((t - 0.95 - stagger * i) / 0.75);
    if (e > 0.001) { tctx.save(); tctx.globalAlpha = clamp(e * 1.4); tctx.translate(0, (1 - e) * 90); tctx.fillText(ch, x, 280); tctx.restore(); }
    x += widths[i] + track;
  });
  const sw = (((t / P) % 1) + 1) % 1;
  if (t >= 1.9 && sw < 0.5) {
    const bx = lerp(-300, W + 300, sw / 0.5);
    const g = tctx.createLinearGradient(bx - 140, 0, bx + 140, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,225,250,.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    tctx.globalCompositeOperation = 'source-atop'; tctx.fillStyle = g; tctx.fillRect(0, 0, W, 420); tctx.globalCompositeOperation = 'source-over';
  }
  ctx.save(); ctx.shadowColor = 'rgba(255,79,216,.85)'; ctx.shadowBlur = 46; ctx.drawImage(tcv, 0, TY - 280); ctx.shadowBlur = 0; ctx.drawImage(tcv, 0, TY - 280); ctx.restore();

  // underline sweeping out from the centre
  const ue = eInOutCubic((t - 1.45) / 0.6);
  if (ue > 0) {
    const ug = ctx.createLinearGradient(CX - 280, 0, CX + 280, 0); ug.addColorStop(0, '#ff4fd8'); ug.addColorStop(1, '#8b5cf6');
    ctx.save(); ctx.shadowColor = 'rgba(255,79,216,.9)'; ctx.shadowBlur = 18; ctx.fillStyle = ug;
    const w = 560 * ue; ctx.beginPath(); ctx.roundRect(CX - w / 2, TY + 44, w, 8, 4); ctx.fill(); ctx.restore();
  }

  // tagline
  if (TAG) {
    const e = eOutCubic((t - 1.75) / 0.65);
    if (e > 0) {
      ctx.save(); ctx.globalAlpha = e; ctx.font = `500 54px ${FONT}`; ctx.fillStyle = 'rgba(255,232,252,.95)'; ctx.textAlign = 'left';
      const tr = 10; const ws = [...TAG.toUpperCase()].map((c) => ctx.measureText(c).width); const tw = ws.reduce((a, b) => a + b, 0) + tr * (ws.length - 1);
      let tx = CX - tw / 2; const ty = TY + 150 + 34 * (1 - e);
      [...TAG.toUpperCase()].forEach((c, i) => { ctx.fillText(c, tx, ty); tx += ws[i] + tr; }); ctx.restore();
    }
  }

  // waveform bars (the "wave")
  const N = 29, BW = 12, GAP = 14, BASE = 1480, totalBars = N * (BW + GAP) - GAP;
  for (let i = 0; i < N; i++) {
    const d = Math.abs(i - (N - 1) / 2), env = 1 - 0.6 * Math.pow(d / 14, 1.4);
    const k = 1 + (i % 3), amp = 0.3 + 0.7 * Math.abs(Math.sin(ph * k + i * 0.9));
    const g = eOutBack((t - 0.75 - 0.03 * d) / 0.6);
    const h = Math.max(0, (22 + 190 * env * amp) * g);
    if (h <= 0.5) continue;
    const m = i / (N - 1), r = Math.round(lerp(255, 139, m)), gg = Math.round(lerp(79, 92, m)), b = Math.round(lerp(216, 246, m));
    ctx.save(); ctx.shadowColor = `rgba(${r},${gg},${b},.85)`; ctx.shadowBlur = 16; ctx.fillStyle = `rgb(${r},${gg},${b})`; ctx.globalAlpha = 0.95 * clamp(g * 2);
    ctx.beginPath(); ctx.roundRect(CX - totalBars / 2 + i * (BW + GAP), BASE - h, BW, h * 2, BW / 2); ctx.fill(); ctx.restore();
  }
  ctx.restore();

  ctx.drawImage(vig, 0, 0);
  const black = 1 - eOutCubic(t / 0.45); if (black > 0.002) { ctx.fillStyle = `rgba(0,0,0,${black})`; ctx.fillRect(0, 0, W, H); }
}

if (document.fonts && document.fonts.load) { await document.fonts.load(`700 100px ${FONT}`); await document.fonts.load(`500 54px ${FONT}`); }
const segs = [{ name: 'intro', from: 0, to: Math.round(T_INTRO * FPS) }, { name: 'loop', from: Math.round(T_INTRO * FPS), to: Math.round((T_INTRO + P) * FPS) }];
for (const s of segs) {
  await sink.begin(s.name);
  try {
    for (let f = s.from; f < s.to; f++) { draw(f / FPS); await sink.frame(new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer)); }
  } finally { await sink.end(); }
}
};
