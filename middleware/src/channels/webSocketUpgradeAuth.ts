import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Pre-handshake authentication for {@link WebSocketRegistry} upgrades. Every
 * outcome other than a principal is a raw status line on the upgraded socket
 * followed by `destroy()`, so a rejected peer never sees a `101`.
 */

/** Outcome of a pre-handshake authenticator. */
export type WebSocketAuthResult<TPrincipal> =
  | { ok: true; principal: TPrincipal }
  /**
   * `message` is for the server log only; the status line always carries the
   * standard reason phrase, so it can never inject header bytes.
   */
  | { ok: false; status: 401 | 403; message?: string };

/**
 * Runs on the raw upgrade request BEFORE the handshake. Resolving `ok: false`
 * rejects the upgrade with that status. Throwing (or missing the route's
 * deadline) rejects it with 503: an outage must not read as a bad credential.
 */
export type WebSocketAuthenticator<TPrincipal> = (
  req: IncomingMessage,
) => Promise<WebSocketAuthResult<TPrincipal>>;

export type RejectStatus = 401 | 403 | 404 | 503;

const REASON_PHRASE: Readonly<Record<RejectStatus, string>> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};

/** Reject an upgrade pre-handshake: write a raw status line, then destroy. */
export function rejectUpgrade(socket: Duplex, code: RejectStatus): void {
  socket.write(`HTTP/1.1 ${code} ${REASON_PHRASE[code]}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

class AuthTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`no result within ${String(timeoutMs)} ms`);
    this.name = 'AuthTimeoutError';
  }
}

/** Resolve with the authenticator's result, or reject once `timeoutMs` passes. */
async function withDeadline<T>(pending: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return pending;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, rejectDeadline) => {
    timer = setTimeout(() => rejectDeadline(new AuthTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run an authenticator against the raw upgrade request. Returns the principal
 * on success; otherwise writes the raw rejection (no 101) and returns
 * `undefined`. An authenticator that throws, misses `timeoutMs` or returns
 * something that is not a result fails closed with 503.
 */
export async function authenticateBeforeHandshake<TPrincipal>(
  authenticate: WebSocketAuthenticator<TPrincipal>,
  req: IncomingMessage,
  socket: Duplex,
  path: string,
  timeoutMs?: number,
): Promise<{ principal: TPrincipal } | undefined> {
  // Node removes its own socket error handler before emitting `upgrade`; guard
  // the auth window so a peer resetting mid-auth can't raise an uncaught error.
  const onEarlyError = (): void => undefined;
  socket.on('error', onEarlyError);
  let status: 401 | 403 | 503;
  try {
    const result: WebSocketAuthResult<TPrincipal> | undefined = await withDeadline(
      authenticate(req),
      timeoutMs,
    );
    if (result?.ok === true) return { principal: result.principal };
    if (result?.ok !== false) {
      throw new TypeError(`authenticator returned a non-result (${typeof result})`);
    }
    // Anything but an explicit 403 is a 401 (a JS caller could return junk).
    status = result.status === 403 ? 403 : 401;
    if (result.message) {
      // JSON-quoted: an authenticator-supplied reason must not forge log lines.
      console.warn(
        `[channels] websocket upgrade rejected on ${path} (${status}): ${JSON.stringify(result.message)}`,
      );
    }
  } catch (err: unknown) {
    const what = err instanceof AuthTimeoutError ? 'timed out' : 'threw';
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[channels] websocket authenticator ${what} on ${path}: ${detail}`);
    status = 503;
  } finally {
    socket.removeListener('error', onEarlyError);
  }
  rejectUpgrade(socket, status);
  return undefined;
}
