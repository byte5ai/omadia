/**
 * #1527 — parse the JSON a Haiku helper call was asked to return.
 *
 * Every system prompt in this package asks for "JSON only, no markdown
 * fence", and Haiku still often wraps the reply in a fenced ```json block,
 * sometimes with a sentence before or after it. The old per-file copies
 * only removed a fence at the very start and the very end of the reply, so
 * any text around the fence made `JSON.parse` fail and the reply was thrown
 * away as "non-JSON".
 *
 * Tried in order, first success wins:
 *   1. the whole reply as it is;
 *   2. the fenced body, from the first opening fence to the LAST fence, so a
 *      code block quoted inside a JSON string doesn't end it early (an
 *      unclosed fence runs to the end of the reply);
 *   3. the body of the first fenced block alone (prose with more fences after);
 *   4. the outermost `{…}` and `[…]` spans, the one that opens first tried
 *      first, so an array reply is not narrowed to its first object.
 *
 * Returns `undefined` when none of them parse, e.g. a reply cut off at
 * `max_tokens` before the object closed. The caller knows the finish reason
 * and should log it.
 */
export function parseLlmJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  for (const candidate of jsonCandidates(trimmed)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const FENCE_OPEN = /```[\w-]*[^\S\n]*\n?/;
const FENCE = '```';

function jsonCandidates(text: string): string[] {
  const candidates = [text];
  const open = FENCE_OPEN.exec(text);
  if (open) {
    const rest = text.slice(open.index + open[0].length);
    const last = rest.lastIndexOf(FENCE);
    const first = rest.indexOf(FENCE);
    candidates.push((last >= 0 ? rest.slice(0, last) : rest).trim());
    if (first >= 0 && first !== last) candidates.push(rest.slice(0, first).trim());
  }
  const spans = (['{', '['] as const)
    .map((opener) => {
      const start = text.indexOf(opener);
      const end = text.lastIndexOf(opener === '{' ? '}' : ']');
      return { start, end };
    })
    .filter(({ start, end }) => start >= 0 && end > start)
    .sort((a, b) => a.start - b.start);
  for (const { start, end } of spans) candidates.push(text.slice(start, end + 1));
  return candidates.filter((c) => c.length > 0);
}
