import type { ConductorPersonCandidate } from '@/app/_lib/api';

// Deterministic client-side edits to the chat draft graph. The builder agent
// only PROPOSES (missing connector, person candidates); the operator's click
// applies the result here, without a second LLM turn, so the patched draft is
// what the next turn and "Im Designer öffnen" see.

interface StepLike {
  id?: unknown;
  human?: { principal?: { kind?: unknown; ref?: unknown }; channel?: unknown } & Record<string, unknown>;
  [key: string]: unknown;
}

interface GraphLike {
  steps?: unknown;
  [key: string]: unknown;
}

function mapStep(graph: unknown, stepId: string, fn: (step: StepLike) => StepLike): unknown {
  const g = (graph ?? {}) as GraphLike;
  if (!Array.isArray(g.steps)) return graph;
  return {
    ...g,
    steps: g.steps.map((s) => (typeof s === 'object' && s !== null && (s as StepLike).id === stepId ? fn(s as StepLike) : s)),
  };
}

/** Point an action step at a (now connected) action id. */
export function setStepActionId(graph: unknown, stepId: string, actionId: string): unknown {
  return mapStep(graph, stepId, (s) => ({ ...s, actionId }));
}

/** Write a directory candidate into a human step: the routable ref AND the channel it belongs to. */
export function setStepPrincipal(graph: unknown, stepId: string, candidate: ConductorPersonCandidate): unknown {
  return mapStep(graph, stepId, (s) => ({
    ...s,
    human: {
      ...(s.human ?? {}),
      principal: { kind: 'user', ref: candidate.principalRef },
      channel: candidate.channelType,
    },
  }));
}

/**
 * Undo a pick: restore the display name the operator originally wrote and the channel the
 * step had before. `previousChannel === null` means "had no channel" → the candidate's
 * channel is removed again; `undefined` leaves the channel untouched.
 */
export function resetStepPrincipal(graph: unknown, stepId: string, query: string, previousChannel?: string | null): unknown {
  return mapStep(graph, stepId, (s) => {
    const human = { ...(s.human ?? {}), principal: { kind: 'user', ref: query } };
    if (previousChannel === null) delete human.channel;
    else if (previousChannel !== undefined) human.channel = previousChannel;
    return { ...s, human };
  });
}

/** The channel a human step currently routes on (undefined when unknown). */
export function stepChannel(graph: unknown, stepId: string): string | undefined {
  const g = (graph ?? {}) as GraphLike;
  if (!Array.isArray(g.steps)) return undefined;
  const step = g.steps.find((s) => typeof s === 'object' && s !== null && (s as StepLike).id === stepId) as StepLike | undefined;
  return typeof step?.human?.channel === 'string' ? step.human.channel : undefined;
}
