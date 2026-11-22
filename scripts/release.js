// Builds the signed installer and publishes a GitHub release that every installed Clipwave picks up:
//  - latest.json  → Clipwave 2.x (Tauri updater, signed with the key in %USERPROFILE%\.clipwave-keys)
//  - latest.yml   → Clipwave 1.x (Electron updater) – lets old installs move to 2.x on their own
// usage: npm run release -- "What changed"     (needs: gh logged in, Rust, the signing key)
const { execFileSync } = require('child_process');
const crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');

const root = path.join(__dirname, '..');
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version, notes = process.argv[2] || `Clipwave ${version}`;
const keyFile = path.join(os.homedir(), '.clipwave-keys', 'updater.key');
if (!fs.existsSync(keyFile)) throw new Error('Signing key missing: ' + keyFile);
const target = process.env.CARGO_TARGET_DIR || path.join(root, 'src-tauri', 'target');
const env = { ...process.env, CARGO_TARGET_DIR: target, TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyFile, 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
// npx is a .cmd script on Windows and needs a shell; everything else runs directly so arguments with spaces stay intact
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, env, shell: cmd === 'npx' && process.platform === 'win32' });

if (!process.env.SKIP_BUILD) sh('npx', ['tauri', 'build']);

const dir = path.join(target, 'release', 'bundle', 'nsis');
const exeName = `Clipwave_${version}_x64-setup.exe`;
const exe = path.join(dir, exeName), sig = exe + '.sig';
for (const f of [exe, sig]) if (!fs.existsSync(f)) throw new Error('Build output missing: ' + f);
const setupName = `Clipwave-Setup-${version}.exe`; // GitHub-friendly name (no spaces), used by both updaters
const out = path.join(dir, 'release'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
fs.copyFileSync(exe, path.join(out, setupName));
const buf = fs.readFileSync(exe), url = `https://github.com/jonasxyz1337/clipwave/releases/download/v${version}/${setupName}`;
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify({
  version, notes, pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature: fs.readFileSync(sig, 'utf8').trim(), url } },
}, null, 2));
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
fs.writeFileSync(path.join(out, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${setupName}\n    sha512: ${sha512}\n    size: ${buf.length}\npath: ${setupName}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`);

if (process.env.NO_PUBLISH) { console.log('Release files ready in', out); process.exit(0); }
sh('gh', ['release', 'create', `v${version}`, '-R', 'jonasxyz1337/clipwave', '--target', 'main', '-t', `Clipwave ${version}`, '-n', notes,
  path.join(out, setupName), path.join(out, 'latest.json'), path.join(out, 'latest.yml')]);
