/**
 * One readable sentence for a thrown value, including its `cause` chain.
 *
 * Node's `fetch` (undici) reports every transport failure as a bare
 * `TypeError: fetch failed` and puts the real reason — `getaddrinfo ENOTFOUND`,
 * `connect ECONNREFUSED`, a TLS/protocol error, a redirect refusal — in
 * `err.cause`. Logging or storing `err.message` alone makes a DNS miss, a
 * refused connection and a protocol mismatch indistinguishable (#1482 for the
 * registry client, #1704 for Conductor's outbound webhooks), so this walks the
 * chain and appends what it finds.
 *
 * Lives in `platform/` rather than next to either caller: both the registry
 * client and the webhook dispatcher need the same rendering, and a third
 * outbound caller should not have to reinvent it.
 */

/** Deepest nesting followed. undici wraps at most two levels in practice; the
 *  bound just stops a self-referential `cause` from looping forever. */
const MAX_CAUSE_DEPTH = 3;

export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const chain: string[] = [];
  let cause: unknown = causeOf(err);
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== null; depth += 1) {
    const detail = describeCause(cause);
    // Skip a cause that only repeats what is already in the sentence — undici
    // re-wraps the same message at more than one level for some failures.
    if (detail && detail !== message && !chain.includes(detail)) chain.push(detail);
    cause = causeOf(cause);
  }
  return chain.length > 0 ? `${message} (${chain.join(' <- ')})` : message;
}

function causeOf(value: unknown): unknown {
  return value instanceof Error ? (value as { cause?: unknown }).cause : undefined;
}

/** `code: message` for a system error, whichever half is present otherwise. The
 *  code carries the diagnosis (`ENOTFOUND`, `ECONNREFUSED`, `EPROTO`), so it is
 *  prefixed unless the message already spells it out. */
function describeCause(cause: unknown): string {
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const code = isObject(cause) && typeof cause['code'] === 'string' ? cause['code'] : '';
  if (causeMessage && code && !causeMessage.includes(code)) return `${code}: ${causeMessage}`;
  return causeMessage || code;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
