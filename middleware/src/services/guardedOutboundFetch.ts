/**
 * The default `fetch` for MCP's OAuth/discovery traffic — SSRF-safe at CONNECT
 * time, not merely at check time.
 *
 * Why this exists rather than `globalThis.fetch` plus `assertPublicHttpsUrl`:
 *
 * `assertPublicHttpsUrl` resolves the hostname and inspects the addresses, then
 * the caller performs a SEPARATE `fetch` that resolves the hostname AGAIN. Two
 * lookups mean two answers. A hostile authorization server points
 * `oauth.attacker.example` at a public address for the guard's lookup and at
 * `127.0.0.1`, an RFC1918 host, or `169.254.169.254` for the fetch's — classic
 * DNS rebinding. `redirect: 'error'` does not help; no redirect is involved.
 * `assertPublicHttpsUrl` also swallows lookup failures on purpose ("the fetch
 * fails loudly anyway"), so an NXDOMAIN for the guard and a real record for the
 * fetch walks straight through.
 *
 * That matters more here than almost anywhere else in the codebase: the OAuth
 * path POSTs authorization codes, PKCE verifiers, refresh tokens and client
 * secrets to whatever host it ends up connected to.
 *
 * `createGuardedAgent()` (platform/ssrfGuard.ts) already solves this and is
 * already used by `conductor/webhookOutbound.ts`: its custom `lookup` resolves
 * the name, refuses the connection if ANY resolved address is non-public, fails
 * CLOSED on a lookup error, and hands undici exactly the address it validated —
 * so there is no window between validation and connect. This module is only the
 * thin adapter that makes it the default for the MCP OAuth clients.
 *
 * `assertPublicHttpsUrl` stays at those call sites as a cheap literal-host
 * pre-check (it rejects `https://10.0.0.5/` with no DNS at all, and gives a
 * better error). It is no longer what enforces the boundary.
 */

import { isIP } from 'node:net';
import { fetch as undiciFetch, type Agent } from 'undici';

import { createGuardedAgent, isPublicIp } from '../platform/ssrfGuard.js';

/** Thrown before a socket is opened. Distinct from a transport error so a
 *  caller can tell "we refused to go there" from "we went and it failed". */
export class BlockedOutboundAddressError extends Error {
  constructor(host: string) {
    super(`SSRF guard: refused to fetch a non-public address (${host})`);
    this.name = 'BlockedOutboundAddressError';
  }
}

/**
 * The half `createGuardedAgent()` structurally cannot cover.
 *
 * undici only calls the dispatcher's `lookup` when the host is a NAME. Give it
 * `http://127.0.0.1/` and there is nothing to resolve, so the guarded lookup
 * never runs and the connection proceeds. `platform/ssrfGuard.ts` says as much
 * in its header — layer 1 is "a literal-IP pre-check in the accessor" — but that
 * left the check as something each caller had to remember.
 *
 * Doing it here instead means the export is safe on its own terms, rather than
 * safe only in combination with an `assertPublicHttpsUrl` call the next caller
 * might not copy.
 */
function assertLiteralHostAllowed(input: Parameters<typeof fetch>[0]): void {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return; // Malformed — let fetch produce its own error.
  }
  // `URL.hostname` keeps IPv6 in brackets; `isIP` wants them off.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0 && !isPublicIp(bare)) {
    throw new BlockedOutboundAddressError(bare);
  }
}

/**
 * Read a response body as text, refusing anything over `maxBytes` WITHOUT
 * buffering it first.
 *
 * `await res.text()` followed by a length check is not a cap — by the time the
 * check runs the whole body is already resident. A discovered authorization
 * server can stream hundreds of megabytes inside the request timeout and the
 * process allocates all of it before deciding it was too big.
 *
 * Returns `null` when the body exceeds the cap, so callers treat "too large"
 * exactly as they already treat "unusable document".
 */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const body: ReadableStream<Uint8Array> | null = res.body;
  if (body === null) {
    // No stream to meter (an empty body, or a hand-built `Response` in a test
    // fake). Fall back to the buffered read plus the same cap — no worse than
    // before, and unreachable for real network responses.
    const text = await res.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling immediately; the socket is torn down rather than drained.
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Built once and reused: a fresh `Agent` per request would discard undici's
 *  connection pool and leak sockets under any real call volume. */
let agent: Agent | undefined;

function guardedAgent(): Agent {
  agent ??= createGuardedAgent();
  return agent;
}

/**
 * `fetch`-shaped, so it drops into every `deps.fetchImpl ?? …` default without
 * touching a call site or a test seam.
 *
 * MUST be undici's own `fetch`: the guarded dispatcher is an undici `Agent`, and
 * handing it to the global (version-skewed) fetch throws "invalid
 * onRequestStart method". Same constraint `platform/httpAccessor.ts` documents.
 *
 * `async` so a blocked address REJECTS rather than throwing synchronously. Real
 * `fetch` never throws synchronously, and a drop-in replacement that does would
 * bypass any caller written as `fetchImpl(url).catch(…)` — the refusal would
 * escape as an unhandled throw instead of the error path it belongs in.
 */
export const guardedOutboundFetch: typeof fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  // Literal IPs first — the dispatcher below never sees them (no DNS to hook).
  assertLiteralHostAllowed(input);
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: guardedAgent(),
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}) as typeof fetch;
