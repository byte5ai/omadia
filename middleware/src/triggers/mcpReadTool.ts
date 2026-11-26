/**
 * #547 — an MCP read tool as a data action (`deliver_data`, ADR-0021).
 *
 * The rows are the call's `structuredContent`, captured for exactly this one
 * call, not its text mirror, which a server may write as prose. A result
 * without a structured payload (an error, a text-only server) stays the text,
 * and the data-action runner parses it as before.
 */

import { captureMcpStructured } from '@omadia/orchestrator';

export function mcpReadToolInvoker(
  invoke: (input: unknown) => Promise<string>,
  afterRead: () => Promise<void>,
): (input: unknown) => Promise<string> {
  return async (input) => {
    const { value, structured } = await captureMcpStructured(() => invoke(input));
    await afterRead();
    return structured.length === 1 ? JSON.stringify(structured[0]) : value;
  };
}
