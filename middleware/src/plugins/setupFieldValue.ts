/**
 * The value of a `boolean` / `integer` setup field, read from any spelling it
 * arrives or is stored in.
 *
 * A typed setup value reaches the server in more than one shape:
 *   - the manifest `default` (#1464, #1524) — authors write both `default: true`
 *     and `default: "true"`, both `default: 200000` and `default: "200000"`;
 *   - an install submission (`coerce()` in installService);
 *   - the post-install editor's string-only patch body (`PATCH …/secrets`,
 *     #1958): every value is a string there;
 *   - a value already stored as a string by an older build (#1958) — read back
 *     through `ctx.config.get`.
 *
 * Every one of those paths runs the raw value through these two functions, so
 * they cannot disagree about what counts as a boolean or an integer, and the
 * value they hand on is always the real type: a plugin computing
 * `now + signed_url_ttl_sec` must never see `"1800"`.
 *
 * Anything that is not a value of the type (`"yes"`, `1`, `1.5`, `"lots"`, `""`,
 * …) yields `undefined`; each caller decides what that means (a dropped
 * default, a 400, a value passed through unchanged).
 */
export function parseBooleanSetupValue(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/** See {@link parseBooleanSetupValue}. Whole numbers only, within the safe range. */
export function parseIntegerSetupValue(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : undefined;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

/**
 * #1958 — the stored form of a value for a field of `type`: a real boolean or
 * number for `boolean` / `integer` fields when the value parses as one,
 * otherwise the value unchanged. Used on the read side (`ctx.config.get`), where
 * an unparseable legacy value is handed on as-is rather than hidden.
 */
export function normalizeTypedSetupValue(type: string, raw: unknown): unknown {
  if (type === 'boolean') return parseBooleanSetupValue(raw) ?? raw;
  if (type === 'integer') return parseIntegerSetupValue(raw) ?? raw;
  return raw;
}
