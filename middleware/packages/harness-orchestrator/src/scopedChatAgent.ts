import type { ChatAgent } from '@omadia/channel-sdk';

/** The slice of the orchestrator registry the scoping rule reads. */
export interface ScopedRegistryView<B> {
  /** The instance's default agent (default-agent table, instance entry), if it serves. */
  instanceDefaultSlug(): string | undefined;
  get(slug: string): { readonly built: { readonly bundle: B } } | undefined;
}

/**
 * #1598 — which chat bundle answers a turn that has no orchestrator of its own.
 *
 * The legacy `chatAgent@1` bundle carries no per-Agent plugin grants, so it
 * holds every plugin's tools. Without a registry (Postgres-less boot) it IS
 * the deployment's agent and answers. With a registry, `slug` names the agent
 * (a routine's creator); `null` means the instance's default agent (#2055:
 * the instance entry of the default-agent table), and so does `'default'`
 * unless an agent has that slug. `undefined` when that agent does not exist,
 * is not enabled, or the instance entry is `off` — never the legacy bundle.
 */
export function resolveScopedBundle<B>(
  registry: ScopedRegistryView<B> | undefined,
  legacy: B | undefined,
  slug: string | null = null,
): B | undefined {
  if (!registry) return legacy;
  if (slug !== null) {
    const own = registry.get(slug)?.built.bundle;
    // `'default'` is the legacy bundle's own slug (routines created on it); an
    // operator-created Agent that happens to be named `default` wins.
    if (own !== undefined || slug !== 'default') return own;
  }
  const instanceDefault = registry.instanceDefaultSlug();
  return instanceDefault ? registry.get(instanceDefault)?.built.bundle : undefined;
}

export const NO_ORCHESTRATOR_MESSAGE = 'no agent is assigned to this conversation';

/**
 * A `ChatAgent` that resolves its target per call via {@link resolveScopedBundle}
 * — what `chatAgent@1` publishes, so every consumer without an agent of its
 * own (canvas, channel plugins without routing) runs on the instance's
 * default agent once a registry exists. No target ⇒ the turn is refused.
 */
export function createScopedChatAgent(
  legacy: ChatAgent,
  getRegistry: () => ScopedRegistryView<{ readonly agent: ChatAgent }> | undefined,
): ChatAgent & { readonly legacy: ChatAgent } {
  const target = (): ChatAgent | undefined =>
    resolveScopedBundle(getRegistry(), { agent: legacy })?.agent;
  return {
    /** The wrapped legacy agent — for introspection (tests), never for turns. */
    legacy,
    chat(input) {
      const agent = target();
      return agent ? agent.chat(input) : Promise.reject(new Error(NO_ORCHESTRATOR_MESSAGE));
    },
    chatStream(input, observer) {
      const agent = target();
      if (agent) return agent.chatStream(input, observer);
      return (async function* () {
        yield { type: 'error' as const, message: NO_ORCHESTRATOR_MESSAGE };
      })();
    },
    get holdsContentUntilVerdict() {
      return target()?.holdsContentUntilVerdict;
    },
    offeredToolNames() {
      return target()?.offeredToolNames?.() ?? new Set<string>();
    },
    offeredToolDefinitions() {
      return target()?.offeredToolDefinitions?.() ?? [];
    },
  };
}
