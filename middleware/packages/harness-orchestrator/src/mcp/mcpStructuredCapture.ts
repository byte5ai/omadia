/**
 * #547 — hand an MCP tool's `structuredContent` to a harness-side consumer of
 * ONE call, without widening `callTool`'s string contract.
 *
 * The ADR-0021 data side channel (`deliver_data`, spec 2042 §5.13) runs an
 * agent's read tool in the harness and renders its rows to people; the model
 * gets only a status. For an MCP tool the rows used to be parsed back out of
 * the model-facing text, which fails for every server whose text mirror is
 * prose. A data action now opens a capture around its one invocation, and
 * `McpManager` records the structured payload of a successful call into it,
 * so the table is built from the payload the server sent.
 *
 * A dedicated AsyncLocalStorage for the same reason as `mcpAuthPromptMint`:
 * the dispatch seams and the plugin/skill paths re-scope `turnContext` with
 * rebuilt stores. Nothing reaches a model through this channel.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The structured payloads MCP calls produced inside one capture. */
export interface McpStructuredCapture {
  readonly payloads: unknown[];
}

const captureStorage = new AsyncLocalStorage<McpStructuredCapture>();

/** Run `fn` and collect every MCP `structuredContent` it produced. */
export async function captureMcpStructured<T>(
  fn: () => Promise<T>,
): Promise<{ readonly value: T; readonly structured: readonly unknown[] }> {
  const capture: McpStructuredCapture = { payloads: [] };
  const value = await captureStorage.run(capture, fn);
  return { value, structured: capture.payloads };
}

/** Called by `McpManager` for a successful call's `structuredContent`. Outside
 *  a capture nothing happens. */
export function recordMcpStructured(structured: unknown): void {
  captureStorage.getStore()?.payloads.push(structured);
}
