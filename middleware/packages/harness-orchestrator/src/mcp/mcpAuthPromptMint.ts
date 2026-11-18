/**
 * Per-dispatch provenance for the MCP connect prompt.
 *
 * `McpManager.handleFailure` answers an auth-shaped failure with the auth
 * provider's connect prompt (`🔒 The MCP server "…`, plus the
 * `<mcp-auth-required>` block the chat UI turns into a Connect card). The
 * dispatch seams hand that text to the model byte-identical, past the Privacy
 * Shield, because its URL and block must survive.
 *
 * Recognising it by its prefix made that exemption forgeable.
 * `renderToolResult` passes a remote server's text blocks through verbatim, so
 * any result whose first block started with the prefix (a record body written
 * that way, a server answering that way) skipped interning and redaction for
 * the whole result, and was receipted as a connect prompt.
 *
 * So the exemption keys on provenance, like the MRTR sentinel
 * (`McpInputSentinelMint`) and the kernel's own refusals: each seam opens a
 * mint around ONE dispatch, `handleFailure` records the exact text it returns
 * in place of a failure, and the seam passes a result verbatim only when it
 * equals a text recorded in that dispatch. A server cannot write to the mint,
 * and a result equal to a recorded prompt carries nothing the prompt did not.
 * Every other text that starts with the prefix is tool data.
 *
 * Dispatches nest: a domain tool's sub-agent runs its own tool calls inside the
 * parent's dispatch. A prompt is recorded into the mint of the call that
 * produced it and into every mint around it, because that call is part of each
 * enclosing dispatch. So the parent seam passes a sub-agent answer that repeats
 * the prompt byte for byte (the Connect block reaches the answer the chat UI
 * scans) and interns one that adds anything. Sibling dispatches never see each
 * other's prompts.
 *
 * A dedicated AsyncLocalStorage rather than a `turnContext` field: the
 * standalone dispatcher (`ToolDispatchService`) runs outside any turn, and the
 * skill-binding and plugin `ctx.mcp` paths re-scope `turnContext` with a
 * rebuilt store that would drop the field.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { MCP_AUTH_PROMPT_PREFIX } from '@omadia/plugin-api';

/** The connect prompts `McpManager` produced during one tool dispatch. */
export class McpAuthPromptMint {
  readonly #prompts = new Set<string>();

  /** Remember a prompt `McpManager.handleFailure` returned in this dispatch. */
  record(prompt: string): void {
    this.#prompts.add(prompt);
  }

  /** True when `result` is, byte for byte, a connect prompt recorded here. */
  minted(result: string): boolean {
    return result.startsWith(MCP_AUTH_PROMPT_PREFIX) && this.#prompts.has(result);
  }
}

/** An open dispatch and the dispatches it runs inside. */
interface MintScope {
  readonly mint: McpAuthPromptMint;
  readonly outer: MintScope | undefined;
}

const mintStorage = new AsyncLocalStorage<MintScope>();

/** Run one tool dispatch with `mint` as the record of the prompts it produces. */
export function runWithMcpAuthPromptMint<T>(mint: McpAuthPromptMint, fn: () => T): T {
  return mintStorage.run({ mint, outer: mintStorage.getStore() }, fn);
}

/**
 * Called by `McpManager.handleFailure` with the connect prompt it returns.
 * Records into the open dispatch's mint and every mint around it; outside a
 * dispatch (an operator test call, a plugin job) there is none and nothing
 * happens.
 */
export function recordMcpAuthPrompt(prompt: string): void {
  for (let scope = mintStorage.getStore(); scope !== undefined; scope = scope.outer) {
    scope.mint.record(prompt);
  }
}
