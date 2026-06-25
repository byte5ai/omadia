/**
 * In-app CLI login flow (#309, Phase B) — drives `claude auth login` from the
 * Web UI so a self-hoster never needs a terminal.
 *
 * The flow is two-leg, matching how the official CLI authenticates inside a
 * container (verified empirically against claude v2.1.187):
 *
 *   1. Spawn `claude auth login --claudeai`. The CLI prints an OAuth URL
 *      ("… visit: https://claude.com/cai/oauth/authorize?…") and then waits at
 *      a "Paste code here" prompt reading stdin. We capture the URL and hand it
 *      to the browser (leg OUT).
 *   2. The operator authenticates in their own browser and gets a login code.
 *      The UI posts it back; we write it to the login process's stdin (leg IN).
 *      A wrong code returns "Invalid code" and the process stays alive to retry;
 *      a correct code writes credentials to CLAUDE_CONFIG_DIR (the persisted
 *      volume) and the session becomes authorized.
 *
 * Hard rules:
 *  - **Subscription path only.** `--claudeai` (never `--console`) and the env is
 *    scrubbed of API-key vars (#309 §2 billing-precedence footgun).
 *  - **Code via stdin, never argv** (no leak through `ps`).
 *  - **Single active session.** Login is host-global state on a single sticky
 *    runtime; a second start replaces the first.
 *  - **No shell, bounded buffer, hard lifetime + idle timeouts.**
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { scrubbedEnv, detectCliBackends, __resetCliBackendCache } from './cliBackendDetector.js';

export type CliLoginStatus = 'pending' | 'authorized' | 'invalid' | 'expired' | 'error';

interface LoginSession {
  readonly id: string;
  readonly cliId: string;
  child: ChildProcessWithoutNullStreams | undefined;
  verificationUrl: string | undefined;
  status: CliLoginStatus;
  account?: string;
  error?: string;
  buffer: string;
  readonly createdAt: number;
  lifetimeTimer?: NodeJS.Timeout;
}

const MAX_BUFFER = 64 * 1024;
const URL_WAIT_MS = 12_000;
const SESSION_LIFETIME_MS = 5 * 60_000;
const CODE_RESULT_WAIT_MS = 15_000;
const STATUS_POLL_INTERVAL_MS = 1500;

let counter = 0;
let active: LoginSession | undefined;

/** Only Claude is wired for v1 (the only confirmed subscription-billed CLI). */
function assertSupported(cliId: string): void {
  if (cliId !== 'claude') {
    throw new Error(`Login is not supported for "${cliId}" yet.`);
  }
}

function disposeActive(): void {
  const s = active;
  if (!s) return;
  active = undefined; // clear first so re-entry + getActiveLogin are truthful
  if (s.lifetimeTimer) clearTimeout(s.lifetimeTimer);
  const child = s.child;
  s.child = undefined;
  if (child && child.exitCode === null) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    // Escalate to SIGKILL if it doesn't exit (a hung `claude auth login`).
    const kill = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
    if (typeof kill.unref === 'function') kill.unref();
  }
}

function append(session: LoginSession, chunk: string): void {
  session.buffer = (session.buffer + chunk).slice(-MAX_BUFFER);
}

export interface StartLoginResult {
  readonly sessionId: string;
  readonly verificationUrl: string;
}

/**
 * Spawn the login process and resolve once the OAuth URL is captured. Replaces
 * any in-flight session (single-operator, single sticky runtime).
 */
export async function startCliLogin(cliId: string): Promise<StartLoginResult> {
  assertSupported(cliId);

  // A logged-in CLI does not need re-login; surface that to the caller.
  const snap = await detectCliBackends({ force: true });
  const backend = snap.backends.find((b) => b.id === cliId);
  if (!backend?.installed) {
    throw new Error(`${cliId} is not installed in this environment.`);
  }

  disposeActive();

  const child = spawn(backend.bin, ['auth', 'login', '--claudeai'], {
    env: scrubbedEnv(),
    windowsHide: true,
  });

  const session: LoginSession = {
    id: `login-${++counter}-${child.pid ?? 'x'}`,
    cliId,
    child,
    verificationUrl: undefined,
    status: 'pending',
    buffer: '',
    createdAt: Date.now(),
  };
  active = session;

  session.lifetimeTimer = setTimeout(() => {
    // Dispose any still-active session at lifetime — pending OR invalid (an
    // "invalid code" leaves the child alive for a retry; if the operator walks
    // away it must still be reaped). Authorized sessions already disposed.
    if (active === session) {
      if (session.status === 'pending') session.status = 'expired';
      disposeActive();
    }
  }, SESSION_LIFETIME_MS);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => append(session, d));
  child.stderr.on('data', (d: string) => append(session, d));
  child.on('error', (err) => {
    session.status = 'error';
    session.error = err.message;
    if (active === session) disposeActive();
  });
  child.on('exit', () => {
    // If the process exits before authorization, mark it terminal and drop the
    // stale session so getActiveLogin reports the truth. A successful submit has
    // already flipped status to 'authorized' and disposed before this fires.
    if (session.status === 'pending') session.status = 'error';
    if (active === session && session.status !== 'authorized') disposeActive();
  });

  const url = await waitFor(() => extractUrl(session.buffer), URL_WAIT_MS);
  if (!url) {
    const detail = session.buffer.trim().split('\n').slice(-2).join(' ') || 'no output';
    disposeActive();
    throw new Error(`Could not start the login flow (${detail}).`);
  }
  session.verificationUrl = url;
  return { sessionId: session.id, verificationUrl: url };
}

/**
 * Write the operator's login code to the waiting process and report the result.
 * A wrong code keeps the session alive for another attempt.
 */
export async function submitCliCode(
  sessionId: string,
  code: string,
): Promise<{ status: CliLoginStatus; account?: string; error?: string }> {
  const session = active;
  if (!session || session.id !== sessionId) {
    return { status: 'expired', error: 'No active login session. Start again.' };
  }
  const child = session.child;
  if (!child || child.exitCode !== null) {
    return { status: 'expired', error: 'Login process is no longer running. Start again.' };
  }
  const trimmed = code.trim();
  if (!trimmed) return { status: 'invalid', error: 'Empty code.' };

  // Capture THIS attempt's output independently of the capped rolling buffer,
  // so the invalid-code check can't be confused by truncation or a prior attempt.
  let attemptOut = '';
  const onData = (d: Buffer | string): void => {
    attemptOut += d.toString();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  try {
    child.stdin.write(`${trimmed}\n`);
    const deadline = Date.now() + CODE_RESULT_WAIT_MS;
    while (Date.now() < deadline) {
      await delay(STATUS_POLL_INTERVAL_MS);

      // Authoritative success check FIRST — a confirmed login must win over any
      // lagging "invalid code" text (e.g. from a previous attempt).
      const snap = await detectCliBackends({ force: true });
      const backend = snap.backends.find((b) => b.id === session.cliId);
      if (backend?.loggedIn === 'yes') {
        session.status = 'authorized';
        if (backend.account) session.account = backend.account;
        const account = session.account;
        disposeActive();
        __resetCliBackendCache();
        return account ? { status: 'authorized', account } : { status: 'authorized' };
      }
      if (/invalid code/i.test(attemptOut)) {
        session.status = 'invalid';
        return { status: 'invalid', error: 'Invalid code. Copy the full code and try again.' };
      }
      if (child.exitCode !== null) {
        session.status = 'error';
        return { status: 'error', error: 'The login process ended before sign-in completed. Start again.' };
      }
    }
    return { status: 'pending', error: 'Still waiting. If you authorized in the browser, re-check status.' };
  } finally {
    child.stdout.off('data', onData);
    child.stderr.off('data', onData);
  }
}

export function getActiveLogin(): { sessionId: string; status: CliLoginStatus; verificationUrl?: string } | undefined {
  if (!active) return undefined;
  return {
    sessionId: active.id,
    status: active.status,
    ...(active.verificationUrl ? { verificationUrl: active.verificationUrl } : {}),
  };
}

export function cancelCliLogin(): void {
  disposeActive();
}

/** Run `claude auth logout`, then bust the detection cache. */
export async function cliLogout(cliId: string): Promise<{ ok: boolean }> {
  assertSupported(cliId);
  disposeActive();
  const snap = await detectCliBackends({ force: true });
  const backend = snap.backends.find((b) => b.id === cliId);
  if (!backend?.installed) return { ok: true };
  await new Promise<void>((resolve) => {
    const c = spawn(backend.bin, ['auth', 'logout'], { env: scrubbedEnv(), windowsHide: true });
    c.on('error', () => resolve());
    c.on('exit', () => resolve());
    setTimeout(() => {
      try {
        c.kill();
      } catch {
        /* noop */
      }
      resolve();
    }, 8000);
  });
  __resetCliBackendCache();
  return { ok: true };
}

function extractUrl(buf: string): string | undefined {
  return buf.match(/https:\/\/claude\.com\/\S+/)?.[0];
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = probe();
    if (v) return v;
    await delay(250);
  }
  return probe();
}

/** Test seam. */
export function __resetCliAuthState(): void {
  disposeActive();
  counter = 0;
}
