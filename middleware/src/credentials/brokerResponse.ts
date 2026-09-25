/**
 * #778 S3a — turning an upstream response into something safe to hand an
 * agent: a bounded body with the secret scrubbed out of it and out of the
 * headers.
 *
 * ## Why scrub at all
 *
 * The broker's promise is that the caller never receives the secret. Not
 * sending it back ourselves is not enough: an upstream can. Echo endpoints
 * (httpbin-style `/anything`), error pages that reflect the request, and a
 * redirect `Location` that carries `?api_key=` all return the credential
 * verbatim. So every response header value and the body are scrubbed for the
 * secret in each form it could have travelled in:
 *
 * - raw (`bearer`, `header`, and a server that decoded what it got),
 * - base64 (`basic-password` sends `Basic base64(user:pass)`),
 * - URL-encoded (`query-param` sends `encodeURIComponent(secret)`), plus the
 *   form-encoding variants (`+` for space, `URLSearchParams`), with the `%XX`
 *   hex matched case-insensitively because upstreams re-encode in lowercase,
 *   and the WHATWG-URL form fetch really sends (`'` as `%27`),
 * - JSON-escaped (`\"`, `\\`, `\n`), for an upstream echoing the request as
 *   JSON.
 *
 * The forms are built from what goes on the WIRE, not only from the stored
 * value: undici trims leading and trailing HTTP whitespace (tab, LF, CR,
 * space) from a header value, so a secret stored with a copy-paste newline
 * leaves trimmed, and an echo of it matches no form of the stored value.
 * Every base therefore also contributes its trimmed variant.
 *
 * For `basic-password` the stored secret is `user:pass` (#778, confirmed
 * 2026-08-20), and an upstream can echo the password alone, so the password
 * segment is scrubbed on its own too.
 *
 * ## The 8-character floor
 *
 * Secrets (and basic-password segments) shorter than
 * {@link MIN_SCRUBBABLE_SECRET_LENGTH} are NOT scrubbed. Redacting a 4-char
 * value would shred ordinary response text and give a false sense of
 * safety at the same time; the right fix is refusing such a secret when the
 * credential is created, which is #778 S2's job, not this module's.
 *
 * ## The byte cap and the straddle
 *
 * The body is read as a stream and cut at `maxBytes`, never buffered whole
 * (`await text()` then "check the length" is not a cap). Truncation opens
 * one leak of its own: a secret straddling the cap leaves a PREFIX of itself
 * that no full-form match can find. So when a body is truncated, the last
 * `longestForm - 1` characters are dropped after scrubbing — no prefix of any
 * form can survive the cut.
 */

import type { CredentialInjectionScheme } from '@omadia/channel-sdk';

/** Shorter secrets are not scrubbed — see the module header. */
export const MIN_SCRUBBABLE_SECRET_LENGTH = 8;

export const REDACTED = '[REDACTED]';

/** The response shape the broker reads. `body` is optional so a test stub
 *  that only implements `text()` still type-checks; real fetch always has it. */
export interface BrokerUpstreamResponse {
  readonly status: number;
  readonly headers: Iterable<[string, string]>;
  text(): Promise<string>;
  readonly body?: ReadableStream<Uint8Array> | null;
}

export interface CappedBody {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Every form of the secret worth scrubbing, longest first. Empty when the
 * secret is below the floor.
 */
export function secretForms(secret: string, scheme: CredentialInjectionScheme): readonly string[] {
  const bases = withTrimmed(secret);
  if (scheme === 'basic-password') {
    const colon = secret.indexOf(':');
    if (colon >= 0) bases.push(...withTrimmed(secret.slice(colon + 1)));
  }

  const forms = new Set<string>();
  // base64 of the full stored secret is what `basic-password` puts on the wire.
  if (secret.length >= MIN_SCRUBBABLE_SECRET_LENGTH) forms.add(Buffer.from(secret, 'utf8').toString('base64'));
  for (const base of bases) {
    if (base.length < MIN_SCRUBBABLE_SECRET_LENGTH) continue;
    const uriEncoded = encodeURIComponent(base);
    forms.add(base);
    forms.add(uriEncoded);
    forms.add(uriEncoded.replace(/%20/g, '+'));
    forms.add(new URLSearchParams({ k: base }).toString().slice(2));
    // What fetch's WHATWG URL parser actually sends for `query-param`: it
    // re-encodes `'` as `%27`, which `encodeURIComponent` leaves alone.
    forms.add(new URL(`https://h/?k=${uriEncoded}`).search.slice(3));
    // A JSON echo escapes `"`, `\` and the short control escapes (`\n`, `\t`).
    forms.add(JSON.stringify(base).slice(1, -1));
  }

  return [...forms].sort((a, b) => b.length - a.length);
}

/** Leading/trailing HTTP whitespace, which undici strips from a header value
 *  before sending — see the module header. */
const HTTP_WHITESPACE_EDGES = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/** The value itself plus, when it differs, the whitespace-trimmed wire form. */
function withTrimmed(value: string): string[] {
  const trimmed = value.replace(HTTP_WHITESPACE_EDGES, '');
  return trimmed === value ? [value] : [value, trimmed];
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A literal, except `%XX` hex digits match in either case. */
function formPattern(form: string): string {
  return form
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((part, i) => {
      if (i % 2 === 0) return escapeRegExp(part);
      const hex = [...part.slice(1)].map((ch) => (/[a-f]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch));
      return `%${hex.join('')}`;
    })
    .join('');
}

/** Replace every occurrence of every form with {@link REDACTED}. */
export function scrubSecret(text: string, forms: readonly string[]): string {
  if (forms.length === 0 || text.length === 0) return text;
  const pattern = new RegExp(forms.map(formPattern).join('|'), 'g');
  return text.replace(pattern, REDACTED);
}

/**
 * Scrub a (possibly truncated) body. When truncated, drop the tail that
 * could hold a prefix of a form cut by the cap — see the module header.
 */
export function scrubBody(body: CappedBody, forms: readonly string[]): string {
  const scrubbed = scrubSecret(body.text, forms);
  if (!body.truncated || forms.length === 0) return scrubbed;
  const longest = forms.reduce((max, form) => Math.max(max, form.length), 0);
  return scrubbed.slice(0, Math.max(0, scrubbed.length - (longest - 1)));
}

/** Scrub every header name and value, `location` included. */
export function sanitizeResponseHeaders(
  headers: Iterable<[string, string]>,
  forms: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    out[scrubSecret(name, forms)] = scrubSecret(value, forms);
  }
  return out;
}

function cutToBytes(text: string, maxBytes: number): CappedBody {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/**
 * Read at most `maxBytes` of the body without buffering the rest. On
 * overflow the stream is cancelled — the socket is torn down, not drained —
 * and the first `maxBytes` are returned with `truncated: true`. Pattern from
 * `guardedOutboundFetch.readTextCapped`, but truncating instead of refusing:
 * a partial answer is more useful to an agent than none.
 */
export async function readBodyCapped(
  response: BrokerUpstreamResponse,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<CappedBody> {
  if (response.body === null) return { text: '', truncated: false };
  if (response.body === undefined) return cutToBytes(await response.text(), maxBytes);

  const reader = response.body.getReader();
  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value === undefined) continue;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        chunks.push(Buffer.from(value.subarray(0, room)));
        total += room;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  return { text: Buffer.concat(chunks, total).toString('utf8'), truncated };
}
