import { z } from 'zod';

import type { Toolkit } from './toolkit.js';
import type { NativeToolSpec, PluginContext } from './types.js';

/**
 * Tool-runtime contract (spec 2042 §5.10, ADR-0014): a capability plugin
 * registers each tool with the kernel via `ctx.tools.register(spec, handler)`.
 * The kernel offers the tools to the agents the operator granted this plugin
 * to; the calling agent decides when to use them. The plugin has no persona,
 * no system prompt and no model loop of its own.
 *
 * The input schema is derived from each tool's Zod schema with Zod's own
 * `z.toJSONSchema`, so the model sees exactly what `run` accepts. The handler
 * parses the input with the same schema (a `ZodError` reaches the kernel,
 * which reports it to the model as a recoverable tool error) and returns the
 * result as text: strings verbatim, anything else as JSON. A tool's
 * `piiFields` go with its registration, so the Privacy Shield masks those
 * fields of every result.
 *
 * Returns one dispose function that unregisters every tool; call it from
 * `close()`.
 */
export function registerToolkit(ctx: PluginContext, toolkit: Toolkit): () => void {
  const disposers: Array<() => void> = [];
  const disposeAll = (): void => {
    for (const dispose of disposers.splice(0)) dispose();
  };
  try {
    for (const tool of toolkit.tools) {
      disposers.push(
        ctx.tools.register(toNativeToolSpec(tool.id, tool.description, tool.input), async (raw) => {
          const input = tool.input.parse(raw);
          const result = await tool.run(input);
          // `JSON.stringify(undefined)` is undefined, not text.
          return typeof result === 'string' ? result : (JSON.stringify(result) ?? '');
        }, tool.piiFields !== undefined ? { piiFields: tool.piiFields } : undefined),
      );
    }
  } catch (err) {
    // A tool whose schema cannot be registered fails the activation; the
    // tools registered before it do not stay behind.
    disposeAll();
    throw err;
  }
  return disposeAll;
}

function toNativeToolSpec(name: string, description: string, input: z.ZodType<unknown>): NativeToolSpec {
  const schema = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  if (schema['type'] !== 'object') {
    throw new Error(`tool '${name}': the input schema must be a z.object(...), got type '${String(schema['type'])}'`);
  }
  const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  return {
    name,
    description,
    input_schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
  };
}
