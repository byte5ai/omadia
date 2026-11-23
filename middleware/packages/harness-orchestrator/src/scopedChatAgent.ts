import type { ChatAgent } from '@omadia/channel-sdk';

import { systemNoticeAnswer, systemNoticeDone } from './management/managementChatAgent.js';
import { buildSystemNotice } from './management/systemNotices.js';

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
 * — what `chatAgent@1` publishes.
 *
 * #2055 / #1880 — with a registry, this is NOT a way around routing: a
 * channel that falls back to `chatAgent@1` after the resolver refused a turn
 * (a binding to a disabled agent, a provisioned bot of a deleted one) would
 * otherwise reach the instance's default agent, silently. Such a turn is
 * answered with the management layer's `system` notice instead. The one
 * remaining consumer without routing is the canvas (a turn with a
 * `canvasSessionId`), which keeps running on the instance's default agent
 * until it dispatches per agent (#2059). Without a registry the legacy
 * bundle is the deployment's one agent and answers.
 */
export function createScopedChatAgent(
  legacy: ChatAgent,
  getRegistry: () => ScopedRegistryView<{ readonly agent: ChatAgent }> | undefined,
): ChatAgent & { readonly legacy: ChatAgent } {
  const target = (input?: { readonly canvasSessionId?: string }): ChatAgent | undefined => {
    const registry = getRegistry();
    if (registry && input !== undefined && input.canvasSessionId === undefined) return undefined;
    return resolveScopedBundle(registry, { agent: legacy })?.agent;
  };
  const refusal = () => buildSystemNotice('no_agent');
  return {
    /** The wrapped legacy agent — for introspection (tests), never for turns. */
    legacy,
    chat(input) {
      const agent = target(input);
      return agent ? agent.chat(input) : Promise.resolve(systemNoticeAnswer(refusal()));
    },
    chatStream(input, observer) {
      const agent = target(input);
      if (agent) return agent.chatStream(input, observer);
      return (async function* () {
        yield systemNoticeDone(refusal());
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
