/** Thrown for conditions the post-install setup-options endpoint maps to
 *  specific HTTP codes. A plain throw from the provider's own tool is
 *  deliberately NOT this type — the route maps that to 502 (provider failed). */
export class SetupOptionsResolveError extends Error {
  constructor(
    public readonly code: 'agent_inactive' | 'tool_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'SetupOptionsResolveError';
  }
}

/**
 * Spec 2042 §5.10 — a setup field's `options_provider` names a tool of the
 * plugin that offers the choices (for example Notion's `list_notion_roots`).
 * A plugin registers its tools with the kernel (`ctx.tools`), so the field is
 * answered from there.
 *
 * Only the named plugin's own tool is asked (never another plugin's tool of
 * the same name: that would be a confused deputy).
 */
export interface SetupOptionsResolver {
  resolveSetupOptions(pluginId: string, toolId: string, input: unknown): Promise<unknown>;
}

export interface RegisteredToolLookup {
  get(name: string): { readonly agentId?: string; readonly handler?: (input: unknown) => Promise<string> } | undefined;
}

export function createSetupOptionsResolver(deps: {
  readonly tools: RegisteredToolLookup;
}): SetupOptionsResolver {
  return {
    async resolveSetupOptions(pluginId, toolId, input) {
      const entry = deps.tools.get(toolId);
      if (entry?.agentId === pluginId && entry.handler) {
        const raw = await entry.handler(input);
        return parseToolResult(raw);
      }
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
