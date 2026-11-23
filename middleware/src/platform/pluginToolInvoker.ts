/**
 * Runs ONE plugin-registered tool by its id, outside a model turn: the
 * deterministic-action fast-path of the canvas (`agentToolInvoker@1`) and the
 * Conductor's action steps.
 *
 * Spec 2042 §5.10 — capability plugins register their tools with the kernel
 * (`ctx.tools.register`); these callers used to reach the toolkit of an agent
 * plugin instead, which the kernel no longer runs. Only a tool a plugin
 * registered is reachable (an entry with an owner and a handler); the kernel's
 * own native tools are not, they belong to a turn.
 */

/** The slice of a native tool registration the invoker reads. */
export interface PluginToolEntry {
  readonly agentId?: string;
  readonly handler?: (input: unknown) => Promise<string>;
}

export interface PluginToolLookup {
  get(name: string): PluginToolEntry | undefined;
}

/** The plugin that registered `toolId`, `undefined` for a kernel tool or an unknown id. */
export function pluginToolOwner(tools: PluginToolLookup, toolId: string): string | undefined {
  const entry = tools.get(toolId);
  return entry?.handler !== undefined ? entry.agentId : undefined;
}

/**
 * The tool's result text, or `undefined` when no plugin registered a tool of
 * that id. A throw from the handler propagates: each caller reports it its
 * own way (the Conductor fails the step, the canvas falls back).
 */
export async function invokePluginTool(
  tools: PluginToolLookup,
  toolId: string,
  input: unknown,
): Promise<string | undefined> {
  const entry = tools.get(toolId);
  if (entry?.agentId === undefined || entry.handler === undefined) return undefined;
  return entry.handler(input);
}
