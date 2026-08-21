// Shared ISO-8601 duration parsing (#330 C3). ONE implementation for both
// the publish-time validation and the runtime executor — a drift between
// "validate accepts" and "runtime parses" would park runs nothing wakes.

/** Milliseconds for a positive ISO-8601 duration (days/hours/minutes/seconds
 *  subset), or null for anything absent, malformed or non-positive. */
export function parseIsoDurationMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  const ms = (Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return ms > 0 ? ms : null;
}
