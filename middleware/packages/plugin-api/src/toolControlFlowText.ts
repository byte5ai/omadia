/**
 * Control-flow tool results (#1097) — the tool-result strings that are the
 * agent's own plumbing rather than data rows.
 *
 * Two carriers exist in the kernel, both middleware-authored (never a business
 * row, never a database column):
 *
 *  - the `Error:` tool-error convention. The orchestrator derives the
 *    `is_error` flag on a `tool_result` block from exactly this prefix, and
 *    the text behind it is the hint the model needs to correct its call
 *    (`requires \`scope\``, `use search_turns instead`).
 *  - an MCP auth prompt (`🔒 …`), returned by `McpManager.handleFailure` in
 *    place of a raw failure when a call looks unauthorized. It carries the
 *    connect URL and, for an OAuth-protected server, the machine block
 *    `<mcp-auth-required …>` that the chat UI parses into a Connect card.
 *
 * Why this matters to the Privacy Shield: interning either one as a dataset
 * hands the model a `[masked]` digest instead of the text. The model then
 * cannot self-correct (the whole point of the `Error:` convention), cannot
 * relay the connect prompt, and — because a 1×1 masked dataset is renderable —
 * a later `v4_render_answer` materializes the error as if it were data. That
 * is #1097; every dispatch seam consults this predicate before interning.
 *
 * This is deliberately NOT the rule for a thrown exception's message. Nothing
 * sanitized that text — an ORM echoes the failing row, a driver echoes its
 * bound parameters — so `ToolDispatchService.maskErrorText` keeps masking it
 * even when the message happens to start with `Error:`.
 *
 * Known limit, tracked on #1097: an `Error:` string from an MCP tool is the
 * REMOTE server's own body with the prefix applied by `renderToolResult`, so
 * the passthrough trusts foreign error text. That trade-off was taken on the
 * chat path in #1105; it is recorded here rather than silently widened.
 */

/** The orchestrator's tool-error convention prefix. */
export const TOOL_ERROR_PREFIX = 'Error:';

/**
 * Prefix of every MCP auth prompt (`onAuthFailure` /
 * `delegationBlockedMessage`). Producers live in the app layer
 * (`middleware/src/index.ts`, `middleware/src/services/mcpDelegation.ts`), so
 * the marker is pinned by `toolControlFlowText.test.ts` against the real
 * message shapes rather than shared by import.
 */
export const MCP_AUTH_PROMPT_PREFIX = '🔒';

/** The machine block the chat UI parses into the Connect card. */
export const MCP_AUTH_REQUIRED_BLOCK = '<mcp-auth-required';

/**
 * True when a tool result is control flow rather than data, and must therefore
 * reach the model verbatim instead of being interned behind the Privacy
 * Shield's data-plane boundary.
 */
export function isControlFlowToolResult(result: string): boolean {
  return (
    result.startsWith(TOOL_ERROR_PREFIX) ||
    result.startsWith(MCP_AUTH_PROMPT_PREFIX) ||
    result.includes(MCP_AUTH_REQUIRED_BLOCK)
  );
}
