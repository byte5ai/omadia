import { SetupOptionsResolveError } from './dynamicAgentRuntime.js';

/**
 * Spec 2042 §5.10 — a setup field's `options_provider` names a tool of the
 * plugin that offers the choices (for example Notion's `list_notion_roots`).
 * The retired agent runtime answered it from the plugin's toolkit; a
 * capability plugin registers its tools with the kernel (`ctx.tools`), so the
 * same field is answered from there.
 *
 * Only the named plugin's own tool is asked (never another plugin's tool of
 * the same name: that would be a confused deputy). A plugin still running in
 * the agent runtime keeps being answered by it.
 */
export interface SetupOptionsResolver {
  resolveSetupOptions(pluginId: string, toolId: string, input: unknown): Promise<unknown>;
}

export interface RegisteredToolLookup {
  get(name: string): { readonly agentId?: string; readonly handler?: (input: unknown) => Promise<string> } | undefined;
}

export function createSetupOptionsResolver(deps: {
  readonly agentRuntime?: SetupOptionsResolver;
  readonly tools: RegisteredToolLookup;
}): SetupOptionsResolver {
  return {
    async resolveSetupOptions(pluginId, toolId, input) {
      const entry = deps.tools.get(toolId);
      if (entry?.agentId === pluginId && entry.handler) {
        const raw = await entry.handler(input);
        return parseToolResult(raw);
      }
      if (deps.agentRuntime) return deps.agentRuntime.resolveSetupOptions(pluginId, toolId, input);
      throw new SetupOptionsResolveError('tool_not_found', `tool '${toolId}' is not exposed by plugin '${pluginId}'`);
    },
  };
}

/** A registered tool answers with text (JSON for structured results). */
function parseToolResult(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
