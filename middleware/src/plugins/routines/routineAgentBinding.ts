/**
 * #1744 / #1745 — a routine is bound to the agent that created it, by id.
 *
 * The slug is how the agent is found in the registry; the id is how the
 * routine knows it is still the same agent. A slug now held by another agent
 * (the original was deleted and a new one took the name), a disabled or
 * deleted agent, and a routine that never named an agent (created before
 * #1598 or on the legacy bundle, slug `NULL`/`'default'`) all mean: no agent
 * may run it. The routine reports that instead of running on whoever answers
 * to the name or on the instance's default agent (#2055: no fallback agent).
 */

import type { Routine } from './routineStore.js';

/** The registry slice the binding reads: enabled agents by slug. */
export interface RoutineAgentRegistryView {
  get(slug: string): { readonly agent: { readonly id: string; readonly slug: string } } | undefined;
}

export interface BoundAgent {
  readonly id: string;
  readonly slug: string;
}

export type RoutineAgentResolution =
  | { readonly ok: true; readonly agent: BoundAgent }
  | { readonly ok: false; readonly problem: string };

/** The legacy bundle's own slug: a routine created on it named no agent. */
const LEGACY_SLUG = 'default';

const UNBOUND =
  'the routine is not bound to an agent (it was created before routines named their agent); delete it and create it again in a conversation with the agent that should run it';

/**
 * Which agent runs `routine`, or why none may. `registry` undefined = a
 * registry-less boot: the legacy bundle is the deployment's one agent and
 * there is nothing to bind to (`ok` with the routine's own slug).
 */
export function resolveRoutineAgent(
  routine: Pick<Routine, 'agentSlug' | 'agentId'>,
  registry: RoutineAgentRegistryView | undefined,
): RoutineAgentResolution {
  const slug = routine.agentSlug ?? null;
  if (!registry) return { ok: true, agent: { id: routine.agentId ?? '', slug: slug ?? LEGACY_SLUG } };
  if (slug === null || (slug === LEGACY_SLUG && !registry.get(LEGACY_SLUG))) {
    return { ok: false, problem: UNBOUND };
  }
  const holder = registry.get(slug)?.agent;
  if (!holder) {
    return {
      ok: false,
      problem: `its agent '${slug}' is disabled or deleted; enable the agent again, or delete the routine and create it again with another agent`,
    };
  }
  if (routine.agentId && routine.agentId !== holder.id) {
    return {
      ok: false,
      problem: `its agent '${slug}' was deleted, and the agent that now has that name is a different one; delete the routine and create it again with the agent that should run it`,
    };
  }
  return { ok: true, agent: { id: holder.id, slug: holder.slug } };
}

/** The message a routine's owner reads when its agent ended service. */
export function agentEndedText(agentName: string, reason: string): string {
  if (reason === 'agent_deleted') {
    return `paused: its agent '${agentName}' was deleted; delete the routine or create it again with another agent`;
  }
  if (reason === 'archetype_plugin_removed') {
    return `paused: the plugin behind its agent '${agentName}' was removed; resume the routine once the agent runs again`;
  }
  return `paused: its agent '${agentName}' was disabled; resume the routine once the agent is enabled again`;
}
