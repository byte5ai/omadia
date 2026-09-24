// Shared time-zone contract (issue #1091). Single home for the cookie the
// browser mirrors its IANA zone into, the validator, and the parser the RSC
// request config reads it back with — imported by `i18n/request.ts` and the
// `TimeZoneSync` widget, so the two cannot drift.
//
// Why a cookie at all: `getRequestConfig` in `i18n/request.ts` runs on the
// server. `Intl.DateTimeFormat().resolvedOptions().timeZone` evaluated there
// resolves to the CONTAINER's zone — UTC in the shipped image — and
// NextIntlClientProvider inherits it, so every `format.dateTime` call in the
// app rendered UTC while the operator read it as local time. The browser is
// the only party that knows the real zone; this is how it says so.

/** Non-secret cookie the client mirrors its IANA zone into for the RSC to read
 *  on the next request. Value: `encodeURIComponent(zone)`. Not httpOnly — the
 *  client writes it and the server (via SSR) consumes it; it carries no secret. */
export const TIME_ZONE_COOKIE = 'omadia-tz';

/** Last-resort zone: cookie absent or invalid, and the server has nothing
 *  better to offer either. A fixed literal on purpose — silently resolving the
 *  runtime's own zone is the #1091 bug, and it fails as a wrong-but-plausible
 *  clock reading rather than as an error. */
export const FALLBACK_TIME_ZONE = 'UTC';

/** Longest IANA identifier in the tz database is well under this; the cap keeps
 *  pathological cookie values away from Intl entirely. */
const MAX_ZONE_LENGTH = 64;

/** Conservative shape gate: IANA identifiers are ASCII letters, digits and
 *  `/ _ - + :` (the last two for `Etc/GMT+5` and offset forms). Rejecting
 *  whitespace and control characters here keeps them out of the log line the
 *  RangeError would otherwise produce. */
const ZONE_SHAPE = /^[A-Za-z0-9/_+:-]+$/;

/**
 * True when this runtime can actually format in `value`. The shape gate is a
 * cheap pre-filter; `Intl` is the authority, because the set of known zones is
 * a property of the ICU build, not of the string.
 */
export function isValidTimeZone(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_ZONE_LENGTH) return false;
  if (!ZONE_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode the time-zone cookie for the RSC request config. Always returns a zone
 * this runtime accepts — an unvalidated value would reach
 * `Intl.DateTimeFormat` and throw a RangeError server-side, which is a 500 on
 * every page rather than a formatting glitch. The same guarantee covers
 * `fallback`, so a caller cannot smuggle an unchecked zone in through it.
 */
export function parseTimeZoneCookie(
  raw: string | undefined,
  fallback: string = FALLBACK_TIME_ZONE,
): string {
  // Lazy: on the common path the cookie is valid and the fallback is never
  // needed, and each validation costs an `Intl.DateTimeFormat` construction.
  const safeFallback = (): string =>
    isValidTimeZone(fallback) ? fallback : FALLBACK_TIME_ZONE;
  if (!raw) return safeFallback();
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed percent escape — `decodeURIComponent` throws URIError.
    return safeFallback();
  }
  return isValidTimeZone(decoded) ? decoded : safeFallback();
}

/**
 * The zone to use on requests where no browser has spoken yet — a first visit,
 * a client that cannot persist cookies, an e2e run, a curl.
 *
 * `TZ` is honoured when it is set and valid. That is not a relapse into #1091:
 * that bug was about PREFERRING the runtime's zone over the operator's, and
 * the cookie still wins here whenever it exists. Nothing in this repo sets
 * `TZ`, so a value in it is deliberate operator configuration — and for a
 * self-hoster who runs the image with `TZ=Europe/Berlin`, it is a strictly
 * better guess than UTC. Pure in its argument so it can be tested without
 * mutating the process environment.
 */
export function serverFallbackTimeZone(env: {
  readonly TZ?: string | undefined;
}): string {
  return isValidTimeZone(env.TZ) ? (env.TZ as string) : FALLBACK_TIME_ZONE;
}

/**
 * The browser's own zone. Only meaningful on the client — on the server this is
 * the container zone, which is exactly the value #1091 is about not using.
 * Split out as a named export so the sync widget's tests can pin it.
 */
export function resolveBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
