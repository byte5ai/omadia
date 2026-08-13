/**
 * Epic #470 W1 — daemon HTTP bearer auth (spec §4).
 *
 * The daemon control-plane API is a privileged surface: a caller that reaches it
 * can create job containers. It sits on the `dev-control` network the middleware
 * alone joins, so the bearer is a SECOND layer, not the only one (review finding
 * S3). This module owns the token contract:
 *
 *   - `DEV_RUNNER_DAEMON_TOKEN` is a COMMA-SEPARATED list so an operator can add
 *     a new token, roll the middleware onto it, then drop the old one — zero
 *     downtime rotation. Every non-empty entry authenticates.
 *   - Each token must be >= 32 chars; the daemon REFUSES TO START otherwise
 *     (`parseDaemonTokens` throws), so a weak/empty secret can never ship.
 *   - The presented bearer is compared in CONSTANT TIME against every configured
 *     token, hashing both sides to a fixed 32-byte digest so neither a token's
 *     length nor its bytes leak through a timing side channel, and iterating the
 *     whole list without an early return so "which token matched" does not leak
 *     either (the same construction the middleware's `verifyRunnerToken` uses).
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Minimum length of every configured daemon token (spec §4: ">= 32 chars"). */
export const MIN_DAEMON_TOKEN_LENGTH = 32;

/**
 * Raised at boot when `DEV_RUNNER_DAEMON_TOKEN` is missing, empty, or holds a
 * token shorter than the floor. The daemon refuses to start on this — a weak or
 * absent secret is never silently accepted. The message NEVER echoes a token.
 */
export class DaemonAuthConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DaemonAuthConfigError';
  }
}

/**
 * Parse `DEV_RUNNER_DAEMON_TOKEN` into the list of accepted tokens. Splits on
 * commas, trims each entry, drops empties (so a trailing comma is harmless), and
 * enforces the length floor on what remains. Throws `DaemonAuthConfigError` if
 * the result is empty or any surviving token is too short — the caller lets that
 * abort boot.
 *
 * @param {string | undefined} raw The raw env value.
 * @returns {string[]} One or more accepted tokens (>= 1, each >= 32 chars).
 */
export function parseDaemonTokens(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new DaemonAuthConfigError('DEV_RUNNER_DAEMON_TOKEN is not set');
  }
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new DaemonAuthConfigError('DEV_RUNNER_DAEMON_TOKEN contains no non-empty token');
  }
  for (const token of tokens) {
    if (token.length < MIN_DAEMON_TOKEN_LENGTH) {
      throw new DaemonAuthConfigError(
        `DEV_RUNNER_DAEMON_TOKEN has a token shorter than ${MIN_DAEMON_TOKEN_LENGTH} chars — refusing to start`,
      );
    }
  }
  return tokens;
}

/**
 * Extract the bearer credential from an `Authorization` header.
 * `Bearer <token>`, case-insensitive on the scheme; returns null if the header
 * is absent or malformed.
 *
 * @param {string | string[] | undefined} header
 * @returns {string | null}
 */
export function extractBearer(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Constant-time membership test: is `presented` one of `tokens`? Both sides are
 * hashed to a fixed 32-byte digest so the compare is fixed-width regardless of
 * input length, and the loop visits EVERY token (OR-accumulating the result)
 * so the matched index does not leak through timing.
 *
 * @param {string} presented The bearer the caller sent.
 * @param {readonly string[]} tokens The configured accepted tokens.
 * @returns {boolean}
 */
export function matchesDaemonToken(presented, tokens) {
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  let matched = 0;
  for (const token of tokens) {
    const candidate = createHash('sha256').update(token, 'utf8').digest();
    matched |= timingSafeEqual(presentedDigest, candidate) ? 1 : 0;
  }
  return matched === 1;
}

/**
 * Authorize a request against the configured tokens. Returns true only when a
 * well-formed bearer header carries one of the accepted tokens.
 *
 * @param {string | string[] | undefined} authorizationHeader
 * @param {readonly string[]} tokens
 * @returns {boolean}
 */
export function isAuthorized(authorizationHeader, tokens) {
  const presented = extractBearer(authorizationHeader);
  if (presented === null) return false;
  return matchesDaemonToken(presented, tokens);
}
