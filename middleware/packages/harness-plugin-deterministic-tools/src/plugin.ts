import type { PluginContext } from '@omadia/plugin-api';

import { calculatorTools } from './calculatorTools.js';
import { logicTools } from './logicTools.js';
import { MATH_DELEGATION_PROMPT_DOC } from './mathDelegation.js';
import type { DeterministicToolDefinition } from './toolHelper.js';

/**
 * @omadia/plugin-deterministic-tools — plugin entry point.
 *
 * Activation wiring:
 *   1. Register every calculator + logic tool with the kernel via
 *      `ctx.tools.register(spec, handler, { promptDoc })`.
 *   2. The first tool registration carries the global Math-Delegation
 *      promptDoc (default-on system-prompt fragment). The rest of the
 *      tools register without a promptDoc — they live under the same
 *      heading, so a single block in the system prompt covers all of
 *      them. Per-tool guidance lives in `spec.description`.
 *
 * The plugin holds no state across turns: every tool call is a pure
 * function. Activation is therefore parameter-free (no setup fields) and
 * deactivation just drops the registrations.
 */

export interface DeterministicToolsPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<DeterministicToolsPluginHandle> {
  ctx.log('[deterministic-tools] activating');

  const allTools: readonly DeterministicToolDefinition[] = [
    ...calculatorTools,
    ...logicTools,
  ];

  const disposers: (() => void)[] = [];
  for (let i = 0; i < allTools.length; i++) {
    const tool = allTools[i]!;
    // Only the first registration carries the global Math-Delegation
    // doc; subsequent tools get no promptDoc so the system-prompt
    // tool-list section shows the rule once at the top.
    const promptDoc =
      i === 0
        ? MATH_DELEGATION_PROMPT_DOC
        : tool.promptDoc;
    const opts = promptDoc !== undefined ? { promptDoc } : undefined;
    const dispose = opts !== undefined
      ? ctx.tools.register(tool.spec, tool.handler, opts)
      : ctx.tools.register(tool.spec, tool.handler);
    disposers.push(dispose);
  }

  ctx.log(
    `[deterministic-tools] ready (calc=${String(calculatorTools.length)}, logic=${String(logicTools.length)}, total=${String(allTools.length)})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[deterministic-tools] deactivating');
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try {
          dispose?.();
        } catch (err) {
          ctx.log(
            `[deterministic-tools] dispose threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}
