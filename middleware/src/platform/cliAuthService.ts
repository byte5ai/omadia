/**
 * In-app CLI login flow (#309, Phase B) — drives `claude auth login` from the
 * Web UI so a self-hoster never needs a terminal.
 *
 * Two CLI generations, one flow (OM-73, #995; #1084):
 *
 *   1. Spawn `claude auth login --claudeai`. The CLI prints an OAuth URL
 *      ("… visit: https://claude.com/cai/oauth/authorize?…"). We capture it and
 *      hand it to the browser (leg OUT).
 *   2a. The CLI bundled in the image (v2.1.187) prints "Opening browser…" and
 *       "If the browser didn't open, visit: …" and then waits at a "Paste code
 *       here if prompted" stdin prompt: its URL carries `code=true` and the
 *       platform.claude.com callback, so the browser shows a code and nothing
 *       reaches the CLI but stdin. The operator copies the code, the UI posts
 *       it back and we write it to stdin (leg IN). A wrong code returns
 *       "Invalid code" and the process stays alive to retry.
 *   2b. NEWER CLIs (v2.1.246+) can finish the login through a localhost
 *       callback in the operator's browser, print no code and exit 0 on their
 *       own; they still print the same paste prompt as a fallback.
 *
 *   The paste prompt decides (#1084): whenever it appears, `startCliLogin`
 *   reports `codeEntry: true` and the UI shows the code field. The UI polls
 *   `getActiveLogin` in parallel in every mode, so a login finished through
 *   the callback still resolves, and the polling-only view (no prompt seen)
 *   still offers a fallback code field. The browser lines are printed by both
 *   generations and carry no signal.
 *
 * Either way, once a login succeeds the `authorized` hook fires (OM-79, #994):
 * the subscription is connected but no orchestrator points at it yet, and the
 * hook is where the platform re-assigns the credential-less plugins to the CLI.
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

import {
  scrubbedEnv,
  detectCliBackends,
  resolveCliBin,
  __resetCliBackendCache,
} from './cliBackendDetector.js';

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
  /** OM-79 — the post-login hook fires at most once per session, on the
   *  pending → authorized transition, whichever path (exit handler or code
   *  submit) gets there first. */
  hookFired: boolean;
}

const MAX_BUFFER = 64 * 1024;
const URL_WAIT_MS = 12_000;
const SESSION_LIFETIME_MS = 5 * 60_000;
const CODE_RESULT_WAIT_MS = 15_000;
const STATUS_POLL_INTERVAL_MS = 1500;
/** After the URL is captured, how long to watch for a "paste code" prompt
 *  before concluding this CLI finishes via a browser callback (no code). */
const CODE_PROMPT_PROBE_MS = 2500;

/**
 * Injection seam. Production uses the real child_process + detector; tests
 * swap in a fake ChildProcess and a scripted detector so the exit-code paths
 * (OM-73) are unit-testable without spawning anything.
 */
interface CliAuthDeps {
  readonly spawn: typeof spawn;
  readonly detectCliBackends: typeof detectCliBackends;
  readonly resolveCliBin: typeof resolveCliBin;
  /** Upper bound on watching for a flow signature after the URL appears. */
  readonly codePromptProbeMs: number;
  /** Cadence of the detection poll inside `submitCliCode`. */
  readonly statusPollIntervalMs: number;
}
const DEFAULT_DEPS: CliAuthDeps = {
  spawn,
  detectCliBackends,
  resolveCliBin,
  codePromptProbeMs: CODE_PROMPT_PROBE_MS,
  statusPollIntervalMs: STATUS_POLL_INTERVAL_MS,
};
let io: CliAuthDeps = DEFAULT_DEPS;

/** Test seam: override any dependency; call with no argument to restore. */
export function __setCliAuthDepsForTests(over?: Partial<CliAuthDeps>): void {
  io = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

let counter = 0;
let active: LoginSession | undefined;

/**
 * Fired once, after a login is confirmed `authorized`. Set by the middleware
 * bootstrap (OM-79): a fresh subscription login leaves every LLM plugin still
 * pointing at a keyless `anthropic` provider, so this is where they get
 * re-assigned to the CLI. Failure inside the hook must never turn a successful
 * login into an error — the caller wraps it and logs.
 */
type LoginAuthorizedHook = (cliId: string) => void | Promise<void>;
let authorizedHook: LoginAuthorizedHook | undefined;

/** Register the post-login hook. Passing `undefined` clears it (tests). */
export function setCliLoginAuthorizedHook(hook: LoginAuthorizedHook | undefined): void {
  authorizedHook = hook;
}

function fireAuthorizedHook(cliId: string): void {
  const hook = authorizedHook;
  if (!hook) return;
  // Detached: a slow or throwing hook must not block or fail the login result.
  void (async () => {
    try {
      await hook(cliId);
    } catch (err) {
      console.warn(
        `[cliAuth] post-login hook failed for ${cliId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/**
 * The paste-prompt signature in the CLI's opening output. Both generations
 * print one (see test fixtures):
 *
 *   2.1.187 (bundled in the image)        2.1.259
 *   Opening browser to sign in…           Opening browser to sign in…
 *   If the browser didn't open, visit: …  Waiting for browser authorization…
 *   Paste code here if prompted >         If the browser didn't open, visit: …
 *                                         Paste code here if prompted >
 *
 * #1084 — an earlier rule let the "Opening browser" / "If the browser didn't
 * open" lines veto the prompt. 2.1.187 prints both and then waits ONLY on
 * stdin, so the UI showed no code field and the login could not finish. A
 * prompt now always means code entry; the UI polls alongside it, so a CLI that
 * finishes through the browser callback instead still resolves.
 */
const PASTE_SIGNATURE = /paste code here|enter the code|authorization code/i;

function hasPasteSignature(buf: string): boolean {
  return PASTE_SIGNATURE.test(buf);
}

/**
 * The one place a session becomes `authorized`. Returns `true` only on the
 * actual pending → authorized transition; a second caller (the exit handler and
 * `submitCliCode` can race, see OM-73) gets `false` and must not fire the hook
 * again. `__resetCliBackendCache` runs on the transition so the next detection
 * reads the fresh credential.
 */
function markAuthorized(session: LoginSession, account: string | undefined): boolean {
  if (session.status !== 'pending') return false;
  session.status = 'authorized';
  if (account) session.account = account;
  __resetCliBackendCache();
  if (!session.hookFired) {
    session.hookFired = true;
    fireAuthorizedHook(session.cliId);
  }
  return true;
}

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
  /** OM-73 / #1084 — whether the CLI printed a paste-code prompt. `true`
   *  ⇒ the UI shows the code field (and polls alongside it); `false` ⇒ no
   *  prompt was seen, the UI polls the login status and offers the code
   *  field only as a secondary fallback. */
  readonly codeEntry: boolean;
  /** The login already completed before the UI could react (very fast browser
   *  callback). The UI can go straight to "connected". */
  readonly status: CliLoginStatus;
}

/**
 * Spawn the login process and resolve once the OAuth URL is captured. Replaces
 * any in-flight session (single-operator, single sticky runtime).
 */
export async function startCliLogin(cliId: string): Promise<StartLoginResult> {
  assertSupported(cliId);

  // A logged-in CLI does not need re-login; surface that to the caller.
  const snap = await io.detectCliBackends({ force: true });
  const backend = snap.backends.find((b) => b.id === cliId);
  if (!backend?.installed) {
    throw new Error(`${cliId} is not installed in this environment.`);
  }

  disposeActive();

  // Resolve through the runtime install dir so a CLI installed in-app is
  // spawnable even when it is not on PATH.
  const child = io.spawn(io.resolveCliBin(backend.bin), ['auth', 'login', '--claudeai'], {
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
    hookFired: false,
  };
  active = session;

  session.lifetimeTimer = setTimeout(() => {
    // Dispose any still-active session at lifetime: a pending one (including
    // after an "invalid code", which keeps the child alive and the session
    // pending for a retry, #1084) and a terminal error kept for a polling UI.
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
  child.on('exit', (code) => {
    // OM-73 — the newer CLI (v2.1.246+) finishes the login through a localhost
    // browser callback and exits ON ITS OWN, with no code ever pasted. The old
    // handler marked any still-`pending` session `error`, so a SUCCESSFUL login
    // was recorded as a failure and the session dropped. Read the exit code:
    //   * exit 0 while pending → the CLI completed; confirm via detection and
    //     mark `authorized` (fires the post-login hook, OM-79).
    //   * non-zero → a real failure; keep the last output for the operator.
    // No ordering guarantee with `submitCliCode` (older flow): both may observe
    // `pending` and both call `markAuthorized`, which only transitions once and
    // fires the hook once. A session already `authorized`/`error` is left as
    // it is.
    if (session.status === 'pending') {
      if (code === 0) {
        void confirmAuthorizedAfterExit(session);
        return;
      }
      session.status = 'error';
      const tail = session.buffer.trim().split('\n').slice(-2).join(' ');
      session.error = tail
        ? `The login process ended without signing in: ${tail}`
        : 'The login process ended without signing in. Start again.';
      // Keep the terminal session visible: a UI polling the status (callback
      // flow) must see `error` + the message, not an `idle` that hides it. The
      // process is gone, so there is nothing to kill; the lifetime timer reaps.
      session.child = undefined;
      return;
    }
    if (active === session && session.status !== 'authorized') disposeActive();
  });

  const url = await waitFor(() => extractUrl(session.buffer), URL_WAIT_MS);
  if (!url) {
    // The process may have completed a cached/instant login and exited 0 before
    // ever printing a URL — that is a success, not a start failure.
    if (session.status === 'authorized') {
      return {
        sessionId: session.id,
        verificationUrl: '',
        codeEntry: false,
        status: 'authorized',
      };
    }
    const detail = session.buffer.trim().split('\n').slice(-2).join(' ') || 'no output';
    disposeActive();
    throw new Error(`Could not start the login flow (${detail}).`);
  }
  session.verificationUrl = url;

  // Does a stdin code prompt follow? Resolve as soon as the paste prompt shows
  // up so the start response is never held for the full probe window; the
  // window only caps a CLI that prints the URL and no prompt. Browser lines do
  // NOT end the probe (#1084): the prompt can arrive in a later stdout chunk,
  // and breaking on the first line would misread a prompting CLI as
  // callback-only.
  const promptDeadline = Date.now() + io.codePromptProbeMs;
  while (Date.now() < promptDeadline) {
    if (session.status !== 'pending') break; // exited (authorized or error)
    if (hasPasteSignature(session.buffer)) break;
    await delay(100);
  }
  const codeEntry = hasPasteSignature(session.buffer);
  return {
    sessionId: session.id,
    verificationUrl: url,
    codeEntry,
    status: session.status,
  };
}

/**
 * The login process exited 0 while still `pending` (newer browser-callback
 * flow). Confirm the credential actually landed before declaring success, then
 * flip to `authorized` and fire the post-login hook.
 */
async function confirmAuthorizedAfterExit(session: LoginSession): Promise<void> {
  try {
    const snap = await io.detectCliBackends({ force: true });
    // Detection is async; `submitCliCode` may have settled the session while we
    // waited. Only a still-pending session is ours to transition.
    if (session.status !== 'pending') return;
    const backend = snap.backends.find((b) => b.id === session.cliId);
    if (backend?.loggedIn === 'yes') {
      markAuthorized(session, backend.account);
      session.child = undefined; // process already exited
      // Keep the session active (not disposed) so a UI polling getActiveLogin
      // sees `authorized`. The lifetime timer reaps it; the next login replaces
      // it. The child is already gone, so there is nothing to kill.
      return;
    }
    // Exited 0 but detection cannot confirm a login — do not claim success.
    session.status = 'error';
    session.error =
      'The login process ended, but no active subscription session was found. Start again.';
  } catch (err) {
    session.status = 'error';
    session.error = err instanceof Error ? err.message : String(err);
  }
  // Error path: the process is gone; keep the terminal session so a polling UI
  // reads `error` + message (the lifetime timer or the next login reaps it).
  session.child = undefined;
}

/**
 * Write the operator's login code to the waiting process and report the result.
 * A wrong code keeps the session alive AND `pending` for another attempt.
 */
export async function submitCliCode(
  sessionId: string,
  code: string,
): Promise<{ status: CliLoginStatus; account?: string; error?: string }> {
  const session = active;
  if (!session || session.id !== sessionId) {
    return { status: 'expired', error: 'No active login session. Start again.' };
  }
  // The session outlives its process on purpose (see the exit handler). Since
  // #1084 the code field shows while the browser callback may still complete,
  // so report a settled session as it is, not as a dead process. (A local
  // copy: narrowing `session.status` here would break the loop's re-checks.)
  const settled = session.status;
  if (settled === 'authorized') {
    const account = session.account;
    disposeActive();
    return account ? { status: 'authorized', account } : { status: 'authorized' };
  }
  if (settled === 'error') {
    return { status: 'error', error: session.error ?? 'The login process ended before sign-in completed. Start again.' };
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
      await delay(io.statusPollIntervalMs);

      // The exit handler may have confirmed the login while we slept (the CLI
      // exits 0 after a correct code). It already fired the hook; just report.
      if (session.status === 'authorized') {
        const account = session.account;
        disposeActive();
        return account ? { status: 'authorized', account } : { status: 'authorized' };
      }
      if (session.status === 'error') {
        return { status: 'error', error: session.error ?? 'The login process ended before sign-in completed. Start again.' };
      }

      // Authoritative success check — a confirmed login must win over any
      // lagging "invalid code" text (e.g. from a previous attempt).
      const snap = await io.detectCliBackends({ force: true });
      const backend = snap.backends.find((b) => b.id === session.cliId);
      if (backend?.loggedIn === 'yes') {
        // OM-79 — `markAuthorized` fires the hook exactly once, even if the
        // exit handler transitioned the session while detection was in flight.
        markAuthorized(session, backend.account);
        const account = session.account;
        disposeActive();
        return account ? { status: 'authorized', account } : { status: 'authorized' };
      }
      if (/invalid code/i.test(attemptOut)) {
        // #1084 — `invalid` is this attempt's result, not the session's state.
        // Persisting it made `markAuthorized` (pending-only) refuse the correct
        // retry, so the post-login hook (auto-assign, OM-79) never fired, and
        // made the exit handler dispose the session instead of confirming it.
        return { status: 'invalid', error: 'Invalid code. Copy the full code and try again.' };
      }
      // exit 0 while still pending is being confirmed by the exit handler —
      // keep waiting for it to settle. Only a non-zero exit is a failure here.
      if (child.exitCode !== null && child.exitCode !== 0) {
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

export function getActiveLogin(): {
  sessionId: string;
  status: CliLoginStatus;
  verificationUrl?: string;
  account?: string;
  error?: string;
} | undefined {
  if (!active) return undefined;
  return {
    sessionId: active.id,
    status: active.status,
    ...(active.verificationUrl ? { verificationUrl: active.verificationUrl } : {}),
    ...(active.account ? { account: active.account } : {}),
    ...(active.error ? { error: active.error } : {}),
  };
}

export function cancelCliLogin(): void {
  disposeActive();
}

/** Run `claude auth logout`, then bust the detection cache. */
export async function cliLogout(cliId: string): Promise<{ ok: boolean }> {
  assertSupported(cliId);
  disposeActive();
  const snap = await io.detectCliBackends({ force: true });
  const backend = snap.backends.find((b) => b.id === cliId);
  if (!backend?.installed) return { ok: true };
  await new Promise<void>((resolve) => {
    const c = io.spawn(io.resolveCliBin(backend.bin), ['auth', 'logout'], { env: scrubbedEnv(), windowsHide: true });
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
