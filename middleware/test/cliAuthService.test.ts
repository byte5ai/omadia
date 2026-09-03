/**
 * OM-73 (#995) — `claude auth login` exit handling.
 *
 * The newer Claude CLI (v2.1.246+) completes the login through a browser
 * callback and exits 0 without ever printing a paste code. The old exit
 * handler marked any still-`pending` session `error`, so a SUCCESSFUL login
 * was recorded as a failure. These tests pin the contract down:
 *
 *   - exit 0 while pending, detection confirms → `authorized`, hook fires once
 *   - exit 0 while pending, detection says no   → `error`, clear message, no hook
 *   - non-zero exit                             → `error` carrying the output tail
 *   - `codeEntry` false for browser-callback wording, true for a paste prompt
 *
 * A fake ChildProcess (EventEmitter + PassThrough streams) stands in for
 * `spawn`, and a scripted detector for `detectCliBackends`, through the
 * module's injection seam. Nothing is spawned.
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

const URL_LINE = 'Please visit: https://claude.com/cai/oauth/authorize?code=abc\n';
const CALLBACK_LINE = 'Waiting for the browser to complete sign-in...\n';
const PASTE_LINE = 'Paste code here if prompted > ';

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

describe('cliAuthService — OM-73 exit-code handling', () => {
  let child: FakeChild;
  let loggedIn: 'yes' | 'no';
  let hookCalls: string[];
  let detectCalls: number;

  beforeEach(() => {
    __resetCliAuthState();
    child = new FakeChild();
    loggedIn = 'no';
    hookCalls = [];
    detectCalls = 0;
    __setCliAuthDepsForTests({
      spawn: (() => child) as unknown as typeof spawn,
      resolveCliBin: (bin: string) => bin,
      detectCliBackends: async () => {
        detectCalls += 1;
        return snapshot(loggedIn);
      },
      // Short probe so the callback-flow tests do not wait 2.5s.
      codePromptProbeMs: 120,
    });
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
  async function start(afterUrl: string) {
    const pending = startCliLogin('claude');
    setTimeout(() => child.print(URL_LINE + afterUrl), 5);
    return pending;
  }

  it('reports codeEntry=false for the browser-callback wording', async () => {
    const res = await start(CALLBACK_LINE);
    assert.equal(res.codeEntry, false);
    assert.equal(res.status, 'pending');
    assert.match(res.verificationUrl, /^https:\/\/claude\.com\//);
  });

  it('reports codeEntry=true when the CLI shows a paste-code prompt', async () => {
    const res = await start(PASTE_LINE);
    assert.equal(res.codeEntry, true);
    assert.equal(res.status, 'pending');
  });

  it('exit 0 while pending + detection confirms → authorized, hook fires once', async () => {
    const res = await start(CALLBACK_LINE);
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
    await start(CALLBACK_LINE);

    loggedIn = 'no';
    child.exit(0);
    await delay(20);

    const login = getActiveLogin();
    assert.equal(login?.status, 'error');
    assert.match(login?.error ?? '', /no active subscription session/i);
    assert.deepEqual(hookCalls, []);
  });

  it('non-zero exit → error carrying the output tail, no hook', async () => {
    await start(CALLBACK_LINE);

    child.print('Error: network unreachable while contacting the auth server\n');
    child.exit(1);
    await delay(20);

    const login = getActiveLogin();
    assert.equal(login?.status, 'error');
    assert.match(login?.error ?? '', /network unreachable/);
    assert.match(login?.error ?? '', /ended without signing in/i);
    assert.deepEqual(hookCalls, []);
  });
});
