'use strict';
// Bridge between the UI and the Rust backend (Tauri). Exposes the same `api` object the UI always used.
// The ffmpeg graph + captions are built here with Shared (the same code that draws the live preview).
(function () {
  const TA = window.__TAURI__;
  const asError = (e) => (e instanceof Error ? e : new Error(typeof e === 'string' ? e : (e && e.message) || String(e)));
  const inv = (cmd, args) => TA.core.invoke(cmd, args).catch((e) => { throw asError(e); });

  const listeners = [];
  const fire = (d) => listeners.forEach((f) => { try { f(d); } catch (e) { console.error(e); } });
  TA.event.listen('evt', (e) => fire(e.payload));
  let dropCb = null;
  TA.event.listen('tauri://drag-drop', (e) => { const p = e.payload && e.payload.paths && e.payload.paths[0]; if (p && dropCb) dropCb(p); });

  // ---------- outro: draw frames on a canvas, Rust pipes them into ffmpeg (cached per title/tagline) ----------
  async function ensureOutro(o) {
    const f = await inv('outro_paths', { title: o.title || '', sub: o.sub || '' });
    if (f.cached) return f;
    await window.renderOutro({ title: o.title, sub: o.sub }, {
      begin: (name) => inv('enc_begin', { path: f[name], kind: 'rgba' }),
      frame: (rgba) => TA.core.invoke('enc_frame', rgba).catch((e) => { throw asError(e); }),
      end: () => inv('enc_end'),
    });
    return f;
  }

  // ---------- motion graphics: each one rendered once to a transparent video (cached by its look) ----------
  async function ensureGfx(list, onProgress) {
    const out = [];
    for (const [i, it] of (list || []).filter((x) => Gfx.TYPES[x.type] && x.end > x.start).entries()) {
      const f = await inv('gfx_path', { key: Gfx.cacheKey(it) });
      if (!f.cached) {
        onProgress && onProgress(i);
        await Gfx.render(it, {
          begin: () => inv('enc_begin', { path: f.path, kind: 'png' }),
          frame: (png) => TA.core.invoke('enc_frame', png).catch((e) => { throw asError(e); }),
          end: () => inv('enc_end'),
        });
      }
      out.push({ path: f.path, start: it.start, end: it.end });
    }
    return out;
  }

  // ---------- one export job -> ffmpeg spec ----------
  const fmtA = 'aformat=channel_layouts=stereo:sample_rates=48000';
  const fwd = (f) => f.replace(/\\/g, '/').replace(/'/g, "'\\''");

  async function buildSpec(job, seg, gfxSegs = []) {
    const { sub, head, layout, words } = job;
    const dur = job.end - job.start, od = job.outroDur || 0, hk = job.hook, hl = hk ? hk.len : 0;
    const fps = job.fps || 30, d3 = dur.toFixed(3);
    const sounds = [];
    for (const x of job.sounds || []) if (x && x.path && (await inv('fs_exists', { path: x.path }))) sounds.push(x);
    const origVol = job.origVol == null ? 1 : job.origVol;
    const g = [], extraIn = [];
    const files = {};

    // video: layout -> facecam zooms -> timed effect boxes -> captions -> motion graphics
    const cz = (job.fx || []).filter((f) => f.type === 'camzoom' && f.end > f.start);
    const czOk = cz.length && Shared.camZoomRect(layout, job.w, job.h);
    let src = '0:v';
    if (czOk) { g.push(`[0:v]split=${cz.length + 1}[src]${cz.map((_, i) => `[czs${i}]`).join('')}`); src = 'src'; }
    g.push(`${Shared.filterGraph(layout, job.w, job.h, src)}[vc]`);
    const czg = czOk ? Shared.camZoomGraph(cz, 'vc', cz.map((_, i) => `czs${i}`), layout, job.w, job.h, Math.round(job.srcFps || 30)) : { graph: '', out: 'vc' };
    if (czg.graph) g.push(czg.graph);
    const fx = Shared.fxGraph(job.fx || [], czg.out);
    if (fx.graph) g.push(fx.graph);
    g.push(`[${fx.out}]ass=subs.ass:fontsdir=fonts[vs]`);
    // graphics are extra inputs after outro (+voice) and sounds
    const gfxBase = 1 + (od ? 1 : 0) + (od && seg && seg.voice ? 1 : 0) + sounds.length;
    let gcur = 'vs';
    gfxSegs.forEach((gs, i) => {
      const S = gs.start.toFixed(3), E = gs.end.toFixed(3);
      g.push(`[${gfxBase + i}:v]setpts=PTS-STARTPTS+${S}/TB,format=rgba[gf${i}]`, `[${gcur}][gf${i}]overlay=0:0:eof_action=pass:enable='between(t\\,${S}\\,${E})'[gv${i}]`);
      gcur = `gv${i}`;
    });
    // headline is its own layer: added after the hook teaser is cut, so the teaser shows no headline
    const headIn = hk ? '' : 'ass=head.ass:fontsdir=fonts,';
    g.push(`[${gcur}]${headIn}format=yuv420p${od ? `,fps=${fps},setsar=1` : ''}[va]`);

    // hook: teaser = a piece of the finished clip (captions included) with a label, then a white flash into the clip
    let vcur = 'va';
    if (hk) {
      files['hook.ass'] = Shared.buildHookAss(hk, hl);
      const hs = hk.start.toFixed(3), L = hl.toFixed(3);
      const flashOut = hk.flash ? `,fade=t=out:st=${Math.max(0, hl - 0.12).toFixed(3)}:d=0.12:color=white` : '';
      const flashIn = hk.flash ? 'fade=t=in:st=0:d=0.25:color=white' : 'null';
      g.push(`[va]split[vmain][vh0]`, `[vh0]trim=start=${hs}:duration=${L},setpts=PTS-STARTPTS,ass=hook.ass:fontsdir=fonts${flashOut}[vh]`, `[vmain]ass=head.ass:fontsdir=fonts,${flashIn}[vm]`, '[vh][vm]concat=n=2:v=1:a=0[vhk]');
      vcur = 'vhk';
    }

    // outro (video + its own audio)
    let outroAudio = [], vmap = `[${vcur}]`, nextIn = 1;
    if (od) {
      const loops = Math.max(1, Math.ceil((od - 2.5) / 3.5) + 1);
      files['outro.txt'] = [`file '${fwd(seg.intro)}'`, ...Array.from({ length: loops }, () => `file '${fwd(seg.loop)}'`)].join('\n');
      const D = od.toFixed(2), t0 = Math.max(0, od - 0.45).toFixed(2), hasVoice = !!seg.voice;
      extraIn.push('-t', D, '-f', 'concat', '-safe', '0', '-i', 'outro.txt'); nextIn = 2;
      if (hasVoice) { extraIn.push('-i', seg.voice); nextIn = 3; }
      g.push(`[1:v]trim=duration=${D},setpts=PTS-STARTPTS,fps=${fps},fade=t=out:st=${t0}:d=0.45,format=yuv420p,setsar=1[vb]`, `[${vcur}][vb]concat=n=2:v=1:a=0[v]`);
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

    // audio: original track + user sounds (trimmed, timed, faded)
    let amap;
    if (!(od || hk || sounds.length || origVol !== 1)) amap = '0:a:0?';
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
      if (hk) {
        g.push(`[${aOut}]asplit[amain][ah0]`, `[ah0]atrim=start=${hk.start.toFixed(3)}:duration=${hl.toFixed(3)},asetpts=N/SR/TB[ah]`, '[ah][amain]concat=n=2:v=0:a=1[ahk]');
        aOut = 'ahk';
      }
      if (od) { g.push(...outroAudio, `[${aOut}][ao]concat=n=2:v=0:a=1[a]`); amap = '[a]'; }
      else amap = `[${aOut}]`;
    }

    gfxSegs.forEach((gs) => extraIn.push('-i', gs.path));
    const base = ['-y', '-hide_banner', '-ss', String(job.start), '-t', String(dur), '-i', job.videoPath, ...extraIn, '-filter_complex', g.join(';'), '-map', vmap, '-map', amap];
    const tail = [...(job.fps && !od ? ['-r', String(job.fps)] : []), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', job.out];
    const enc = {
      nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', String(job.crf), '-b:v', '0'],
      x264: ['-c:v', 'libx264', '-preset', job.preset, '-crf', String(job.crf), '-threads', String(job.threads || 0)],
    };
    const tries = job.encoder === 'nvenc' ? ['nvenc', 'x264'] : ['x264'];
    const fonts = new Set(['arial.ttf', 'arialbd.ttf']);
    [sub.font, head.font, 'Bahnschrift', Shared.HOOK_STYLE.font].forEach((f) => (Shared.FONTS[f] || []).forEach((x) => fonts.add(x)));
    return {
      jobId: job.jobId, out: job.out, total: hl + dur + od, fonts: [...fonts],
      files: { ...files, 'subs.ass': Shared.buildAss({ words, dur, sub, head, showSubs: job.subsOn, showHead: false }), 'head.ass': Shared.buildAss({ words: [], dur, sub, head, showSubs: false, showHead: job.headOn }) },
      variants: tries.map((t) => [...base, ...enc[t], ...tail]),
    };
  }

  let cancelled = false;
  async function exportBatch(jobs) {
    cancelled = false; await inv('export_reset');
    const results = [];
    for (const job of jobs) {
      if (cancelled) { results.push({ jobId: job.jobId, error: 'Cancelled' }); fire({ type: 'export', jobId: job.jobId, done: true, error: 'Cancelled' }); continue; }
      fire({ type: 'export', jobId: job.jobId, pct: 0, started: true });
      try {
        let seg = null;
        if (job.outroDur) {
          fire({ type: 'export', jobId: job.jobId, pct: 0, msg: 'Preparing outro…' });
          seg = await ensureOutro(job.outro || {});
          if (cancelled) throw new Error('Cancelled');
        }
        const gfxSegs = await ensureGfx(job.gfx, (i) => fire({ type: 'export', jobId: job.jobId, pct: 0, msg: `Rendering graphics ${i + 1}…` }));
        if (cancelled) throw new Error('Cancelled');
        const size = await inv('export_one', { spec: await buildSpec(job, seg, gfxSegs) });
        results.push({ jobId: job.jobId, out: job.out, size });
        fire({ type: 'export', jobId: job.jobId, pct: 100, done: true, out: job.out, size });
      } catch (e) {
        results.push({ jobId: job.jobId, error: e.message });
        fire({ type: 'export', jobId: job.jobId, done: true, error: e.message });
      }
    }
    return results;
  }

  window.api = {
    env: () => inv('env'),
    loadState: () => inv('state_load'),
    saveState: (state) => inv('state_save', { state }),
    importUrl: (url, range) => inv('video_url', { url, range: range || '' }),
    importFile: () => inv('video_file'),
    importPath: (path) => inv('video_path', { path }),
    transcribe: async (opts) => Shared.autoImportant(await inv('transcribe', { opts })),
    exportBatch,
    cancelExport: () => { cancelled = true; return inv('cancel_export'); },
    pickDir: () => inv('pick_dir'),
    open: (path) => inv('shell_open', { path }),
    show: (path) => inv('shell_show', { path }),
    exists: (path) => inv('fs_exists', { path }),
    elevenConnect: () => inv('eleven_connect'),
    elevenStop: () => inv('eleven_stop'),
    elevenCheck: (key) => inv('eleven_check', { key }),
    storageInfo: (o) => inv('storage_info', { keep: (o.keep || []).filter(Boolean), model: o.model || 'small' }),
    storageClean: (o) => inv('storage_clean', { keep: (o.keep || []).filter(Boolean), model: o.model || 'small' }),
    purgeVideo: (files) => inv('video_purge', { files }),
    updateCheck: () => inv('update_check'),
    updateInstall: () => inv('update_install'),
    updateState: () => inv('update_state'),
    pickSound: () => inv('sound_pick'),
    findHighlight: (req) => inv('find_highlight', { req }),
    chatReplay: (req) => inv('chat_replay', { req }),
    fileUrl: (p) => TA.core.convertFileSrc(p),
    onDrop: (cb) => { dropCb = cb; },
    onEvent: (cb) => listeners.push(cb),
  };
})();
