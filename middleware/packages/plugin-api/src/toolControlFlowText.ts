/**
 * Control-flow tool results (#1097) — the tool-result strings that are the
 * agent's own plumbing rather than data rows.
 *
 * Two carriers exist in the kernel, both recognized by an anchored PREFIX only:
 *
 *  - the `Error:` tool-error convention. The orchestrator derives the
 *    `is_error` flag on a `tool_result` block from exactly this prefix, and
 *    the text behind it is the hint the model needs to correct its call
 *    (`requires \`scope\``, `use search_turns instead`).
 *  - an MCP auth prompt (`🔒 The MCP server "…`), returned by
 *    `McpManager.handleFailure` in place of a raw failure when a call looks
 *    unauthorized. It carries the connect URL and, for an OAuth-protected
 *    server, the machine block `<mcp-auth-required …>` that the chat UI parses
 *    into a Connect card.
 *
 * Why this matters to the Privacy Shield: interning either one as a dataset
 * hands the model a `[masked]` digest instead of the text. The model then
 * cannot self-correct (the whole point of the `Error:` convention), cannot
 * relay the connect prompt, and — because a 1×1 masked dataset is renderable —
 * a later `v4_render_answer` materializes the error as if it were data. That
 * is #1097; every dispatch seam consults this predicate before interning.
 *
 * The predicate is deliberately NOT content sniffing: a match anywhere inside
 * a result (`includes('<mcp-auth-required')`) or a bare `🔒` would let one
 * planted cell in a CSV, a mail or an Odoo note switch the shield off for a
 * whole multi-row result. Every real producer starts with the full prefix
 * below, so nothing needs more than that.
 *
 * Not every `Error:` string is sanitized text. Many are (`requires \`scope\``),
 * but some producers wrap a caught exception's message in the convention —
 * `bridgeTool` in `src/plugins/dynamicAgentRuntime.ts` returns
 * `Error: ${err.message}` for any plugin exception, and an ORM or driver
 * message can echo the failing row. On the sub-agent path that text now
 * reaches the sub-agent's model raw. That is a deliberate match with the chat
 * path's policy (see `chatPathToolErrorText.test.ts`, which forwards thrown
 * exception text verbatim on the same provider wire), not a claim that the
 * text carries no PII. Where a caller is untrusted —
 * `ToolDispatchService.maskErrorText` on the public path — a thrown message
 * stays masked even when it happens to start with `Error:`.
 *
 * Known limits, tracked on #1097: an `Error:` string from an MCP tool is the
 * REMOTE server's own body with the prefix applied by `renderToolResult`, so
 * the passthrough trusts foreign error text (the trade-off taken on the chat
 * path in #1105), and remote text that starts with the auth-prompt prefix
 * passes the same way. A passed-through result writes no privacy-receipt
 * entry. A typed control-flow result set by the producer is the durable fix.
 */

/** The orchestrator's tool-error convention prefix. */
export const TOOL_ERROR_PREFIX = 'Error:';

/**
 * Exact prefix every MCP auth prompt starts with (`onAuthFailure` in
 * `middleware/src/index.ts`, `delegationBlockedMessage` in
 * `middleware/src/services/mcpDelegation.ts`). The producers live in the app
 * layer, so the prefix is pinned by `toolControlFlowText.test.ts` against the
 * real message shapes rather than shared by import.
 */
export const MCP_AUTH_PROMPT_PREFIX = '🔒 The MCP server "';

/**
 * True when a tool result is control flow rather than data, and must therefore
 * reach the model verbatim instead of being interned behind the Privacy
 * Shield's data-plane boundary. Prefix-anchored on purpose — see the module
 * comment.
 */
export function isControlFlowToolResult(result: string): boolean {
  return (
    result.startsWith(TOOL_ERROR_PREFIX) || result.startsWith(MCP_AUTH_PROMPT_PREFIX)
  );
}
