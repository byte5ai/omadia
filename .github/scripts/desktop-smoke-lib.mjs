// Helpers for desktop-upgrade-smoke.mjs. They install a packaged omadia desktop
// build the way a user would on each OS, launch it through Playwright's
// Electron support and read the desktop log. Meant for clean CI runners only:
// installing replaces /Applications/omadia.app, the per-user Windows install
// and ~/Applications/omadia.AppImage.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export const KERNEL_URL = 'http://127.0.0.1:8769';
export const READY_LINE = '[boot] ready: omadia is ready.';
// Lines the desktop writes right before its failure dialog, when the secret
// store refuses a file, or when quitting leaves processes behind
// (desktop/src/main.ts, ipc.ts, secretsBlob.ts, supervisor.ts).
export const FAILURE_RE =
  /\[main\] boot failed: |\[main\] fatal during startup: |\[ipc\] complete failed: |\[secrets\] .* failed for |\[boot\] shutdown incomplete/;
// A child that died after the ready line, or a stop that threw.
export const AFTER_READY_FAILURE_RE = /\[boot\] error: |\[main\] shutdown error: /;
export const SECRETS_WRITE_RE = /\[secrets\] (?:created|rewrote) /;
export const UPDATER_LINE_RE = /\[updater\] /;
// The app's own verdicts after a check that read the release feed (updater.ts, updateHoldBack.ts).
export const UPDATER_VERDICT_RE = /\[updater\] (?:update available: |up to date: running |\S+ needs OS )/;
// A throwaway prerelease build has no release of its own. electron-updater picks
// its tag from the release feed, which lists bare tags too, and then finds no
// feed file under that prerelease tag. Only a prerelease tag in the URL counts:
// the same error under a release tag is a broken update channel.
export const UPDATER_PRERELEASE_FEED_RE =
  /\[updater\] .*(?:No published versions on GitHub|Cannot find \S+\.yml in the latest release artifacts \(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/download\/v\d+\.\d+\.\d+-[^/\s]+\/)/;
// v0.167.13 is the first release whose secrets.enc holds every field the app reads, so the
// upgrade must leave the file untouched; an older baseline gets fields added on its first start.
export const MIN_BASELINE = '0.167.13';

export class FatalError extends Error {}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Resolves with `value` after `ms` without keeping the process alive. */
export function after(ms, value) {
  return new Promise((resolve) => setTimeout(resolve, ms, value).unref());
}

/** -1, 0 or 1 for two x.y.z versions; a prerelease suffix is ignored. */
export function compareVersions(a, b) {
  const parts = (v) => v.split('-')[0].split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

export function loadPlaywright() {
  const dir = process.env.SMOKE_PW_DIR;
  if (!dir) throw new Error('SMOKE_PW_DIR must name an npm prefix with playwright-core installed');
  return createRequire(path.join(dir, 'index.js'))('playwright-core');
}

/** Poll `fn` until it returns a truthy value. A FatalError ends the wait at once. */
export async function waitFor(what, fn, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      if (err instanceof FatalError) throw err;
      lastError = err;
    }
    if (Date.now() > deadline) {
      const why = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${why}`);
    }
    await sleep(intervalMs);
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const output = (res.stderr || res.stdout || '').trim().slice(0, 2000);
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} exited ${res.status}: ${output}`);
  }
  return res.stdout ?? '';
}

/** Every file or directory under `dir` whose name matches `re`; a match is not searched further. */
function findFiles(dir, re, depth = 4) {
  const hits = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (re.test(entry.name)) hits.push(full);
    else if (entry.isDirectory() && depth > 0) hits.push(...findFiles(full, re, depth - 1));
  }
  return hits;
}

function findOne(dir, re, what) {
  const hits = findFiles(dir, re);
  if (hits.length !== 1) {
    throw new Error(`expected one ${what} under ${dir}, found ${hits.length}: ${hits.join(', ') || '-'}`);
  }
  return hits[0];
}

const INSTALLER_RE = {
  macos: /^omadia-.+-arm64\.dmg$/,
  windows: /^omadia-Setup-.+\.exe$/,
  linux: /^omadia-.+\.AppImage$/,
};

/** The installer for this OS in a release download or a desktop-apps.yml artifact. */
export function installerIn(dir, platform) {
  return findOne(dir, INSTALLER_RE[platform], `${platform} installer`);
}

/** `0.0.0-desktop-refresh.3` from `omadia-0.0.0-desktop-refresh.3-arm64.dmg` and its siblings. */
export function versionOfInstaller(file) {
  const m = /^omadia-(?:Setup-)?(.+?)(?:-arm64|-x64)?\.(?:dmg|exe|AppImage)$/.exec(path.basename(file));
  if (!m) throw new Error(`cannot read a version from ${path.basename(file)}`);
  return m[1];
}

export function install(platform, installer) {
  if (platform === 'macos') return installMac(installer);
  if (platform === 'windows') return installWindows(installer);
  return installLinux(installer);
}

function installMac(dmg) {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-dmg-'));
  const bundle = '/Applications/omadia.app';
  run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
  try {
    const source = findOne(mount, /^omadia\.app$/, 'app bundle in the disk image');
    fs.rmSync(bundle, { recursive: true, force: true });
    run('ditto', [source, bundle]);
  } finally {
    spawnSync('hdiutil', ['detach', mount, '-force'], { encoding: 'utf8' });
  }
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const binary = run('plutil', ['-extract', 'CFBundleExecutable', 'raw', plist]).trim();
  // codesign prints the signature details on stderr.
  const sig = spawnSync('codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8' }).stderr ?? '';
  const team = /^TeamIdentifier=(.+)$/m.exec(sig)?.[1]?.trim();
  return {
    executable: path.join(bundle, 'Contents', 'MacOS', binary),
    team: team && team !== 'not set' ? team : null,
  };
}

function installWindows(setup) {
  // The per-user NSIS install, silent. It keeps %APPDATA%\omadia and replaces
  // an older version in place.
  run(setup, ['/S', '/currentuser'], { timeout: 15 * 60_000 });
  const exe = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'omadia', 'omadia.exe');
  if (!fs.existsSync(exe)) throw new Error(`the installer finished but ${exe} is missing`);
  return { executable: exe };
}

function installLinux(appImage) {
  const dir = path.join(os.homedir(), 'Applications');
  const target = path.join(dir, 'omadia.AppImage');
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(target, { force: true });
  fs.copyFileSync(appImage, target);
  fs.chmodSync(target, 0o755);
  return { executable: target };
}

/** Image names still running on Windows (the kernel also runs as omadia.exe). */
export function windowsProcesses(image) {
  const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
  }).stdout;
  return (out ?? '').split(/\r?\n/).filter((line) => line.toLowerCase().includes(image));
}

// Every process of the installed app runs from inside the bundle or the
// AppImage mount; the driver never does.
const APP_PROCESS_PATTERN = {
  macos: '/Applications/omadia\\.app/',
  linux: '\\.mount_omadia|Applications/omadia\\.AppImage',
};
const WINDOWS_IMAGES = ['omadia.exe', 'postgres.exe'];

/** Processes of the installed app that are still running: the app, its kernel, web UI and Postgres. */
export function leftoverProcesses(platform) {
  if (platform === 'windows') return WINDOWS_IMAGES.flatMap(windowsProcesses);
  const out = spawnSync('pgrep', ['-fl', APP_PROCESS_PATTERN[platform]], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').filter(Boolean);
}

/** Ends the app and everything it started; on Windows Playwright starts the app through a shell. */
export function killTree(platform, pid) {
  if (platform === 'windows') {
    if (pid) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8' });
    for (const image of WINDOWS_IMAGES) spawnSync('taskkill', ['/F', '/T', '/IM', image], { encoding: 'utf8' });
    return;
  }
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  spawnSync('pkill', ['-9', '-f', APP_PROCESS_PATTERN[platform]], { encoding: 'utf8' });
}

/** Where Electron puts userData for an app named `omadia`; checked against the app later. */
export function expectedUserData(platform) {
  if (platform === 'macos') return path.join(os.homedir(), 'Library', 'Application Support', 'omadia');
  if (platform === 'windows') return path.join(process.env.APPDATA ?? '', 'omadia');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'omadia');
}

/** The desktop log is append-only and shared by every version; read what one launch wrote. */
export class DesktopLog {
  constructor(userData) {
    this.file = path.join(userData, 'logs', 'omadia-desktop.log');
    this.offset = this.size();
  }

  size() {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  /** Lines written since this launch started. */
  text() {
    const end = this.size();
    if (end <= this.offset) return '';
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(end - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  lines(re) {
    return this.text().split(/\r?\n/).filter((line) => re.test(line));
  }
}

// Shapes of the secrets the app keeps: provider keys, the base64 vault and
// keychain keys (32 bytes), and the hex database passwords.
const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=/g,
  /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g,
];

/** The text with every known secret and every secret-shaped token replaced. */
export function redact(text, known) {
  const named = known.filter(Boolean).reduce((acc, secret) => acc.split(secret).join('[redacted]'), text);
  return SECRET_SHAPES.reduce((acc, re) => acc.replace(re, '[redacted]'), named);
}

export async function http(url, { method = 'GET', body, cookie, timeoutMs = 20_000 } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON; `text` keeps the start of the body for the report
  }
  return { status: res.status, json, text: text.slice(0, 300), setCookies: res.headers.getSetCookie() };
}

export function sessionCookie(setCookies) {
  for (const header of setCookies) {
    const m = /^omadia_session=([^;]+)/.exec(header);
    if (m) return `omadia_session=${m[1]}`;
  }
  return null;
}

export async function kernelListening() {
  try {
    await fetch(`${KERNEL_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the app's own view of its secret store from inside its main process.
 * Only hashes, booleans and the failing stage come back: no key, and no error
 * text, because a parse error would quote the decrypted blob.
 */
export async function probeSecrets(app, logFile) {
  return app.evaluate(async ({ app: electronApp, safeStorage }, file) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const crypto = process.getBuiltinModule('node:crypto');
    const hash = (v) => (typeof v === 'string' ? crypto.createHash('sha256').update(v).digest('hex') : null);
    const userData = electronApp.getPath('userData');
    let dataRoot = userData;
    try {
      dataRoot = fs.readFileSync(path.join(userData, 'datadir.txt'), 'utf8').trim() || userData;
    } catch {
      // no custom data directory
    }
    const out = { version: electronApp.getVersion(), electron: process.versions.electron, userData, dataRoot, readable: false };
    let raw;
    try {
      raw = fs.readFileSync(path.join(dataRoot, 'secrets.enc'));
    } catch (err) {
      return { ...out, stage: `read ${err && err.code ? err.code : 'failed'}` };
    }
    let plaintext;
    try {
      plaintext = safeStorage.decryptString(raw);
    } catch {
      return { ...out, stage: 'decrypt failed' };
    }
    let blob;
    try {
      blob = JSON.parse(plaintext);
    } catch {
      return { ...out, stage: 'parse failed' };
    }
    const fields = { vaultKey: blob.vaultKey, credentialKeychainKey: blob.credentialKeychainKey };
    for (const [name, value] of Object.entries(blob.providerKeys ?? {})) fields[`providerKeys.${name}`] = value;
    for (const [name, value] of Object.entries(blob.embeddedDb ?? {})) fields[`embeddedDb.${name}`] = value;
    const logText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const secrets = Object.values(fields).filter((v) => typeof v === 'string' && v.length >= 8);
    return {
      ...out,
      readable: true,
      fieldHashes: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, hash(value)])),
      hasDbPasswords: Boolean(blob.embeddedDb?.superuserPassword && blob.embeddedDb?.kernelPassword),
      secretInLog: secrets.some((v) => logText.includes(v)),
    };
  }, logFile);
}

/** Best effort: a screenshot of the whole screen, so native dialogs show up too. */
export function screenshotScreen(platform, file) {
  const opts = { encoding: 'utf8', timeout: 20_000 };
  if (platform === 'macos') return spawnSync('screencapture', ['-x', file], opts).status === 0;
  if (platform === 'linux') return spawnSync('import', ['-window', 'root', file], opts).status === 0;
  const target = file.replace(/'/g, "''");
  const ps =
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; ' +
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
    '[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); ' +
    `$bmp.Save('${target}')`;
  return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], opts).status === 0;
}
