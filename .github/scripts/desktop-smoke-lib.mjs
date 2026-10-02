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
// Lines the desktop writes right before its failure dialog, or when the secret
// store refuses a file (desktop/src/main.ts, ipc.ts, secretsBlob.ts, supervisor.ts).
export const FAILURE_RE =
  /\[main\] boot failed: |\[main\] fatal during startup: |\[ipc\] complete failed: |\[secrets\] .* failed for |\[boot\] shutdown incomplete/;
export const SECRETS_WRITE_RE = /\[secrets\] (?:created|rewrote) /;
export const UPDATER_LINE_RE = /\[updater\] (?!skipped \(not packaged\))/;
// electron-updater answered from the release feed (an update, no update, or no
// release for this build's channel) instead of failing on the network.
export const UPDATER_FEED_RE =
  /update available|is not available|No published versions|Unable to find latest version|Cannot find .*\.yml|Found version/i;

export class FatalError extends Error {}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

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
  return {
    executable: path.join(bundle, 'Contents', 'MacOS', binary),
    team: /^TeamIdentifier=(.+)$/m.exec(sig)?.[1]?.trim() ?? 'none',
  };
}

function installWindows(setup) {
  // The per-user NSIS install, silent, as the updater runs it. It keeps
  // %APPDATA%\omadia and replaces an older version in place.
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

export function killWindowsImage(image) {
  spawnSync('taskkill', ['/F', '/T', '/IM', image], { encoding: 'utf8' });
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
 * Only hashes and booleans come back; no key leaves the app as plaintext.
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
    const out = { version: electronApp.getVersion(), electron: process.versions.electron, userData, dataRoot };
    try {
      const blob = JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(dataRoot, 'secrets.enc'))));
      const logText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const secrets = [
        blob.vaultKey,
        blob.credentialKeychainKey,
        ...Object.values(blob.providerKeys ?? {}),
        ...Object.values(blob.embeddedDb ?? {}),
      ].filter((v) => typeof v === 'string' && v.length >= 8);
      Object.assign(out, {
        readable: true,
        vaultKeyHash: hash(blob.vaultKey),
        anthropicKeyHash: hash(blob.providerKeys?.ANTHROPIC_API_KEY),
        hasDbPasswords: Boolean(blob.embeddedDb?.superuserPassword && blob.embeddedDb?.kernelPassword),
        secretInLog: secrets.some((v) => logText.includes(v)),
      });
    } catch (err) {
      Object.assign(out, { readable: false, error: String(err && err.message ? err.message : err) });
    }
    return out;
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
