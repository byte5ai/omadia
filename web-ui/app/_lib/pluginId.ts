/**
 * The plugin-id charset gate, web-ui's copy (epic #470 C8).
 *
 * WHY A COPY AND NOT AN IMPORT. The authority is
 * `middleware/src/plugins/manifestLoader.ts` — that is where a manifest is
 * accepted or rejected, and nothing here can change that verdict. web-ui is a
 * separate Next build with its own `package.json`; it depends on no middleware
 * package today, and adding one so a route handler can reach a regex would
 * couple the web-ui image to the middleware workspace for eleven characters of
 * pattern. The epic's constraint 2 is pushing dependencies the other way.
 *
 * So the pattern is restated here — and the restatement is PINNED. The comment
 * that used to say "mirrors manifestLoader" was not enforced by anything, and
 * it was wrong: it omitted the optional `@scope/`, so every `@omadia/*` plugin
 * — which is all of them — 404'd on its own host page. `pluginId.test.ts`
 * reads `manifestLoader.ts` and asserts the two definitions are character-
 * identical, which turns the comment into a check. Drift now fails a test
 * instead of a screen.
 */

/**
 * `identity.id` — an npm package name, optionally scoped. Character-identical
 * to `PLUGIN_ID_PATTERN` in `middleware/src/plugins/manifestLoader.ts`; keep
 * them that way (`pluginId.test.ts` enforces it).
 */
export const PLUGIN_ID_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * npm's own package-name cap, including the scope. Character-identical to
 * `PLUGIN_ID_MAX_LENGTH` in `manifestLoader.ts`.
 */
export const PLUGIN_ID_MAX_LENGTH = 214;

/**
 * True iff `id` could be the `identity.id` of an installed plugin.
 *
 * Both halves of the middleware gate, in the same order: length first (a
 * pathological id is rejected before the regex walks it), then charset. The
 * charset is what carries the path-safety property — the only `/` a valid id
 * may contain is the scope separator, and neither the scope nor the name may
 * begin with `.`, so no segment of a valid id can be `.` or `..`.
 */
export function isValidPluginId(id: string): boolean {
  return id.length <= PLUGIN_ID_MAX_LENGTH && PLUGIN_ID_PATTERN.test(id);
}

/**
 * Decode the `[pluginId]` route segment and gate it — the value the
 * `/plugin-ui/[pluginId]` host page may use, or `null` (#1399).
 *
 * Core builds the nav entry with `encodeURIComponent`, so `@omadia/example-ui`
 * stays ONE path segment: `/plugin-ui/%40omadia%2Fexample-ui`. Next 16 hands
 * that segment to the page STILL ENCODED — `getParamValue` in
 * `next/dist/shared/lib/router/utils/get-dynamic-param.js` re-encodes the
 * matched value before it reaches user code. An earlier comment assumed the
 * opposite and validated the raw param, so every scoped id 404'd.
 *
 * Decoding is safe in either case: a valid id contains no `%`, so a segment
 * that already arrived decoded is unchanged by a second decode. Malformed
 * escapes (`%E0%A4%A`) make `decodeURIComponent` throw → `null`. The charset
 * gate runs AFTER decoding, so `%2e%2e` → `..` and `%40omadia%2F..` →
 * `@omadia/..` are rejected by the pattern, not waved through as opaque text.
 */
export function decodePluginIdSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return isValidPluginId(decoded) ? decoded : null;
}
