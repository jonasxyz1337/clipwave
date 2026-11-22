// Renders black text on white boxes (headline "Background box" + TikTok subtitle box) on a black frame with the
// bundled ffmpeg/libass and checks the boxes really appear. Guards against libass differences between platforms.
// usage: node scripts/caption-selftest.js <path-to-ffmpeg>
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const Shared = require('../src/shared.js');

const ffmpeg = process.argv[2] ? path.resolve(process.argv[2]) : 'ffmpeg';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-selftest-'));
const words = [{ w: 'Black', s: 0, e: 0.5 }, { w: 'text', s: 0.5, e: 1 }, { w: 'on', s: 1, e: 1.2 }, { w: 'white', s: 1.2, e: 2 }];
const cases = {
  'headline box': Shared.buildAss({ words: [], dur: 2, sub: Shared.SUB_PRESETS['Impact Pop'], head: { ...Shared.HEAD_PRESETS['Sticker'], text: 'BLACK TEXT ON WHITE', color: '#000000', outlineColor: '#ffffff', anim: 'none' }, showSubs: false }),
  'tiktok subtitle box': Shared.buildAss({ words, dur: 2, sub: { ...Shared.SUB_PRESETS['TikTok Box'] }, head: Shared.HEAD_PRESETS['Bold Statement'], showHead: false }),
};
let failed = 0;
for (const [name, ass] of Object.entries(cases)) {
  const f = path.join(dir, name.replace(/\W+/g, '_') + '.ass');
  fs.writeFileSync(f, '﻿' + ass);
  // average brightness of the whole frame (1x1 pixel): black frame + black text = ~0, a white box lifts it clearly
  const out = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=2', '-ss', '0.5', '-vf', `ass='${f.replace(/\\/g, '/').replace(/:/g, '\\:')}',format=gray,scale=108:192:flags=area,scale=1:1:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-'], { cwd: dir });
  const luma = out[0];
  const ok = luma >= 3;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: average brightness ${luma}`);
  if (!ok) failed++;
}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
