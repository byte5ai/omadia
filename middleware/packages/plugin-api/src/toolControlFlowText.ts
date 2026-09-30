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
 * Not interning a control-flow result is not the same as trusting it. Many
 * `Error:` strings are sanitized hints (`requires \`scope\``), but a wrapper
 * that returns `Error: ${err.message}` hands over whatever the failing ORM or
 * driver echoed, and an `Error:` string from an MCP tool is the REMOTE
 * server's own body with the prefix applied by `renderToolResult`. So every
 * seam that consults this predicate routes the `Error:` carrier through the
 * shield's free-text detectors before the model reads it
 * (`guardControlFlowResult` in `@omadia/orchestrator`; exception-shaped text —
 * a JSON row echo, a stack trace — is withheld whole), a message a handler
 * THREW never reaches the model at all (`toolErrorNotice.ts`), and each
 * handled error writes a `toolErrors` entry into the turn's privacy receipt.
 * In-tree wrappers no longer produce `Error: ${err.message}`; they return the
 * withheld notice via `toolErrorFromException`.
 *
 * The auth-prompt carrier passes byte-identical — it is kernel-authored, and
 * its connect URL and `<mcp-auth-required>` block must survive — and is
 * receipted as well. Known limit, tracked on #1097: it is recognized by its
 * prefix, so remote text that starts with that prefix passes the same way. A
 * typed control-flow result set by the producer is the durable fix.
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
