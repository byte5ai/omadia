/**
 * #778 S3a — building the broker's outbound request, including the
 * caller-header filter.
 *
 * The caller (eventually an agent, #778 S3b) may ask for extra request
 * headers. Spreading them verbatim next to the injected credential is not
 * safe:
 *
 * - A case variant of the injected header (`authorization` next to the
 *   broker's `Authorization`, `x-api-key` next to `X-Api-Key`) is a SECOND
 *   key. `Headers` joins the two, so the upstream receives
 *   `forged, Bearer <secret>` instead of the broker's value alone.
 * - `Cookie`, `Host`, `Proxy-*` carry ambient authority or re-target the
 *   request.
 * - `X-HTTP-Method-Override`, `X-Original-URL`, `X-Rewrite-URL` let a server
 *   execute a method or path the credential's `allowedMethods` /
 *   `pathPrefixes` never approved.
 * - `Accept-Encoding` can ask for an encoding fetch does not decode, and the
 *   response scrub (`brokerResponse.ts`) cannot find a secret in compressed
 *   bytes.
 *
 * So the filter is an ALLOW-list, static and fail-closed, like the rest of
 * the broker: anything not named below is dropped. There is deliberately no
 * `x-*` wildcard — that namespace is exactly where the override headers and
 * the injectionKey collisions live. Vendor headers such as `Notion-Version`
 * need a per-credential allow-list, which is a schema change (#778 S2/S3b).
 *
 * Dropping is silent to the caller (the request still goes out, the
 * pre-S3a contract), but never silent to the operator: the dropped header
 * NAMES — never their values — ride on the `allow` audit event.
 */

import type { CredentialInjectionScheme } from '@omadia/channel-sdk';

/** Lowercased header names a caller may set. Everything else is dropped. */
export const BROKER_ALLOWED_CALLER_HEADERS: readonly string[] = Object.freeze([
  'accept',
  'accept-language',
  'content-type',
  'content-language',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'idempotency-key',
  'user-agent',
]);

const ALLOWED = new Set(BROKER_ALLOWED_CALLER_HEADERS);

/** A header value carrying one of these could split the request. */
const UNSAFE_HEADER_VALUE = /[\r\n\0]/;

export interface FilteredCallerHeaders {
  /** Kept headers, names lowercased. */
  readonly headers: Readonly<Record<string, string>>;
  /** Lowercased names of every dropped header, deduplicated. Never values. */
  readonly droppedHeaderNames: readonly string[];
}

export function needsInjectionKey(scheme: CredentialInjectionScheme): boolean {
  return scheme === 'header' || scheme === 'query-param';
}

/**
 * Keep only allow-listed caller headers. The injectionKey is always dropped,
 * compared case-insensitively, even if it happens to be on the allow-list:
 * the credential's own header is the broker's to set, never the caller's.
 */
export function filterCallerHeaders(
  callerHeaders: Readonly<Record<string, string>> | undefined,
  injectionKey: string | undefined,
): FilteredCallerHeaders {
  const reservedKey = injectionKey?.toLowerCase();
  const kept: Record<string, string> = {};
  const dropped = new Set<string>();

  for (const [name, value] of Object.entries(callerHeaders ?? {})) {
    const lower = name.toLowerCase();
    const isKept =
      ALLOWED.has(lower) && lower !== reservedKey && typeof value === 'string' && !UNSAFE_HEADER_VALUE.test(value);
    if (isKept) {
      kept[lower] = value;
    } else {
      dropped.add(lower);
    }
  }

  return { headers: kept, droppedHeaderNames: [...dropped] };
}

export interface OutboundRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly droppedHeaderNames: readonly string[];
}

/**
 * The injected credential header is set AFTER filtering, in its canonical
 * casing, so no case-variant duplicate of it can exist in the result.
 */
export function buildOutboundRequest(
  host: string,
  pathname: string,
  search: string,
  scheme: CredentialInjectionScheme,
  injectionKey: string | undefined,
  secret: string,
  callerHeaders: Readonly<Record<string, string>> | undefined,
): OutboundRequest {
  const filtered = filterCallerHeaders(callerHeaders, injectionKey);
  const headers: Record<string, string> = { ...filtered.headers, ...injectedHeader(scheme, injectionKey, secret) };

  let effectiveSearch = search;
  if (scheme === 'query-param') {
    const param = `${encodeURIComponent(injectionKey as string)}=${encodeURIComponent(secret)}`;
    effectiveSearch = effectiveSearch ? `${effectiveSearch}&${param}` : `?${param}`;
  }

  return {
    url: `https://${host}${pathname}${effectiveSearch}`,
    headers,
    droppedHeaderNames: filtered.droppedHeaderNames,
  };
}

function injectedHeader(
  scheme: CredentialInjectionScheme,
  injectionKey: string | undefined,
  secret: string,
): Record<string, string> {
  if (scheme === 'bearer') return { Authorization: `Bearer ${secret}` };
  if (scheme === 'basic-password') {
    return { Authorization: `Basic ${Buffer.from(secret, 'utf8').toString('base64')}` };
  }
  if (scheme === 'header') return { [injectionKey as string]: secret };
  return {};
}
