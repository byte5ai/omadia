/**
 * OM-73 (#995) — `claude auth login` exit handling and flow detection.
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
 *   - `codeEntry`: false for the real 2.1.259 output (callback lines + a
 *     "Paste code here if prompted" fallback), true for a bare paste prompt,
 *     false for a URL with no signature at all; start resolves as soon as a
 *     signature shows up rather than waiting out the probe window.
 *
 * Fixture strings are the ones the claude 2.1.259 bundle prints
 * (`~/.local/share/claude/versions/2.1.259`, extracted with `strings`, the
 * CLI itself is never run here). A fake ChildProcess (EventEmitter +
 * PassThrough streams) stands in for `spawn`, a scripted detector for
 * `detectCliBackends`, both via the module's injection seam.
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

// ── Real 2.1.259 output, verbatim ─────────────────────────────────────────────
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc';
const OPENING_BROWSER = 'Opening browser to sign in…\n';
const WAITING_FOR_BROWSER = 'Waiting for browser authorization…\n';
const IF_BROWSER_DIDNT_OPEN = `If the browser didn't open, visit: ${URL}\n`;
const PASTE_IF_PROMPTED = 'Paste code here if prompted > ';
/** What the 2.1.259 bundle prints for `claude auth login --claudeai`. */
const CALLBACK_FLOW_OUTPUT =
  OPENING_BROWSER + WAITING_FOR_BROWSER + IF_BROWSER_DIDNT_OPEN + PASTE_IF_PROMPTED;
/** Older paste-code flow (≤ 2.1.187): URL, then a stdin prompt, no callback. */
const PASTE_FLOW_OUTPUT = `Please visit: ${URL}\nPaste code here > `;
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

  it('2.1.259 output (callback lines + "if prompted" paste) → codeEntry=false', async () => {
    const res = await start(CALLBACK_FLOW_OUTPUT);
    assert.equal(res.codeEntry, false);
    assert.equal(res.status, 'pending');
    assert.equal(res.verificationUrl, URL);
  });

  it('bare paste prompt without any callback line → codeEntry=true', async () => {
    const res = await start(PASTE_FLOW_OUTPUT);
    assert.equal(res.codeEntry, true);
    assert.equal(res.status, 'pending');
  });

  it('URL with no signature at all → codeEntry=false after the probe window', async () => {
    const res = await start(URL_ONLY_OUTPUT);
    assert.equal(res.codeEntry, false);
  });

  it('start resolves as soon as a signature appears, not after the full probe window', async () => {
    install(1500); // long window; a signature must cut it short
    const t0 = Date.now();
    await start(CALLBACK_FLOW_OUTPUT);
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
    const res = await start(PASTE_FLOW_OUTPUT);
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
});
