import type { SessionEvaluation } from '../auth/requireAuth.js';
import {
  SESSION_CHECK_UNAVAILABLE_CODE,
  type SessionRevocation,
} from '../auth/sessionRevocation.js';
import {
  closeForRefusal,
  withDeadline,
  type SessionCloseReason,
} from '../channels/channelSessionCheck.js';
import {
  MAX_TIMER_MS,
  WS_SESSION_CHECK_TIMEOUT_MS,
} from '../channels/channelSessionLifetime.js';

/**
 * Session lifetime of a server-sent-events stream: the stream stays open
 * exactly as long as the session that opened it. `requireAuth` checks the
 * session once, when the request arrives; from then on this watch holds it to
 * the same levers `ChannelSessionTracker` applies to channel WebSockets.
 *
 * - **Expiry.** The stream ends at the token's `exp` (a timer, re-armed past
 *   setTimeout's ceiling). `isCurrent` turns false at `exp` even if that timer
 *   runs late, so the route writes nothing after it.
 * - **Revocation, this replica.** `SessionRevocation.onRevoked` (sign-out,
 *   password reset, disable, delete) ends that user's streams at once.
 * - **Revocation, every replica.** The announcement is process-local, so
 *   `check` runs `evaluateSessionToken` again (the verdict path HTTP uses).
 *   The route calls it right after the stream opens and with every heartbeat.
 *   A revoked session or a de-whitelisted identity ends the stream, and so
 *   does a token that no longer verifies.
 * - **No verdict.** A check that fails, throws or misses its deadline
 *   ({@link WS_SESSION_CHECK_TIMEOUT_MS}) is an outage, not a verdict: the
 *   stream stays open, still bounded by its expiry, and the next heartbeat
 *   checks again. A refusal that arrives after the deadline still ends it.
 * - **After the end.** `onEnd` runs once; the expiry timer and the revocation
 *   listener are gone. `dispose` does the same without `onEnd`, for a stream
 *   whose transport closed first.
 */

export interface StreamSessionDeps {
  /**
   * Re-evaluates the held token. `index.ts` wires `evaluateSessionToken` with
   * `requireAuth`'s own deps, so a stream and an HTTP request can never
   * disagree on whether a session still stands.
   */
  evaluate(token: string): Promise<SessionEvaluation>;
  /** Push side of server-side revocation on this replica. */
  revocations: Pick<SessionRevocation, 'onRevoked'>;
  /** Deadline for one check, in ms. Default {@link WS_SESSION_CHECK_TIMEOUT_MS}. */
  checkTimeoutMs?: number;
}

/** The session a stream was opened with. */
export interface StreamSession {
  /** The session cookie the request presented. */
  readonly token: string;
  readonly provider: string;
  readonly sub: string;
  /** The token's `exp`, Unix epoch seconds. */
  readonly expiresAt: number;
}

export interface StreamSessionWatch {
  /** False once the session ended. Past `exp` it ends the watch first. */
  isCurrent(): boolean;
  /** Check the session again. A check already running is not doubled. */
  check(): void;
  /** Stop watching without `onEnd`. Idempotent. */
  dispose(): void;
}

export function watchStreamSession(
  session: StreamSession,
  deps: StreamSessionDeps,
  onEnd: (reason: SessionCloseReason) => void,
): StreamSessionWatch {
  const checkTimeoutMs = deps.checkTimeoutMs ?? WS_SESSION_CHECK_TIMEOUT_MS;
  let done = false;
  let checking = false;
  let expiryTimer: NodeJS.Timeout | undefined;

  const stopListening = deps.revocations.onRevoked((who) => {
    if (who.provider === session.provider && who.sub === session.sub) {
      end('session revoked');
    }
  });

  function dispose(): void {
    if (done) return;
    done = true;
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    stopListening();
  }

  function end(reason: SessionCloseReason): void {
    if (done) return;
    dispose();
    onEnd(reason);
  }

  function pastExpiry(): boolean {
    return Date.now() >= session.expiresAt * 1000;
  }

  // Never ends inside this call: a session already past `exp` ends on the
  // next timer tick, after the route has finished wiring the stream.
  function armExpiry(): void {
    const remaining = session.expiresAt * 1000 - Date.now();
    const timer = setTimeout(
      () => {
        if (done) return;
        if (pastExpiry()) end('session expired');
        else armExpiry();
      },
      Math.min(Math.max(remaining, 0), MAX_TIMER_MS),
    );
    timer.unref();
    expiryTimer = timer;
  }

  function applyVerdict(result: SessionEvaluation): void {
    if (done || result.ok) return;
    const refusal = closeForRefusal(result.code, session.expiresAt);
    if (refusal === undefined) {
      console.warn('[builder] event stream session check unavailable, stream kept until the next check');
      return;
    }
    end(refusal.reason);
  }

  async function runCheck(): Promise<void> {
    const evaluation = evaluateOrOutage(deps, session.token);
    const result = await withDeadline(evaluation, checkTimeoutMs);
    checking = false;
    if (result !== undefined) {
      applyVerdict(result);
      return;
    }
    console.warn(
      `[builder] event stream session check timed out after ${String(checkTimeoutMs)} ms`,
    );
    void evaluation.then(applyVerdict);
  }

  armExpiry();

  return {
    isCurrent(): boolean {
      if (done) return false;
      if (!pastExpiry()) return true;
      end('session expired');
      return false;
    },
    check(): void {
      if (done || checking) return;
      checking = true;
      void runCheck();
    },
    dispose,
  };
}

/** Run `evaluate`, reading a throw (synchronous or not) as an outage. */
async function evaluateOrOutage(
  deps: StreamSessionDeps,
  token: string,
): Promise<SessionEvaluation> {
  try {
    return await deps.evaluate(token);
  } catch (err) {
    console.error(
      `[builder] event stream session check threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, code: SESSION_CHECK_UNAVAILABLE_CODE, message: 'session check failed' };
  }
}
