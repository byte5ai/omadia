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
 * is #1097. The dispatch seams decide with `isGuardedControlFlowResult`
 * (`@omadia/orchestrator`): the `Error:` carrier by its prefix, the connect
 * prompt only by provenance (see below).
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
 * THREW is withheld from the model (`toolErrorNotice.ts`), and each handled
 * error writes a `toolErrors` entry into the turn's privacy receipt. That
 * holds under a privacy handle for a tool that is neither intern-exempt nor
 * bypassed (a thrown message is withheld under bypass too); the kernel's
 * intern-exempt tools hand both carriers to the model as they are.
 * The in-tree wrappers that caught exceptions return the withheld notice via
 * `toolErrorFromException` and keep only messages they author themselves;
 * any producer that still returns exception text relies on the seam.
 *
 * The auth-prompt carrier passes byte-identical — its connect URL and
 * `<mcp-auth-required>` block must survive — and is receipted as well, but
 * only on provenance: a seam passes it when `McpManager` produced that exact
 * text in the same dispatch (`McpAuthPromptMint`, `@omadia/orchestrator`). The
 * prefix proves nothing on its own, since a remote server can write it at the
 * start of a text block; such text is interned like any tool result. So this
 * predicate classifies a shape, it grants no exemption.
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
 * True when a tool result has the shape of control flow rather than data.
 * Prefix-anchored on purpose — see the module comment. Not an exemption by
 * itself: a seam passes the connect prompt only when it was produced in the
 * same dispatch (`isGuardedControlFlowResult` in `@omadia/orchestrator`).
 */
export function isControlFlowToolResult(result: string): boolean {
  return (
    result.startsWith(TOOL_ERROR_PREFIX) || result.startsWith(MCP_AUTH_PROMPT_PREFIX)
  );
}
