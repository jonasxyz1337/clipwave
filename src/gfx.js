'use strict';
// Motion graphics ("Einblender"). Drawn on a canvas in 1080x1920 units: the live preview draws them directly,
// the export renders each one to a transparent video (same code, so preview and export always match).
(function (g) {
  const W = 1080, H = 1920, FPS = 30, VERSION = 'g1';
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const eOut = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const eBack = (x) => { x = clamp(x); const c1 = 1.7, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  const SANS = '"Bahnschrift", "Segoe UI", "Segoe UI Emoji", sans-serif';
  const MONO = '"Consolas", "Courier New", "Segoe UI Emoji", monospace';
  const SERIF = '"Georgia", "Times New Roman", "Segoe UI Emoji", serif';
  const COLORS = { green: '#3ddc84', pink: '#ff4fd8', yellow: '#ffd23f', red: '#ff3b47', blue: '#4fa3ff', purple: '#a974ff', white: '#ffffff' };
  const CHAT_NAMES = ['#ff7ad9', '#7ee0ff', '#ffd23f', '#9cff8a', '#ffa25c', '#c59bff'];

  // entrance / exit envelope shared by all types
  const env = (lt, dur) => clamp(lt / 0.18) * clamp((dur - lt) / 0.22);
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  function fitFont(ctx, text, weight, size, family, maxW) {
    let s = size; ctx.font = `${weight} ${s}px ${family}`;
    while (s > 20 && ctx.measureText(text).width > maxW) { s -= 4; ctx.font = `${weight} ${s}px ${family}`; }
    return s;
  }
  function wrap(ctx, text, maxW) {
    const out = []; let cur = '';
    for (const w of String(text).split(/\s+/).filter(Boolean)) { const t = cur ? cur + ' ' + w : w; if (cur && ctx.measureText(t).width > maxW) { out.push(cur); cur = w; } else cur = t; }
    if (cur) out.push(cur); return out;
  }
  const col = (c) => COLORS[c] || c || COLORS.pink;
  const hms = (s) => { s = Math.max(0, Math.floor(s)); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };

  const TYPES = {
    // big punchy word (optionally italic serif like "why?")
    pop: {
      name: 'Big word', dur: 1.4, def: { text: 'INSANE 🤯', color: 'pink', style: 'bold', y: 0.42 },
      draw(ctx, it, lt, dur) {
        const a = env(lt, dur); if (a <= 0) return;
        const s = lt < 0.12 ? 0.3 + (1.15 - 0.3) * (lt / 0.12) : lt < 0.3 ? 1.15 - 0.15 * ((lt - 0.12) / 0.18) : 1 + 0.04 * ((lt - 0.3) / Math.max(0.1, dur - 0.3));
        const serif = it.style === 'serif';
        ctx.save(); ctx.globalAlpha = a; ctx.translate(it.x * W, it.y * H - 18 * clamp(lt / dur)); ctx.rotate(((serif ? 0 : -3) * Math.PI / 180) * (1 - eOut(lt / 0.3))); ctx.scale(s, s);
        const size = fitFont(ctx, it.text, serif ? 'italic 400' : '800', serif ? 140 : 128, serif ? SERIF : SANS, 960);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
        if (serif) { ctx.shadowColor = col(it.color); ctx.shadowBlur = 40; ctx.fillStyle = '#fff'; ctx.fillText(it.text, 0, 0); }
        else {
          ctx.shadowColor = col(it.color); ctx.shadowBlur = 0; ctx.shadowOffsetY = size * 0.08;
          ctx.lineWidth = size * 0.16; ctx.strokeStyle = '#000'; ctx.strokeText(it.text, 0, 0);
          ctx.shadowOffsetY = 0; ctx.fillStyle = '#fff'; ctx.fillText(it.text, 0, 0);
        }
        ctx.restore();
      },
    },
    // money / number counter counting up in a glowing box ("7 € → 6.215 €")
    counter: {
      name: 'Counter', dur: 2.5, def: { from: 0, to: 6215, prefix: '', suffix: ' €', color: 'green', y: 0.16 },
      draw(ctx, it, lt, dur) {
        const a = env(lt, dur); if (a <= 0) return;
        const p = eOut((lt - 0.15) / Math.max(0.3, dur * 0.65)), v = Math.round((+it.from || 0) + ((+it.to || 0) - (+it.from || 0)) * p);
        const txt = `${it.prefix || ''}${v.toLocaleString('de-DE')}${it.suffix || ''}`, c = col(it.color);
        ctx.save(); ctx.globalAlpha = a; ctx.translate(it.x * W, it.y * H); ctx.scale(eBack(lt / 0.35), eBack(lt / 0.35));
        ctx.font = `800 112px ${SANS}`; const w = Math.max(ctx.measureText(txt).width, 200) + 70, h = 150;
        const done = p >= 0.999 ? clamp((lt - 0.15 - dur * 0.65) / 0.4) : 0, pulse = done ? 1 + 0.06 * Math.sin(done * Math.PI) : 1;
        ctx.scale(pulse, pulse);
        ctx.shadowColor = c; ctx.shadowBlur = 30 + 30 * done; rr(ctx, -w / 2, -h / 2, w, h, 26); ctx.fillStyle = 'rgba(8,24,14,.88)'; ctx.fill();
        ctx.shadowBlur = 0; ctx.lineWidth = 5; ctx.strokeStyle = c; ctx.stroke();
        ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, 0, 6);
        ctx.restore();
      },
    },
    // red "LIVE SEIT 08:51:02" pill, the time keeps counting
    live: {
      name: 'LIVE badge', dur: 4, def: { text: 'LIVE SEIT', since: 0, y: 0.07 },
      draw(ctx, it, lt, dur) {
        const a = env(lt, dur); if (a <= 0) return;
        const txt = `${it.text || 'LIVE'} ${hms((+it.since || 0) + lt)}`;
        ctx.save(); ctx.globalAlpha = a; ctx.translate(it.x * W, it.y * H); const s = eBack(lt / 0.35); ctx.scale(s, s);
        ctx.font = `700 54px ${MONO}`; const w = ctx.measureText(txt).width + 130, h = 96;
        ctx.shadowColor = '#ff2a3a'; ctx.shadowBlur = 38; rr(ctx, -w / 2, -h / 2, w, h, 18); ctx.fillStyle = '#e5242f'; ctx.fill();
        ctx.shadowBlur = 0; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.stroke();
        ctx.globalAlpha = a * (0.55 + 0.45 * Math.abs(Math.cos(lt * Math.PI))); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-w / 2 + 50, 0, 13, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = a; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(txt, -w / 2 + 84, 3);
        ctx.restore();
      },
    },
    // live chat box, messages pop in one after another
    chat: {
      name: 'Live chat', dur: 5, def: { lines: 'user74: SPEEEED 😂 | vice_fan: W stream | kyros: LETS GOOO | lena.k: clip das!! | user12: KEKW | noah_2k: wie lang geht der stream noch 😅', y: 0.62 },
      draw(ctx, it, lt, dur) {
        const a = env(lt, dur); if (a <= 0) return;
        // real chat replay: messages carry their clip time `t`; otherwise typed lines are spread over the duration
        const real = Array.isArray(it.msgs) && it.msgs.length;
        const msgs = real
          ? it.msgs.map((m) => [m.name, m.text, m.color])
          : String(it.lines || '').split('|').map((m) => m.trim()).filter(Boolean).map((m) => { const i = m.indexOf(':'); return i > 0 ? [m.slice(0, i).trim(), m.slice(i + 1).trim()] : ['chat', m]; });
        if (!msgs.length) return;
        const ct = it.start + lt, step = Math.max(0.25, (dur * 0.75) / msgs.length);
        const shown = real ? it.msgs.filter((m) => m.t <= ct).length : clamp(Math.floor(lt / step) + 1, 1, msgs.length);
        if (!shown) return;
        const newestAt = real ? it.msgs[shown - 1].t : it.start + (shown - 1) * step;
        const vis = Math.min(clamp(Math.round(+it.rows || 6), 2, 12), shown), w = 900, lh = 64, h = vis * lh + 50;
        ctx.save(); ctx.globalAlpha = a; ctx.translate(it.x * W, it.y * H + 40 * (1 - eOut(lt / 0.3)));
        rr(ctx, -w / 2, -h / 2, w, h, 28); ctx.fillStyle = 'rgba(20,18,26,.9)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.stroke();
        ctx.save(); rr(ctx, -w / 2, -h / 2, w, h, 28); ctx.clip();
        const newest = clamp((ct - newestAt) / 0.25);
        msgs.slice(shown - vis, shown).forEach(([name, msg, color], i) => {
          const y = -h / 2 + 25 + lh * (i + 0.5) + (1 - eOut(newest)) * lh * (i === vis - 1 ? 1 : 0.0);
          ctx.globalAlpha = a * (i === vis - 1 ? newest : 1);
          ctx.font = `700 40px ${SANS}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
          const ni = [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % CHAT_NAMES.length; ctx.fillStyle = color || CHAT_NAMES[ni]; const nt = name + ': '; ctx.fillText(nt, -w / 2 + 34, y);
          const nw = ctx.measureText(nt).width; ctx.font = `500 40px ${SANS}`; ctx.fillStyle = '#fff';
          let m = msg; while (m.length > 1 && nw + ctx.measureText(m).width > w - 68) m = m.slice(0, -2) + '…';
          ctx.fillText(m, -w / 2 + 34 + nw, y);
        });
        ctx.restore(); ctx.restore();
      },
    },
    // neon outlined badge with a little wiggle ("GRATIS")
    badge: {
      name: 'Neon badge', dur: 2.5, def: { text: 'GRATIS', color: 'green', y: 0.3 },
      draw(ctx, it, lt, dur) {
        const a = env(lt, dur); if (a <= 0) return;
        const c = col(it.color);
        ctx.save(); ctx.globalAlpha = a; ctx.translate(it.x * W, it.y * H);
        ctx.rotate((-4 + 5 * Math.sin(lt * 9) * Math.exp(-lt * 3)) * Math.PI / 180); const s = eBack(lt / 0.35); ctx.scale(s, s);
        const size = fitFont(ctx, it.text, '800', 118, SANS, 860), w = ctx.measureText(it.text).width + 90, h = size * 1.35;
        ctx.shadowColor = c; ctx.shadowBlur = 34; rr(ctx, -w / 2, -h / 2, w, h, 22); ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fill();
        ctx.lineWidth = 8; ctx.strokeStyle = c; ctx.stroke(); ctx.stroke();
        ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(it.text, 0, size * 0.05);
        ctx.restore();
      },
    },
    // dark info panel with a colored tag ("Skill =  Zusatzwissen, das …")
    info: {
      name: 'Info panel', dur: 3, def: { tag: 'Skill =', text: 'Zusatzwissen, das Claude einen Job beibringt', color: 'red', y: 0.5 },
      draw(ctx, it, lt, dur) {
        const a = env(lt, dur); if (a <= 0) return;
        ctx.save(); ctx.globalAlpha = a; ctx.translate(it.x * W, it.y * H + 50 * (1 - eOut(lt / 0.35)));
        ctx.font = `700 40px ${MONO}`; const tag = it.tag || '', tw = tag ? ctx.measureText(tag).width + 40 : 0;
        ctx.font = `500 44px ${SANS}`; const lines = wrap(ctx, it.text || '', 900 - tw - 90).slice(0, 3);
        const tx = Math.max(...lines.map((l) => ctx.measureText(l).width), 0), w = Math.min(980, tw + tx + (tag ? 100 : 70)), h = Math.max(120, lines.length * 56 + 60);
        rr(ctx, -w / 2, -h / 2, w, h, 26); ctx.fillStyle = 'rgba(28,26,34,.92)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.stroke();
        let x = -w / 2 + 35;
        if (tag) { rr(ctx, x, -32, tw, 64, 10); ctx.fillStyle = col(it.color); ctx.fill(); ctx.font = `700 40px ${MONO}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(tag, x + tw / 2, 2); x += tw + 30; }
        ctx.font = `500 44px ${SANS}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        lines.forEach((l, i) => ctx.fillText(l, x, (i - (lines.length - 1) / 2) * 56 + 2));
        ctx.restore();
      },
    },
    // small white label with monospace text ("SO FUNKTIONIERT'S")
    label: {
      name: 'Label', dur: 2, def: { text: "SO FUNKTIONIERT'S", y: 0.3 },
      draw(ctx, it, lt, dur) {
        const a = env(lt, dur); if (a <= 0) return;
        ctx.save(); ctx.globalAlpha = a; ctx.translate(it.x * W, it.y * H); const s = eBack(lt / 0.3); ctx.scale(s, 1);
        const t = String(it.text || '').toUpperCase(); fitFont(ctx, t, '700', 50, MONO, 900);
        const w = ctx.measureText(t).width + 44, h = 74;
        rr(ctx, -w / 2, -h / 2, w, h, 6); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, 0, 3);
        ctx.restore();
      },
    },
  };

  const durOf = (it) => Math.max(0.3, it.end - it.start);
  // size: every graphic can be scaled around its own position
  function drawOne(ctx, it, lt) {
    const sc = clamp(+it.size || 1, 0.3, 2.5), cx = (it.x == null ? 0.5 : it.x) * W, cy = it.y * H;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    try { TYPES[it.type].draw(ctx, it, lt, durOf(it)); } finally { ctx.restore(); }
  }
  function make(type, start, clipDur, extra = {}) {
    const T = TYPES[type]; const end = Math.min(clipDur, start + T.dur);
    return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type, start: Math.max(0, Math.min(start, end - 0.3)), end, x: 0.5, ...JSON.parse(JSON.stringify(T.def)), ...extra };
  }
  // draws every graphic active at clip time t (preview; k = canvas scale)
  function drawAll(ctx, k, list, t) {
    for (const it of list || []) {
      if (t < it.start || t >= it.end || !TYPES[it.type]) continue;
      ctx.save(); ctx.scale(k, k); try { drawOne(ctx, it, t - it.start); } finally { ctx.restore(); }
    }
  }
  // cache key: everything that changes the pixels (not the position in time)
  // (real chat depends on the start time too: its messages are placed by clip time)
  const cacheKey = (it) => { const { id, start, end, auto, ...look } = it; return VERSION + JSON.stringify(look) + '|' + durOf(it).toFixed(2) + (it.msgs ? '|' + start.toFixed(2) : ''); };
  // renders one graphic to transparent PNG frames for the export
  async function render(it, sink) {
    const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d'), dur = durOf(it), n = Math.max(1, Math.round(dur * FPS));
    await sink.begin();
    try {
      for (let f = 0; f < n; f++) {
        ctx.clearRect(0, 0, W, H); drawOne(ctx, it, f / FPS);
        const blob = await cv.convertToBlob({ type: 'image/png' });
        await sink.frame(new Uint8Array(await blob.arrayBuffer()));
      }
    } finally { await sink.end(); }
  }

  g.Gfx = { TYPES, COLORS, make, drawAll, render, cacheKey, durOf };
})(window);
