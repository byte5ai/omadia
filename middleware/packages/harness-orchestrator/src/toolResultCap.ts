/**
 * #1920 / ADR-0207 — one size limit for a tool result on its way to the model,
 * whether or not the Privacy Shield masks it.
 *
 * A masked result is bounded where it is interned (`MAX_INTERN_CHARS` in the
 * privacy guard, 200 000 characters) and the model reads a digest of it. A
 * result the shield passes raw — an operator bypass, a sub-agent that ran in
 * bypass, or a turn with no privacy guard installed — had no limit at all: a
 * 400 KB text went to the provider in full. This applies the same number on
 * those paths and tells the model that the result was cut.
 *
 * Not covered (follow-up): results of intern-exempt kernel tools under a
 * guard, and the standalone `ToolDispatchService` path.
 */

/** The model-facing ceiling, equal to the shield's intern cap. */
export const MAX_TOOL_RESULT_CHARS = 200_000;

export function capToolResultText(
  text: string,
  opts: { readonly keepDirectives?: boolean; readonly max?: number } = {},
): string {
  const max = opts.max ?? MAX_TOOL_RESULT_CHARS;
  if (text.length <= max) return text;
  // A `_pending*` directive (canvas, choice card, routine list) is parsed by
  // the kernel after the call; cutting it would break the JSON and drop the
  // card silently. Only for kernel/plugin tools: an MCP server's text is never
  // exempt, whatever it contains.
  if (opts.keepDirectives === true && text.includes('"_pending')) return text;
  return (
    `${text.slice(0, max)}\n\n[result truncated: the tool returned ${String(text.length)} characters, ` +
    `only the first ${String(max)} are shown. Narrow the request to get the rest.]`
  );
}
