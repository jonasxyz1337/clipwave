// Shared by renderer (live preview) and main (ffmpeg export): one source of truth for geometry + captions.
(function (g) {
  const W = 1080, H = 1920;

  const FONTS = {
    'Impact': ['impact.ttf'],
    'Arial Black': ['ariblk.ttf'],
    'Bahnschrift': ['bahnschrift.ttf'],
    'Segoe UI': ['segoeui.ttf', 'segoeuib.ttf'],
    'Segoe UI Black': ['seguibl.ttf'],
    'Trebuchet MS': ['trebuc.ttf', 'trebucbd.ttf'],
    'Verdana': ['verdana.ttf', 'verdanab.ttf'],
    'Georgia': ['georgia.ttf', 'georgiab.ttf'],
    'Comic Sans MS': ['comic.ttf', 'comicbd.ttf'],
    'Arial': ['arial.ttf', 'arialbd.ttf'],
    'Segoe UI Semibold': ['seguisb.ttf'],
  };

  const SUB_PRESETS = {
    'TikTok Box': { font: 'Segoe UI Semibold', size: 62, bold: false, uppercase: false, color: '#111111', hiColor: '#111111', impColor: '#111111', outlineColor: '#ffffff', outline: 0, shadow: 0, shadowColor: '#000000', mode: 'static', maxWords: 5, y: 0.72, scale: 100, box: true, boxColor: '#ffffff' },
    'Impact Pop': { font: 'Impact', size: 96, bold: false, uppercase: true, color: '#ffffff', hiColor: '#ffe14d', impColor: '#ff5ce1', outlineColor: '#000000', outline: 7, shadow: 3, shadowColor: '#000000', mode: 'highlight', maxWords: 3, y: 0.7, scale: 112 },
    'Neon Magenta': { font: 'Bahnschrift', size: 88, bold: true, uppercase: true, color: '#ffffff', hiColor: '#ff3df2', impColor: '#9be7ff', outlineColor: '#3b0a5c', outline: 6, shadow: 4, shadowColor: '#ff3df2', mode: 'highlight', maxWords: 3, y: 0.7, scale: 115 },
    'One Word Punch': { font: 'Arial Black', size: 130, bold: false, uppercase: true, color: '#ffffff', hiColor: '#ffffff', impColor: '#ffe14d', outlineColor: '#000000', outline: 8, shadow: 0, shadowColor: '#000000', mode: 'word', maxWords: 1, y: 0.62, scale: 100 },
    'Clean Minimal': { font: 'Segoe UI', size: 66, bold: true, uppercase: false, color: '#ffffff', hiColor: '#ffffff', impColor: '#ffd1f7', outlineColor: '#1a0826', outline: 3, shadow: 2, shadowColor: '#000000', mode: 'static', maxWords: 5, y: 0.78, scale: 100 },
    'Violet Karaoke': { font: 'Trebuchet MS', size: 80, bold: true, uppercase: false, color: '#e9d5ff', hiColor: '#ffffff', impColor: '#ff9df0', outlineColor: '#4c1d95', outline: 6, shadow: 3, shadowColor: '#2e1065', mode: 'highlight', maxWords: 4, y: 0.72, scale: 108 },
  };

  const HEAD_PRESETS = {
    'Bold Statement': { text: 'YOU WON\'T BELIEVE\nTHIS', font: 'Impact', size: 110, color: '#ffffff', outlineColor: '#000000', outline: 7, shadow: 4, box: false, boxColor: '#000000', y: 0.17, anim: 'pop', duration: 0 },
    'Neon Box': { text: 'WAIT FOR IT', font: 'Bahnschrift', size: 84, color: '#ffffff', outlineColor: '#d946ef', outline: 22, shadow: 0, box: true, boxColor: '#d946ef', y: 0.15, anim: 'pop', duration: 0 },
    'Clean Title': { text: 'Insane clutch', font: 'Segoe UI Black', size: 78, color: '#ffffff', outlineColor: '#2a0d3d', outline: 4, shadow: 3, box: false, boxColor: '#000000', y: 0.12, anim: 'fade', duration: 4 },
    'Clean Card': { text: 'Links abbiegen\n10 m', font: 'Segoe UI Semibold', size: 72, color: '#ffffff', outlineColor: '#000000', outline: 0, shadow: 0, box: false, card: true, boxColor: '#1d1d24', y: 0.14, anim: 'fade', duration: 0 },
    'Sticker': { text: 'LEGENDARY', font: 'Arial Black', size: 90, color: '#1a0826', outlineColor: '#ffe14d', outline: 20, shadow: 0, box: true, boxColor: '#ffe14d', y: 0.16, anim: 'pop', duration: 0 },
  };

  const DEFAULT_LAYOUT = { mode: 'stack', camPos: 'bottom', camHeight: 0.36, gpZoom: 1, gpX: 0.5, gpY: 0.5, camX: 0.85, camY: 0.8, camSize: 0.26, pipSize: 0.4, pipX: 0.95, pipY: 0.06 };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function cropFor(bw, bh, sw, sh, zoom, px, py) {
    let ch = sh / zoom, cw = (ch * bw) / bh;
    if (cw > sw) { cw = sw; ch = (cw * bh) / bw; }
    return { x: Math.round((sw - cw) * px), y: Math.round((sh - ch) * py), w: Math.floor(cw), h: Math.floor(ch) };
  }
  function camCrop(bw, bh, sw, sh, size, cx, cy) {
    let cw = size * sw, ch = (cw * bh) / bw;
    if (ch > sh) { ch = sh; cw = (ch * bw) / bh; }
    return { x: Math.round((sw - cw) * cx), y: Math.round((sh - ch) * cy), w: Math.floor(cw), h: Math.floor(ch) };
  }

  // -> { boxes:[{role,dx,dy,dw,dh,crop}] } in 1080x1920 canvas space
  function computeLayout(L, sw, sh) {
    const boxes = [];
    if (L.mode === 'full') {
      boxes.push({ role: 'game', dx: 0, dy: 0, dw: W, dh: H, crop: cropFor(W, H, sw, sh, L.gpZoom, L.gpX, L.gpY) });
    } else if (L.mode === 'pip') {
      boxes.push({ role: 'game', dx: 0, dy: 0, dw: W, dh: H, crop: cropFor(W, H, sw, sh, L.gpZoom, L.gpX, L.gpY) });
      const dw = even(W * L.pipSize), dh = even(dw * 0.75);
      boxes.push({ role: 'cam', dx: Math.round((W - dw) * L.pipX), dy: Math.round((H - dh) * L.pipY), dw, dh, crop: camCrop(dw, dh, sw, sh, L.camSize, L.camX, L.camY) });
    } else {
      const ch = even(H * L.camHeight), gh = H - ch;
      const top = L.camPos === 'top';
      boxes.push({ role: 'game', dx: 0, dy: top ? ch : 0, dw: W, dh: gh, crop: cropFor(W, gh, sw, sh, L.gpZoom, L.gpX, L.gpY) });
      boxes.push({ role: 'cam', dx: 0, dy: top ? 0 : gh, dw: W, dh: ch, crop: camCrop(W, ch, sw, sh, L.camSize, L.camX, L.camY) });
    }
    return { boxes };
  }

  function filterGraph(L, sw, sh, input = '0:v') {
    const { boxes } = computeLayout(L, sw, sh);
    const game = boxes[0], cam = boxes[1];
    const c = (b) => `crop=${b.crop.w}:${b.crop.h}:${b.crop.x}:${b.crop.y},scale=${b.dw}:${b.dh}:flags=lanczos,setsar=1`;
    let f = cam ? `[${input}]split=2[a][b];[a]${c(game)},pad=${W}:${H}:${game.dx}:${game.dy}:black[bg];[b]${c(cam)}[cam];[bg][cam]overlay=${cam.dx}:${cam.dy}` : `[${input}]${c(game)}`;
    if (L.filter === 'bw') f += ',hue=s=0';
    else if (L.filter === 'bwc') f += ',hue=s=0,eq=contrast=1.3:brightness=-0.03';
    return f;
  }

  // ---------- facecam zoom: cut to a 9:16 close-up of the facecam with a quick push-in ----------
  // source-pixel rectangle around the facecam (null when the layout has no facecam)
  function camZoomRect(L, sw, sh) {
    const cam = computeLayout(L, sw, sh).boxes.find((b) => b.role === 'cam'); if (!cam) return null;
    const c = cam.crop, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let h = Math.min(sh, c.h * 1.15), w = (h * 9) / 16;
    if (w > sw) { w = sw; h = (w * 16) / 9; }
    w = even(w); h = even(h);
    return { x: even(clamp(cx - w / 2, 0, sw - w)), y: even(clamp(cy - h / 2, 0, sh - h)), w, h };
  }
  const camZoomAt = (f, t) => 1 + ((f.amount == null ? 12 : f.amount) / 100) * clamp((t - f.start) / 0.35, 0, 1);
  // overlays the close-ups on `inLabel`; `srcLabels[i]` are copies of the source video
  function camZoomGraph(list, inLabel, srcLabels, L, sw, sh, fps) {
    const r = camZoomRect(L, sw, sh); let cur = inLabel; const parts = [];
    if (!r) return { graph: '', out: cur };
    list.forEach((f, i) => {
      const A = ((f.amount == null ? 12 : f.amount) / 100).toFixed(3), S = Math.max(0, f.start).toFixed(3), E = Math.max(f.end, f.start + 0.05).toFixed(3);
      parts.push(`[${srcLabels[i]}]crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${W}:${H}:flags=lanczos,setsar=1,zoompan=z='1+${A}*clip((it-${S})/0.35\\,0\\,1)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=${fps},setsar=1[czo${i}]`,
        `[${cur}][czo${i}]overlay=0:0:enable='between(t\\,${S}\\,${E})'[czv${i}]`);
      cur = `czv${i}`;
    });
    return { graph: parts.join(';'), out: cur };
  }

  // ---------- captions ----------
  function autoImportant(words) {
    return words.map((w) => {
      const t = w.w.replace(/[^\p{L}\p{N}]/gu, '');
      return { ...w, imp: t.length >= 7 || /\d/.test(t) || (t.length >= 2 && t === t.toUpperCase() && /\p{L}/u.test(t)) };
    });
  }

  function groupWords(words, maxWords) {
    const groups = []; let cur = [];
    words.forEach((w, i) => {
      cur.push(w);
      const next = words[i + 1];
      if (!next || cur.length >= maxWords || /[.!?…]$/.test(w.w) || next.s - w.e > 0.7) { groups.push(cur); cur = []; }
    });
    return groups;
  }

  // events: [{s,e,group,idx}] idx = active word in group (-1 for static)
  function subEvents(words, sub) {
    const ev = [];
    if (!words || !words.length) return ev;
    const off = sub.offset == null ? -0.15 : sub.offset;
    words = words.map((w) => ({ ...w, s: Math.max(0, w.s + off), e: Math.max(0.05, w.e + off) }));
    const groups = groupWords(words, sub.mode === 'word' ? 1 : sub.maxWords);
    groups.forEach((grp, gi) => {
      const nextStart = groups[gi + 1] ? groups[gi + 1][0].s : Infinity;
      const last = grp[grp.length - 1];
      const gEnd = Math.min(nextStart, Math.max(last.e, last.s + 0.2) + 0.12);
      if (sub.mode === 'static') { ev.push({ s: grp[0].s, e: gEnd, group: grp, idx: -1 }); return; }
      grp.forEach((w, i) => {
        const e = i < grp.length - 1 ? grp[i + 1].s : gEnd;
        ev.push({ s: w.s, e: Math.max(e, w.s + 0.05), group: grp, idx: sub.mode === 'word' ? 0 : i });
      });
    });
    return ev;
  }

  const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0').toUpperCase();
  function bgr(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || '') || [0, 'ffffff']; const s = m[1]; return (s.slice(4, 6) + s.slice(2, 4) + s.slice(0, 2)).toUpperCase(); }
  const ac = (hex, a = 0) => `&H${hex2(a)}${bgr(hex)}`;
  const tc = (hex) => `\\c&H${bgr(hex)}&`;
  function ts(t) {
    t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  }
  const esc = (s) => s.replace(/[{}\\]/g, '');
  const disp = (w, sub) => esc(sub.uppercase ? w.toUpperCase() : w);

  function wrapHeadline(text, size, font) {
    const maxChars = Math.max(6, Math.floor(960 / (size * (font === 'Impact' ? 0.45 : 0.56))));
    const out = [];
    text.split(/\r?\n/).forEach((line) => {
      let cur = '';
      line.split(/\s+/).filter(Boolean).forEach((w) => {
        if ((cur + ' ' + w).trim().length > maxChars && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
      });
      out.push(cur);
    });
    return out.filter((l) => l !== undefined);
  }


  // rounded "card" headline: first line big, further lines smaller; shared by preview + export
  function cardGeom(head) {
    const raw = wrapHeadline(head.text, head.size, head.font), cw = (t, sz) => t.length * sz * 0.5;
    const lines = raw.map((t, i) => ({ t, sz: i === 0 ? head.size : Math.round(head.size * 0.78) }));
    const pad = Math.round(head.size * 0.42), gap = Math.round(head.size * 0.12);
    const w = Math.min(W - 80, Math.round(Math.max(...lines.map((l) => cw(l.t, l.sz))) + pad * 2));
    const h = Math.round(lines.reduce((a, l) => a + l.sz * 1.15, 0) + gap * (lines.length - 1) + pad * 1.4);
    const x = Math.round((W - w) / 2), y = Math.round(head.y * H - h / 2), r = Math.round(head.size * 0.38);
    let cy = y + pad * 0.7; lines.forEach((l) => { l.x = x + pad; l.y = Math.round(cy + (l.sz * 1.15) / 2); cy += l.sz * 1.15 + gap; });
    return { x, y, w, h, r, lines };
  }
  const roundPath = (w, h, r) => { const c = r * 0.45; return `m ${r} 0 l ${w - r} 0 b ${w - c} 0 ${w} ${c} ${w} ${r} l ${w} ${h - r} b ${w} ${h - c} ${w - c} ${h} ${w - r} ${h} l ${r} ${h} b ${c} ${h} 0 ${h - c} 0 ${h - r} l 0 ${r} b 0 ${c} ${c} 0 ${r} 0`; };

  // line breaking + box sizes for boxed subtitles (same estimate for preview and export)
  const textW = (t, size) => [...t].reduce((a, ch) => a + (/[A-ZÄÖÜMW@%&]/.test(ch) ? 0.66 : /[il.,:;'!|]/.test(ch) ? 0.27 : ch === ' ' ? 0.27 : 0.49), 0) * size;
  function subBoxLines(words, sub, cy) {
    const sz = sub.size, padX = Math.round(sz * 0.38), lh = Math.round(sz * 1.32), maxW = 900;
    const rows = [[]];
    words.forEach((w, i) => { const row = rows[rows.length - 1]; const cand = [...row.map((j) => words[j]), w].join(' '); if (row.length && textW(cand, sz) > maxW) rows.push([i]); else row.push(i); });
    let y = Math.round(cy - (rows.length * lh) / 2), out = [];
    rows.forEach((row) => { const w = Math.round(textW(row.map((j) => words[j]).join(' '), sz) + padX * 2); out.push({ from: row[0], to: row[row.length - 1] + 1, x: Math.round((W - w) / 2), y, w, h: lh }); y += lh - Math.round(sz * 0.06); });
    return { lines: out, r: Math.round(sz * 0.3) };
  }

  function buildAss({ words, dur, sub, head, showSubs = true, showHead = true }) {
    const lines = [];
    lines.push('[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '');
    lines.push('[V4+ Styles]', 'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding');
    lines.push(`Style: Sub,${sub.font},${sub.size},${ac(sub.color)},${ac(sub.color)},${ac(sub.outlineColor)},${ac(sub.shadowColor, 60)},${sub.bold ? -1 : 0},0,0,0,100,100,0,0,1,${sub.outline},${sub.shadow},5,40,40,40,1`);
    const hb = head.box;
    lines.push(`Style: Head,${head.font},${head.size},${ac(head.color)},${ac(head.color)},${ac(head.outlineColor)},${ac('#000000', hb ? 255 : 80)},${hb ? 0 : -1},0,0,0,100,100,0,0,${hb ? 3 : 1},${head.outline},${hb ? 0 : head.shadow},5,60,60,40,1`);
    lines.push('', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text');

    if (showSubs && words && words.length) {
      const y = Math.round(sub.y * H);
      for (const ev of subEvents(words, sub)) {
        let text = ev.group.map((w, j) => {
          const t = disp(w.w, sub);
          const active = j === ev.idx;
          if (sub.mode === 'word') return `{\\fscx70\\fscy70\\t(0,90,\\fscx${sub.scale}\\fscy${sub.scale})\\t(90,170,\\fscx100\\fscy100)${tc(w.imp ? sub.impColor : sub.color)}}${t}`;
          if (active) return `{${tc(sub.hiColor)}\\fscx${sub.scale}\\fscy${sub.scale}}${t}{\\r}`;
          if (w.imp) return `{${tc(sub.impColor)}}${t}{\\r}`;
          return t;
        });
        if (sub.box) {
          // TikTok look: every line sits in its own rounded box
          const g = subBoxLines(ev.group.map((w) => (sub.uppercase ? w.w.toUpperCase() : w.w)), sub, y);
          g.lines.forEach((ln) => {
            lines.push(`Dialogue: 0,${ts(ev.s)},${ts(ev.e)},Sub,,0,0,0,,{\\an7\\pos(${ln.x},${ln.y})\\bord0\\shad0\\1c&H${bgr(sub.boxColor || '#ffffff')}&\\p1}${roundPath(ln.w, ln.h, g.r)}`);
            lines.push(`Dialogue: 1,${ts(ev.s)},${ts(ev.e)},Sub,,0,0,0,,{\\an5\\pos(${W / 2},${ln.y + ln.h / 2})\\bord0\\shad0}${text.slice(ln.from, ln.to).join(' ')}`);
          });
          continue;
        }
        text = text.join(' ');
        lines.push(`Dialogue: 0,${ts(ev.s)},${ts(ev.e)},Sub,,0,0,0,,{\\an5\\pos(${W / 2},${y})}${text}`);
      }
    }
    if (showHead && head.text && head.text.trim()) {
      const hy = Math.round(head.y * H);
      const end = head.duration > 0 ? Math.min(head.duration, dur) : dur;
      const anim = head.anim === 'pop' ? '\\fscx70\\fscy70\\t(0,200,\\fscx106\\fscy106)\\t(200,320,\\fscx100\\fscy100)\\fad(120,0)' : head.anim === 'fade' ? '\\fad(350,350)' : '';
      if (head.card) {
        const g = cardGeom(head), fd = head.anim === 'none' ? '' : '\\fad(200,250)';
        lines.push(`Dialogue: 1,${ts(0)},${ts(end)},Head,,0,0,0,,{\\an7\\pos(${g.x},${g.y})\\bord0\\shad0\\1c&H${bgr(head.boxColor)}&\\1a&H26&${fd}\\p1}${roundPath(g.w, g.h, g.r)}`);
        g.lines.forEach((l, i) => lines.push(`Dialogue: 2,${ts(0)},${ts(end)},Head,,0,0,0,,{\\an4\\pos(${l.x},${l.y})\\fs${l.sz}\\bord0\\shad0\\b${i === 0 ? 1 : 0}${i ? '\\1a&H30&' : ''}${fd}}${esc(l.t)}`));
        return lines.join('\n') + '\n';
      }
      const txt = wrapHeadline(head.text, head.size, head.font).map(esc).join('\\N');
      lines.push(`Dialogue: 1,${ts(0)},${ts(end)},Head,,0,0,0,,{\\an5\\pos(${W / 2},${hy})${anim}}${txt}`);
    }
    return lines.join('\n') + '\n';
  }


  // ---------- timed effect boxes (pixelate / blur / black&white) ----------
  const ev2 = (n) => Math.round(n / 2) * 2;
  function fxRect(f) {
    const w = Math.max(16, ev2(clamp(f.w, 16, W))), h = Math.max(16, ev2(clamp(f.h, 16, H)));
    return { x: clamp(ev2(f.x), 0, W - w), y: clamp(ev2(f.y), 0, H - h), w, h };
  }
  // chains effects on a labelled video stream; returns { graph, out } (graph is '' when there are none)
  function fxGraph(list, inLabel) {
    let cur = inLabel; const parts = [];
    (list || []).filter((f) => f.type !== 'camzoom').forEach((f, i) => {
      const r = fxRect(f), crop = `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
      let eff;
      if (f.type === 'pixelate') { const a = Math.max(2, Math.round(f.amount || 28)); eff = `${crop},scale=${Math.max(1, Math.ceil(r.w / a))}:${Math.max(1, Math.ceil(r.h / a))}:flags=area,scale=${r.w}:${r.h}:flags=neighbor`; }
      else if (f.type === 'blur') eff = `${crop},gblur=sigma=${((f.amount || 24) * 0.5).toFixed(1)}:steps=2`;
      else eff = `${crop},hue=s=0`;
      const s0 = Math.max(0, f.start).toFixed(3), e0 = Math.max(f.end, f.start + 0.05).toFixed(3);
      parts.push(`[${cur}]split[fa${i}][fb${i}];[fb${i}]${eff}[fp${i}];[fa${i}][fp${i}]overlay=${r.x}:${r.y}:enable='between(t\\,${s0}\\,${e0})'[fx${i}]`);
      cur = `fx${i}`;
    });
    return { graph: parts.join(';'), out: cur };
  }

  // ---------- hook: a short teaser of the clip's highlight, played before the clip starts ----------
  const DEFAULT_HOOK = { on: false, start: 0, len: 2.5, text: '', flash: true };
  const HOOK_STYLE = { font: 'Bahnschrift', size: 104, y: 0.42, color: '#ffffff', outline: '#ff4fd8' };
  // the teaser window inside the clip (clip-relative seconds), or null when the hook is off
  function hookWindow(hk, clipDur) {
    if (!hk || !hk.on || clipDur < 2) return null;
    const len = clamp(Math.round((hk.len || 2.5) * 10) / 10, 1, Math.min(5, clipDur - 0.5));
    return { start: clamp(hk.start || 0, 0, clipDur - len), len };
  }
  // label shown over the teaser ("WAIT FOR IT…"): pops in, then pulses gently
  function buildHookAss(hk, len) {
    const st = HOOK_STYLE, txt = esc((hk.text || '').trim());
    const L = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]', 'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      `Style: Hook,${st.font},${st.size},${ac(st.color)},${ac(st.color)},${ac(st.outline)},${ac('#000000', 90)},-1,0,0,0,100,100,2,0,1,9,5,5,60,60,40,1`, '',
      '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'];
    if (txt) L.push(`Dialogue: 1,${ts(0)},${ts(len)},Hook,,0,0,0,,{\\an5\\pos(${W / 2},${Math.round(st.y * H)})\\fscx40\\fscy40\\t(0,180,\\fscx112\\fscy112)\\t(180,300,\\fscx100\\fscy100)\\t(600,${Math.round(len * 1000)},\\fscx108\\fscy108)}${txt}`);
    return L.join('\n') + '\n';
  }

  // ---------- outro ----------
  const DEFAULT_OUTRO = { on: false, mode: 'pad', seconds: 4, title: 'CLIPWAVE', sub: 'Follow for more' };
  // pad = fill the video up to one minute (3..30 s outro); fixed = exact seconds
  function outroDuration(o, clipDur) {
    if (!o || !o.on) return 0;
    if (o.mode === 'fixed') return clamp(Math.round(o.seconds * 10) / 10, 2, 30);
    return clamp(Math.round((60 - clipDur) * 10) / 10, 3, 30);
  }
  const CIRCLE = 'm 50 0 b 50 27.6 27.6 50 0 50 b -27.6 50 -50 27.6 -50 0 b -50 -27.6 -27.6 -50 0 -50 b 27.6 -50 50 -27.6 50 0';
  function buildOutroAss(o, dur) {
    const L = [];
    const title = esc(o.title || 'CLIPWAVE').toUpperCase(), sub = esc(o.sub || '');
    L.push('[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '');
    L.push('[V4+ Styles]', 'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding');
    L.push(`Style: Title,Bahnschrift,${title.length > 9 ? 120 : 160},&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,-1,0,0,0,100,100,10,0,1,0,0,5,40,40,40,1`);
    L.push(`Style: Sub,Bahnschrift,58,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,6,0,1,0,0,5,40,40,40,1`);
    L.push(`Style: Shape,Bahnschrift,40,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`);
    L.push('', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text');
    const cx = W / 2, cy = 720;
    // expanding rings, repeating for the whole outro
    for (let t = 0.1, n = 0; t < dur - 0.6; t += 0.9, n++) {
      const e = Math.min(dur, t + 2.6);
      L.push(`Dialogue: 0,${ts(t)},${ts(e)},Shape,,0,0,0,,{\\an5\\pos(${cx},${cy})\\p1\\1a&HFF&\\3c&HFFFFFF&\\3a&H50&\\bord${n % 2 ? 4 : 7}\\fscx30\\fscy30\\t(0,2600,\\fscx${n % 2 ? 1000 : 1300}\\fscy${n % 2 ? 1000 : 1300}\\3a&HFF&)}${CIRCLE}`);
    }
    // soft pulsing disc behind the play icon
    L.push(`Dialogue: 0,${ts(0)},${ts(dur)},Shape,,0,0,0,,{\\an5\\pos(${cx},${cy})\\p1\\bord0\\1c&HFFFFFF&\\1a&HC8&\\fscx0\\fscy0\\t(0,700,\\fscx340\\fscy340)\\t(700,1500,\\fscx320\\fscy320)\\blur30}${CIRCLE}`);
    // play icon pops in with overshoot
    L.push(`Dialogue: 2,${ts(0.15)},${ts(dur)},Shape,,0,0,0,,{\\an5\\pos(${cx + 8},${cy})\\p1\\bord0\\1c&HFFFFFF&\\fscx0\\fscy0\\t(0,450,\\fscx125\\fscy125)\\t(450,750,\\fscx100\\fscy100)}m -42 -58 l 70 0 l -42 58`);
    // glow + crisp title
    const ty = 1010;
    L.push(`Dialogue: 1,${ts(0.35)},${ts(dur)},Title,,0,0,0,,{\\an5\\pos(${cx},${ty})\\blur28\\bord14\\3c&HFF4FD8&\\1a&H90&\\3a&H60&\\fsp60\\alpha&HFF&\\fscx88\\fscy88\\t(0,1000,\\fsp10\\alpha&H00&\\fscx100\\fscy100)}${title}`);
    L.push(`Dialogue: 2,${ts(0.35)},${ts(dur)},Title,,0,0,0,,{\\an5\\pos(${cx},${ty})\\fsp60\\alpha&HFF&\\fscx88\\fscy88\\t(0,1000,\\fsp10\\alpha&H00&\\fscx100\\fscy100)}${title}`);
    // underline sweeps in
    L.push(`Dialogue: 2,${ts(1.0)},${ts(dur)},Shape,,0,0,0,,{\\an5\\pos(${cx},${ty + 105})\\p1\\bord0\\1c&HD84FFF&\\fscx0\\t(0,700,\\fscx100)}m -260 0 l 260 0 l 260 7 l -260 7`);
    if (sub) L.push(`Dialogue: 2,${ts(1.3)},${ts(dur)},Sub,,0,0,0,,{\\an5\\pos(${cx},${ty + 190})\\fad(600,0)\\fsp2\\t(0,900,\\fsp8)}${sub}`);
    return L.join('\n') + '\n';
  }

  const api = { camZoomRect, camZoomAt, camZoomGraph, subBoxLines, textW, DEFAULT_HOOK, HOOK_STYLE, hookWindow, buildHookAss, cardGeom, fxRect, fxGraph, DEFAULT_OUTRO, outroDuration, buildOutroAss, W, H, FONTS, SUB_PRESETS, HEAD_PRESETS, DEFAULT_LAYOUT, clone, clamp, computeLayout, filterGraph, autoImportant, groupWords, subEvents, buildAss, wrapHeadline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.Shared = api;
})(typeof window !== 'undefined' ? window : globalThis);
