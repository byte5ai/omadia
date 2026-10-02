#!/usr/bin/env node
// Desktop upgrade smoke: installs a packaged omadia desktop build on a clean CI
// runner and drives it the way a person would, without a person.
//
//   fresh    install the candidate, finish the first-run wizard with a real
//            provider key, then check the kernel, the web UI, the first admin,
//            sign-in, the stored key and the update check.
//   upgrade  do the same with the baseline release, install the candidate over
//            it, and check that it boots without a failure, leaves secrets.enc
//            byte-identical (so the recovery key is unchanged), and still signs
//            in and verifies the stored key.
//
// Usage: node desktop-upgrade-smoke.mjs --scenario fresh|upgrade
//          --platform macos|windows|linux --candidate <dir> [--baseline <dir>] --out <dir>
// Env:   SMOKE_PW_DIR          npm prefix with playwright-core installed
//        SMOKE_ANTHROPIC_KEY   or SMOKE_KEY_FILE (read once, then deleted)
// Secrets never leave the app as plaintext: the recovery key and the stored
// keys are compared as SHA-256 hashes computed inside the app.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  DesktopLog,
  FAILURE_RE,
  FatalError,
  KERNEL_URL,
  READY_LINE,
  SECRETS_WRITE_RE,
  UPDATER_FEED_RE,
  UPDATER_LINE_RE,
  expectedUserData,
  http,
  install,
  installerIn,
  kernelListening,
  killWindowsImage,
  loadPlaywright,
  probeSecrets,
  screenshotScreen,
  sessionCookie,
  sha256,
  sleep,
  versionOfInstaller,
  waitFor,
  windowsProcesses,
} from './desktop-smoke-lib.mjs';

const SHUTDOWN_ERROR_RE = /\[main\] shutdown error: /;
const UI_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\//;
const BOOT_TIMEOUT_MS = 10 * 60_000;

const checks = [];

function check(id, title, ok, detail = '') {
  const passed = Boolean(ok);
  checks.push({ id, title, ok: passed, detail: String(detail ?? '') });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? `  (${detail})` : ''}`);
  return passed;
}

const step = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const short = (hash) => (hash ? `${hash.slice(0, 12)}…` : 'none');

function readProviderKey() {
  if (process.env.SMOKE_ANTHROPIC_KEY) return process.env.SMOKE_ANTHROPIC_KEY.trim();
  const file = process.env.SMOKE_KEY_FILE;
  if (!file) throw new Error('set SMOKE_ANTHROPIC_KEY or SMOKE_KEY_FILE');
  const key = fs.readFileSync(file, 'utf8').trim();
  fs.rmSync(file, { force: true });
  return key;
}

/** The runner's environment minus anything the app must not inherit. */
function appEnv() {
  const env = { ...process.env };
  // An inherited provider key would hide a stored key that went missing, and
  // CI tokens have no business inside the app.
  for (const name of Object.keys(env)) {
    if (/API_KEY$|TOKEN$|^SMOKE_|^ACTIONS_/.test(name)) delete env[name];
  }
  // First boots on shared runners can exceed the 90 s kernel default.
  env.OMADIA_BOOT_TIMEOUT_MS = '300000';
  return env;
}

function hashFile(file) {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

async function pageShot(page, ctx, name) {
  try {
    await page.screenshot({ path: path.join(ctx.out, 'screens', `${name}.png`) });
  } catch (err) {
    console.log(`screenshot ${name} failed: ${err.message}`);
  }
}

/** Blank the wizard's secrets before any screenshot of an aborted run. */
async function scrubWizard(app) {
  for (const page of app.windows()) {
    if (!page.url().includes('/renderer/wizard.html')) continue;
    await page
      .evaluate(() => {
        const key = document.querySelector('#recoveryKey');
        if (key) key.textContent = '(hidden by the smoke test)';
        const input = document.querySelector('#apiKey');
        if (input) input.value = '';
      })
      .catch(() => {});
  }
}

async function completeWizard(app, ctx, label) {
  const wizard = await waitFor(
    'the first-run wizard',
    () => app.windows().find((p) => p.url().includes('/renderer/wizard.html')) ?? null,
    { timeoutMs: 180_000, intervalMs: 1000 },
  );
  await wizard.waitForSelector('#next', { state: 'visible', timeout: 60_000 });
  check(`${label}.wizard`, 'a fresh install opens the first-run wizard', true);
  await pageShot(wizard, ctx, `${label}-1-wizard`);

  await wizard.click('#next');
  await wizard.waitForSelector('#apiKey', { state: 'visible', timeout: 15_000 });
  await wizard.check('#modeApiKey');
  await wizard.selectOption('#provider', 'anthropic');
  await wizard.fill('#apiKey', ctx.providerKey);
  await wizard.click('#testKey');
  await wizard.waitForFunction(() => !document.querySelector('#testKey').disabled, null, { timeout: 30_000 });
  const keyTest = await wizard.$eval('#testResult', (el) => ({
    ok: el.classList.contains('ok'),
    text: el.textContent ?? '',
  }));
  check(`${label}.wizard-key-test`, 'the wizard key test accepts the provider key', keyTest.ok, keyTest.ok ? '' : keyTest.text.slice(0, 200));

  for (const n of [2, 3, 4]) {
    await wizard.click('#next');
    // An unverified key needs a second Continue; a verified one moves on at once.
    if (!(await wizard.isVisible(`.step[data-step="${n}"]`))) await wizard.click('#next');
    await wizard.waitForSelector(`.step[data-step="${n}"]`, { state: 'visible', timeout: 15_000 });
  }

  await wizard.click('#revealKey');
  // The field starts with a row of bullets; wait for the key or the error text.
  await wizard.waitForFunction(
    () => {
      const text = (document.querySelector('#recoveryKey')?.textContent ?? '').trim();
      return text.length > 0 && !/^•+$/.test(text);
    },
    null,
    { timeout: 30_000 },
  );
  const recovery = await wizard.evaluate(async () => {
    const text = (document.querySelector('#recoveryKey')?.textContent ?? '').trim();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { length: text.length, unavailable: text.startsWith('unavailable'), hash };
  });
  check(
    `${label}.recovery-key-shown`,
    'the wizard shows a recovery key',
    !recovery.unavailable && recovery.length >= 40,
    `${recovery.length} characters`,
  );
  step(`${label}: finishing the wizard`);
  await wizard.click('#next');
  return recovery;
}

/** The window that shows the web UI; a failure line or, after an upgrade, the wizard ends the wait. */
function waitForUi(app, log, what, wizardIsFatal) {
  return waitFor(
    what,
    () => {
      const failure = log.lines(FAILURE_RE)[0];
      if (failure) throw new FatalError(`desktop log: ${failure.trim().slice(0, 300)}`);
      for (const page of app.windows()) {
        const url = page.url();
        if (wizardIsFatal && url.includes('/renderer/wizard.html')) {
          throw new FatalError('the app opened the first-run wizard instead of the existing install');
        }
        if (UI_URL_RE.test(url)) return page;
      }
      return null;
    },
    { timeoutMs: BOOT_TIMEOUT_MS },
  );
}

async function checkReady(log, label) {
  await waitFor(
    'the ready line in the desktop log',
    () => {
      if (log.lines(FAILURE_RE).length > 0) throw new FatalError('failure line in the desktop log');
      return log.text().includes(READY_LINE);
    },
    { timeoutMs: BOOT_TIMEOUT_MS },
  ).catch(() => {});
  const failures = log.lines(FAILURE_RE);
  check(`${label}.no-boot-failure`, 'no boot failure or secret-store refusal in the desktop log', failures.length === 0, failures[0]?.trim().slice(0, 300));
  if (!check(`${label}.ready`, 'the desktop log says omadia is ready', log.text().includes(READY_LINE))) {
    throw new Error('the app never became ready');
  }
}

async function checkAccounts(ctx, label, firstRun) {
  const { email, password } = ctx.admin;
  if (firstRun) {
    const setup = await http(`${KERNEL_URL}/api/v1/auth/setup`, {
      method: 'POST',
      body: { email, password, display_name: 'Smoke Admin' },
    });
    check(`${label}.admin-setup`, 'the first admin is created through the kernel API', setup.status < 300 && sessionCookie(setup.setCookies), `HTTP ${setup.status} ${setup.json?.code ?? ''}`);
  }
  const login = await http(`${KERNEL_URL}/api/v1/auth/login/local`, { method: 'POST', body: { email, password } });
  const cookie = sessionCookie(login.setCookies);
  check(`${label}.admin-login`, 'the admin signs in with a password', login.status === 200 && cookie, `HTTP ${login.status} ${login.json?.code ?? ''}`);
  // The kernel seeds the vault from the stored key while its orchestrator registers.
  const verify = await waitFor(
    'a provider verdict other than no_key',
    async () => {
      const res = await http(`${KERNEL_URL}/api/v1/admin/providers/anthropic/verify`, { method: 'POST', body: {}, cookie });
      return res.json?.status === 'no_key' ? null : res;
    },
    { timeoutMs: 90_000, intervalMs: 5000 },
  ).catch((err) => ({ status: 0, json: { status: err.message } }));
  check(`${label}.provider-key-works`, 'the stored Anthropic key verifies through the kernel vault', verify.json?.status === 'verified', `HTTP ${verify.status} ${verify.json?.status ?? ''}`);
}

async function checkUpdater(log, label) {
  const line = await waitFor(
    'an update check that reached the release feed',
    () => log.lines(UPDATER_LINE_RE).find((l) => UPDATER_FEED_RE.test(l)) ?? null,
    { timeoutMs: 120_000 },
  ).catch(() => null);
  const last = line ?? log.lines(UPDATER_LINE_RE).at(-1) ?? 'no [updater] line';
  check(`${label}.update-check`, 'the updater checks the release feed', Boolean(line), last.replace(/^.*?\[updater\]/, '[updater]').trim().slice(0, 300));
}

async function drive(app, ctx, phase, log, result) {
  const { label, firstRun, blockUpdates, expectVersion, before } = phase;
  if (firstRun) result.recovery = await completeWizard(app, ctx, label);
  const page = await waitForUi(app, log, 'the web UI', !firstRun);
  await checkReady(log, label);
  await pageShot(page, ctx, `${label}-2-ui`);
  screenshotScreen(ctx.platform, path.join(ctx.out, 'screens', `${label}-3-screen.png`));

  const kernel = await http(`${KERNEL_URL}/health`);
  check(`${label}.kernel-health`, 'the kernel answers /health with ok', kernel.status === 200 && kernel.json?.status === 'ok', `HTTP ${kernel.status}, kernel ${kernel.json?.version ?? '?'}`);
  const uiOrigin = new URL(page.url()).origin;
  const ui = await http(`${uiOrigin}/health`);
  check(`${label}.ui-health`, 'the web UI answers /health', ui.status === 200, `HTTP ${ui.status} on ${uiOrigin}`);

  await checkAccounts(ctx, label, firstRun);

  const probe = await probeSecrets(app, log.file);
  result.probe = probe;
  result.dataRoot = probe.dataRoot;
  check(`${label}.version`, 'the app runs the installed version', probe.version === expectVersion, `${probe.version}, Electron ${probe.electron}`);
  check(`${label}.paths`, 'the app keeps its data where the smoke test reads it', probe.userData === expectedUserData(ctx.platform), probe.userData);
  check(`${label}.secrets-readable`, 'secrets.enc decrypts inside the app', probe.readable && probe.hasDbPasswords, probe.error ?? 'vault key, provider key, database passwords');
  check(`${label}.provider-key-stored`, 'secrets.enc holds the key entered in the wizard', probe.anthropicKeyHash === sha256(ctx.providerKey));
  check(`${label}.no-secret-in-log`, 'no stored key or database password appears in the desktop log', probe.readable && !probe.secretInLog);
  if (before) {
    check(`${label}.recovery-key-kept`, 'the recovery key is still the one the baseline wizard showed', probe.vaultKeyHash === before.recovery?.hash, `${short(before.recovery?.hash)} → ${short(probe.vaultKeyHash)}`);
    const writes = log.lines(SECRETS_WRITE_RE);
    check(`${label}.secrets-not-rewritten`, 'the upgraded app neither creates nor rewrites secrets.enc', writes.length === 0, writes[0]?.trim().slice(0, 200));
  } else if (result.recovery) {
    check(`${label}.recovery-key-stored`, 'the recovery key shown is the vault key in secrets.enc', probe.vaultKeyHash === result.recovery.hash);
  }

  if (!blockUpdates) await checkUpdater(log, label);
}

async function quit(app, ctx, label, log, result) {
  const closed = await Promise.race([app.close().then(() => true, () => false), sleep(150_000).then(() => false)]);
  if (!closed) {
    try {
      app.process().kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  const dataRoot = result.dataRoot ?? expectedUserData(ctx.platform);
  const stopped = await waitFor(
    'the kernel and Postgres to stop',
    async () => {
      if (await kernelListening()) return false;
      // Postgres removes postmaster.pid on a clean stop. On Windows the app ends
      // it with TerminateProcess, so the processes themselves are what counts.
      if (ctx.platform === 'windows') {
        return windowsProcesses('postgres.exe').length === 0 && windowsProcesses('omadia.exe').length === 0;
      }
      return !fs.existsSync(path.join(dataRoot, 'pgdata', 'postmaster.pid'));
    },
    { timeoutMs: 120_000 },
  ).then(() => true, () => false);
  const shutdownErrors = log.lines(SHUTDOWN_ERROR_RE);
  check(
    `${label}.quit`,
    'quitting stops the app, the kernel and Postgres without a shutdown error',
    closed && stopped && shutdownErrors.length === 0,
    `${closed ? 'app exited' : 'app was killed'}; ${stopped ? 'stack down' : 'stack still up'}${shutdownErrors[0] ? `; ${shutdownErrors[0].trim()}` : ''}`,
  );
  if (!stopped && ctx.platform === 'windows') {
    killWindowsImage('omadia.exe');
    killWindowsImage('postgres.exe');
  }
  result.secretsHash = hashFile(path.join(dataRoot, 'secrets.enc'));
}

function saveArtifacts(ctx, label, log, dataRoot) {
  const secrets = [ctx.providerKey, ctx.admin.password];
  const text = log.text();
  check(`${label}.no-credential-in-log`, 'the provider key and the admin password stay out of the desktop log', secrets.every((s) => !text.includes(s)));
  const redacted = secrets.reduce((acc, s) => acc.split(s).join('[redacted]'), text);
  fs.writeFileSync(path.join(ctx.out, `desktop-log-${label}.txt`), redacted);
  for (const name of ['setup.json', 'updater-check-health.json']) {
    const file = path.join(dataRoot, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(ctx.out, `${label}-${name}`));
  }
}

async function runPhase(pw, ctx, phase) {
  const { label, installer } = phase;
  const result = { label };
  step(`${label}: installing ${path.basename(installer)}`);
  const installed = install(ctx.platform, installer);
  result.team = installed.team;
  if (phase.before && ctx.platform === 'macos') {
    // A different signer cannot read the keychain item the baseline created.
    const same = check(`${label}.same-signer`, 'the candidate is signed by the same team as the baseline', installed.team === phase.before.team, `${phase.before.team} → ${installed.team}`);
    if (!same) return result;
  }
  if (ctx.platform === 'windows') {
    const running = windowsProcesses('omadia.exe');
    check(`${label}.installer-no-autostart`, 'the silent install does not start the app', running.length === 0, running.join(' | '));
    if (running.length) {
      killWindowsImage('omadia.exe');
      await sleep(5000);
    }
  }

  const log = new DesktopLog(expectedUserData(ctx.platform));
  const args = [];
  // The AppImage's own desktop entry starts the app this way.
  if (ctx.platform === 'linux') args.push('--no-sandbox');
  // Keeps the baseline from downloading a newer release in the background.
  if (phase.blockUpdates) args.push('--proxy-server=http://127.0.0.1:9');
  step(`${label}: launching ${installed.executable}`);
  const app = await pw._electron.launch({ executablePath: installed.executable, args, env: appEnv(), timeout: 180_000 });
  try {
    await drive(app, ctx, phase, log, result);
    check(`${label}.completed`, 'the phase ran to the end', true);
  } catch (err) {
    check(`${label}.completed`, 'the phase ran to the end', false, err.message.split('\n')[0].slice(0, 400));
    await scrubWizard(app);
    for (const [i, page] of app.windows().entries()) await pageShot(page, ctx, `${label}-error-${i}`);
    screenshotScreen(ctx.platform, path.join(ctx.out, 'screens', `${label}-error-screen.png`));
  } finally {
    step(`${label}: quitting`);
    await quit(app, ctx, label, log, result);
    saveArtifacts(ctx, label, log, result.dataRoot ?? expectedUserData(ctx.platform));
  }
  return result;
}

function writeReport(ctx) {
  const failed = checks.filter((c) => !c.ok);
  const report = {
    scenario: ctx.scenario,
    platform: ctx.platform,
    candidateVersion: ctx.candidateVersion,
    baselineVersion: ctx.baselineVersion ?? null,
    passed: failed.length === 0,
    checks,
  };
  fs.writeFileSync(path.join(ctx.out, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  const versions = `candidate ${ctx.candidateVersion}${ctx.baselineVersion ? ` over baseline ${ctx.baselineVersion}` : ''}`;
  const verdict = failed.length === 0 ? `all ${checks.length} checks passed` : `${failed.length} of ${checks.length} checks failed`;
  const rows = checks.map((c) => `| ${c.ok ? '✅' : '❌'} | \`${c.id}\` | ${c.title} | ${c.detail.replace(/\|/g, '\\|')} |`);
  const md = [`### Desktop smoke — ${ctx.platform}, ${ctx.scenario}`, '', `${versions}: ${verdict}.`, '', '| | Check | What | Detail |', '|---|---|---|---|', ...rows, ''];
  fs.writeFileSync(path.join(ctx.out, 'summary.md'), md.join('\n'));
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      platform: { type: 'string' },
      candidate: { type: 'string' },
      baseline: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const { scenario, platform, candidate, baseline, out } = values;
  if (!['fresh', 'upgrade'].includes(scenario)) throw new Error('--scenario must be fresh or upgrade');
  if (!['macos', 'windows', 'linux'].includes(platform)) throw new Error('--platform must be macos, windows or linux');
  if (!candidate || !out || (scenario === 'upgrade' && !baseline)) throw new Error('--candidate, --out and (for upgrade) --baseline are required');
  fs.mkdirSync(path.join(out, 'screens'), { recursive: true });

  const ctx = {
    scenario,
    platform,
    out,
    providerKey: readProviderKey(),
    admin: { email: 'smoke-admin@example.com', password: randomBytes(18).toString('base64url') },
  };
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${ctx.admin.password}`);
  const pw = loadPlaywright();
  const candidateInstaller = installerIn(candidate, platform);
  ctx.candidateVersion = versionOfInstaller(candidateInstaller);

  try {
    if (scenario === 'fresh') {
      await runPhase(pw, ctx, { label: 'fresh', installer: candidateInstaller, firstRun: true, expectVersion: ctx.candidateVersion });
    } else {
      const baselineInstaller = installerIn(baseline, platform);
      ctx.baselineVersion = versionOfInstaller(baselineInstaller);
      const before = await runPhase(pw, ctx, {
        label: 'baseline',
        installer: baselineInstaller,
        firstRun: true,
        blockUpdates: true,
        expectVersion: ctx.baselineVersion,
      });
      // A broken baseline says nothing about the candidate.
      if (check('baseline.usable', 'the baseline install worked, so the upgrade can be judged', checks.every((c) => c.ok))) {
        const after = await runPhase(pw, ctx, {
          label: 'upgrade',
          installer: candidateInstaller,
          firstRun: false,
          expectVersion: ctx.candidateVersion,
          before,
        });
        check('upgrade.secrets-identical', 'secrets.enc is byte-identical to the baseline\'s', before.secretsHash && after.secretsHash === before.secretsHash, `${short(before.secretsHash)} → ${short(after.secretsHash)}`);
      }
    }
  } catch (err) {
    check('smoke.ran', 'the smoke test ran', false, err.message.split('\n')[0].slice(0, 400));
  }
  writeReport(ctx);
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
