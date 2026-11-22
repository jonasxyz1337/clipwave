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
      begin: (name) => inv('outro_begin', { path: f[name] }),
      frame: (rgba) => TA.core.invoke('outro_frame', rgba).catch((e) => { throw asError(e); }),
      end: () => inv('outro_end'),
    });
    return f;
  }

  // ---------- one export job -> ffmpeg spec ----------
  const fmtA = 'aformat=channel_layouts=stereo:sample_rates=48000';
  const fwd = (f) => f.replace(/\\/g, '/').replace(/'/g, "'\\''");

  async function buildSpec(job, seg) {
    const { sub, head, layout, words } = job;
    const dur = job.end - job.start, od = job.outroDur || 0;
    const fps = job.fps || 30, d3 = dur.toFixed(3);
    const sounds = [];
    for (const x of job.sounds || []) if (x && x.path && (await inv('fs_exists', { path: x.path }))) sounds.push(x);
    const origVol = job.origVol == null ? 1 : job.origVol;
    const g = [], extraIn = [];
    let outroTxt = null;

    // video: layout -> timed effect boxes -> captions
    const fx = Shared.fxGraph(job.fx || [], 'vc');
    g.push(`${Shared.filterGraph(layout, job.w, job.h)}[vc]`);
    if (fx.graph) g.push(fx.graph);
    g.push(`[${fx.out}]ass=subs.ass:fontsdir=fonts,format=yuv420p${od ? `,fps=${fps},setsar=1` : ''}[va]`);

    // outro (video + its own audio)
    let outroAudio = [], vmap = '[va]', nextIn = 1;
    if (od) {
      const loops = Math.max(1, Math.ceil((od - 2.5) / 3.5) + 1);
      outroTxt = [`file '${fwd(seg.intro)}'`, ...Array.from({ length: loops }, () => `file '${fwd(seg.loop)}'`)].join('\n');
      const D = od.toFixed(2), t0 = Math.max(0, od - 0.45).toFixed(2), hasVoice = !!seg.voice;
      extraIn.push('-t', D, '-f', 'concat', '-safe', '0', '-i', 'outro.txt'); nextIn = 2;
      if (hasVoice) { extraIn.push('-i', seg.voice); nextIn = 3; }
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

    // audio: original track + user sounds (trimmed, timed, faded)
    let amap;
    if (!(od || sounds.length || origVol !== 1)) amap = '0:a:0?';
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

    const base = ['-y', '-hide_banner', '-ss', String(job.start), '-t', String(dur), '-i', job.videoPath, ...extraIn, '-filter_complex', g.join(';'), '-map', vmap, '-map', amap];
    const tail = [...(job.fps && !od ? ['-r', String(job.fps)] : []), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', job.out];
    const enc = {
      nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', String(job.crf), '-b:v', '0'],
      x264: ['-c:v', 'libx264', '-preset', job.preset, '-crf', String(job.crf), '-threads', String(job.threads || 0)],
    };
    const tries = job.encoder === 'nvenc' ? ['nvenc', 'x264'] : ['x264'];
    const fonts = new Set(['arial.ttf', 'arialbd.ttf']);
    [sub.font, head.font, 'Bahnschrift'].forEach((f) => (Shared.FONTS[f] || []).forEach((x) => fonts.add(x)));
    return {
      jobId: job.jobId, out: job.out, total: dur + od, fonts: [...fonts], outroTxt,
      ass: Shared.buildAss({ words, dur, sub, head, showSubs: job.subsOn, showHead: job.headOn }),
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
        const size = await inv('export_one', { spec: await buildSpec(job, seg) });
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
    fileUrl: (p) => TA.core.convertFileSrc(p),
    onDrop: (cb) => { dropCb = cb; },
    onEvent: (cb) => listeners.push(cb),
  };
})();
