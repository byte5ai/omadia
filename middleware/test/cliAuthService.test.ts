/**
 * OM-73 (#995) + #1084 — `claude auth login` exit handling and flow detection.
 *
 * The newer Claude CLI (v2.1.246+) completes the login through a browser
 * callback and exits 0 without needing a pasted code. The old exit handler
 * marked any still-`pending` session `error`, so a SUCCESSFUL login was
 * recorded as a failure. These tests pin the contract down:
 *
 *   - exit 0 while pending, detection confirms → `authorized`, hook fires once
 *   - exit 0 while pending, detection says no   → `error`, clear message, no hook
 *   - non-zero exit                             → `error` carrying the output tail
 *   - exit handler + code submit racing         → hook fires exactly once
 *   - `codeEntry` (#1084): the paste prompt decides. The CLI bundled in the
 *     image (2.1.187) prints "Opening browser…" and "If the browser didn't
 *     open…" and THEN waits on a stdin paste prompt — the old rule read those
 *     two lines as a browser callback and left the operator without a code
 *     field. Any paste prompt ⇒ `true` (2.1.187 and 2.1.259 alike, the UI
 *     polls in parallel), a URL with no prompt ⇒ `false`; a paste prompt that
 *     arrives a few ms after the callback lines still counts; start resolves
 *     as soon as the prompt shows up rather than waiting out the probe window.
 *   - a wrong code keeps the session `pending`, so a correct retry still
 *     authorizes and fires the post-login hook (auto-assign, OM-79).
 *
 * Fixture strings: 2.1.187 is the verbatim container output quoted in #1084;
 * 2.1.259 is what that bundle prints (`~/.local/share/claude/versions/2.1.259`,
 * extracted with `strings`). The CLI itself is never run here. A fake
 * ChildProcess (EventEmitter + PassThrough streams) stands in for `spawn`, a
 * scripted detector for `detectCliBackends`, both via the module's injection
 * seam.
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';

import {
  __resetCliAuthState,
  __setCliAuthDepsForTests,
  getActiveLogin,
  setCliLoginAuthorizedHook,
  startCliLogin,
  submitCliCode,
} from '../src/platform/cliAuthService.js';
import type { CliBackendsSnapshot } from '../src/platform/cliBackendDetector.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill(): boolean {
    if (this.exitCode === null) this.exitCode = -1;
    return true;
  }
  print(text: string): void {
    this.stdout.write(text);
  }
  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

// ── Real CLI output, verbatim ─────────────────────────────────────────────────
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc';
const OPENING_BROWSER = 'Opening browser to sign in…\n';
const WAITING_FOR_BROWSER = 'Waiting for browser authorization…\n';
const IF_BROWSER_DIDNT_OPEN = `If the browser didn't open, visit: ${URL}\n`;
const PASTE_IF_PROMPTED = 'Paste code here if prompted > ';
/** What the 2.1.259 bundle prints for `claude auth login --claudeai`. */
const CALLBACK_FLOW_OUTPUT =
  OPENING_BROWSER + WAITING_FOR_BROWSER + IF_BROWSER_DIDNT_OPEN + PASTE_IF_PROMPTED;
/** #1084 — the 2.1.187 login URL: `code=true` + the platform.claude.com
 *  paste-code callback, i.e. no localhost server. */
const URL_2_1_187 =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback';
/** #1084 — what the CLI bundled in the image (2.1.187) prints inside the
 *  container. Two lines look like a browser callback, but it waits on stdin. */
const REAL_2_1_187_OUTPUT =
  OPENING_BROWSER + `If the browser didn't open, visit: ${URL_2_1_187}\n` + PASTE_IF_PROMPTED;
/** A URL and nothing else — no flow signature at all. */
const URL_ONLY_OUTPUT = `Please visit: ${URL}\n`;

function snapshot(loggedIn: 'yes' | 'no'): CliBackendsSnapshot {
  return {
    backends: [
      {
        id: 'claude',
        label: 'Claude',
        bin: 'claude',
        installed: true,
        loggedIn,
        billing: 'subscription',
        detail: '',
        ...(loggedIn === 'yes' ? { account: 'me@firm.de' } : {}),
      },
    ],
    cliToolsDir: '/tmp/cli-tools',
    generatedAt: Date.now(),
  } as unknown as CliBackendsSnapshot;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('cliAuthService — OM-73 exit-code handling + flow detection', () => {
  let child: FakeChild;
  let loggedIn: 'yes' | 'no';
  let hookCalls: string[];
  let detectCalls: number;

  function install(codePromptProbeMs = 150): void {
    __setCliAuthDepsForTests({
      spawn: (() => child) as unknown as typeof spawn,
      resolveCliBin: (bin: string) => bin,
      detectCliBackends: async () => {
        detectCalls += 1;
        return snapshot(loggedIn);
      },
      codePromptProbeMs,
      statusPollIntervalMs: 40,
    });
  }

  beforeEach(() => {
    __resetCliAuthState();
    child = new FakeChild();
    loggedIn = 'no';
    hookCalls = [];
    detectCalls = 0;
    install();
    setCliLoginAuthorizedHook((cliId) => {
      hookCalls.push(cliId);
    });
  });

  afterEach(() => {
    setCliLoginAuthorizedHook(undefined);
    __resetCliAuthState();
    __setCliAuthDepsForTests();
  });

  /** Start a login and feed the CLI's opening output shortly after spawn. */
  async function start(output: string) {
    const pending = startCliLogin('claude');
    setTimeout(() => child.print(output), 5);
    return pending;
  }

  // ── flow detection ───────────────────────────────────────────────────────

  it('#1084: 2.1.187 real output (browser lines + paste prompt) → codeEntry=true', async () => {
    const res = await start(REAL_2_1_187_OUTPUT);
    assert.equal(res.codeEntry, true);
    assert.equal(res.status, 'pending');
    assert.equal(res.verificationUrl, URL_2_1_187);
  });

  it('2.1.259 output (callback lines + "if prompted" paste) → codeEntry=true (paste wins)', async () => {
    const res = await start(CALLBACK_FLOW_OUTPUT);
    assert.equal(res.codeEntry, true);
    assert.equal(res.status, 'pending');
    assert.equal(res.verificationUrl, URL);
  });

  it('#1084: paste prompt arriving after the callback lines in a later chunk → codeEntry=true', async () => {
    install(1500);
    const pending = startCliLogin('claude');
    // The URL is picked up on the 250 ms capture tick; the prompt lands AFTER
    // that, inside the probe window — a probe that stopped at the first
    // browser line would already have answered `false`.
    // Pin THIS test's child: a late timer must never print into the next one.
    const cli = child;
    setTimeout(() => cli.print(OPENING_BROWSER + IF_BROWSER_DIDNT_OPEN), 5);
    setTimeout(() => cli.print(PASTE_IF_PROMPTED), 450);
    const res = await pending;
    assert.equal(res.codeEntry, true);
  });

  it('URL with no signature at all → codeEntry=false after the probe window', async () => {
    const res = await start(URL_ONLY_OUTPUT);
    assert.equal(res.codeEntry, false);
  });

  it('start resolves as soon as a signature appears, not after the full probe window', async () => {
    install(1500); // long window; a signature must cut it short
    const t0 = Date.now();
    await start(REAL_2_1_187_OUTPUT);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 900, `start took ${String(elapsed)}ms, should not wait out the 1500ms probe`);
  });

  // ── exit-code handling ───────────────────────────────────────────────────

  it('exit 0 while pending + detection confirms → authorized, hook fires once', async () => {
    const res = await start(CALLBACK_FLOW_OUTPUT);
    assert.equal(getActiveLogin()?.status, 'pending');

    loggedIn = 'yes';
    child.exit(0);
    await delay(20);

    const login = getActiveLogin();
    assert.equal(login?.sessionId, res.sessionId);
    assert.equal(login?.status, 'authorized');
    assert.equal(login?.account, 'me@firm.de');
    assert.deepEqual(hookCalls, ['claude']);
    assert.ok(detectCalls >= 2, 'exit 0 must re-run detection to confirm the credential');
  });

  it('exit 0 while pending but detection says NOT logged in → error, no hook', async () => {
    await start(CALLBACK_FLOW_OUTPUT);

    loggedIn = 'no';
    child.exit(0);
    await delay(20);

    const login = getActiveLogin();
    assert.equal(login?.status, 'error');
    assert.match(login?.error ?? '', /no active subscription session/i);
    assert.deepEqual(hookCalls, []);
  });

  it('non-zero exit → error carrying the output tail, no hook', async () => {
    await start(CALLBACK_FLOW_OUTPUT);

    child.print('Error: network unreachable while contacting the auth server\n');
    child.exit(1);
    await delay(20);

    const login = getActiveLogin();
    assert.equal(login?.status, 'error');
    assert.match(login?.error ?? '', /network unreachable/);
    assert.match(login?.error ?? '', /ended without signing in/i);
    assert.deepEqual(hookCalls, []);
  });

  // ── the race the review found ────────────────────────────────────────────

  it('exit handler and code submit racing → hook fires exactly once, submit reports authorized', async () => {
    const res = await start(REAL_2_1_187_OUTPUT);
    assert.equal(res.codeEntry, true);

    // Operator pastes the code; submit writes stdin and sleeps before its
    // first detection poll. The CLI accepts the code and exits 0 meanwhile.
    const submit = submitCliCode(res.sessionId, 'the-code');
    await delay(5);
    loggedIn = 'yes';
    child.exit(0);

    const result = await submit;
    assert.equal(result.status, 'authorized');
    assert.equal(result.account, 'me@firm.de');
    // One login, one hook — never two auto-assign runs / two reactivations.
    await delay(20);
    assert.deepEqual(hookCalls, ['claude']);
  });

  it('a second exit event on an already-authorized session does not re-fire the hook', async () => {
    await start(CALLBACK_FLOW_OUTPUT);
    loggedIn = 'yes';
    child.exit(0);
    await delay(20);
    assert.deepEqual(hookCalls, ['claude']);

    child.emit('exit', 0, null); // defensive: a duplicate signal must be inert
    await delay(20);
    assert.deepEqual(hookCalls, ['claude']);
    assert.equal(getActiveLogin()?.status, 'authorized');
  });

  // ── #1084: a wrong code must not break the retry ────────────────────────────

  it('#1084: invalid code keeps the session pending; the correct retry authorizes and fires the hook', async () => {
    const res = await start(REAL_2_1_187_OUTPUT);
    assert.equal(res.codeEntry, true);

    // First paste is wrong: the CLI says so and stays alive for another try.
    const bad = submitCliCode(res.sessionId, 'bad');
    setTimeout(() => child.print('Invalid code\n'), 5);
    const badResult = await bad;
    assert.equal(badResult.status, 'invalid');
    assert.equal(getActiveLogin()?.status, 'pending');

    // Second paste is right: the CLI accepts it and exits 0.
    const good = submitCliCode(res.sessionId, 'good');
    await delay(5);
    loggedIn = 'yes';
    child.exit(0);

    const goodResult = await good;
    assert.equal(goodResult.status, 'authorized');
    await delay(20);
    // Auto-assign (OM-79) must still run after a failed first attempt.
    assert.deepEqual(hookCalls, ['claude']);
  });

  // ── #1084: a submit against a session that already settled ─────────────────

  it('#1084: a code submitted after the callback already finished reports authorized, not a dead process', async () => {
    const res = await start(CALLBACK_FLOW_OUTPUT);
    assert.equal(res.codeEntry, true); // the code field is showing …
    loggedIn = 'yes';
    child.exit(0); // … while the browser callback completes the login
    await delay(20);
    assert.equal(getActiveLogin()?.status, 'authorized');

    const late = await submitCliCode(res.sessionId, 'late');
    assert.equal(late.status, 'authorized');
    assert.equal(late.account, 'me@firm.de');
    assert.deepEqual(hookCalls, ['claude'], 'the hook fired once, on the exit path');
    assert.equal(getActiveLogin(), undefined);
  });

  it('#1084: a code submitted after the process failed surfaces the stored error', async () => {
    const res = await start(REAL_2_1_187_OUTPUT);
    child.print('Error: token exchange failed\n');
    child.exit(1);
    await delay(20);

    const late = await submitCliCode(res.sessionId, 'late');
    assert.equal(late.status, 'error');
    assert.match(late.error ?? '', /token exchange failed/);
  });
});
