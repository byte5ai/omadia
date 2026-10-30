// Builder person suggestions — "Eskalation an Teresita Biel" → who is that?
//
// A human step with `principal.kind === 'user'` needs a routable address (the
// channel binding key). When the operator names a person, the builder agent is
// told to keep the NAME in `ref`; this module then asks the kernel's people
// directory (union over the channel plugins) and returns candidates. It never
// rewrites the graph — choosing a person is the operator's click — and the
// candidates never enter the LLM prompt (resolution runs after the turn).

import type { WorkflowGraph } from '@omadia/conductor-core';

export interface PersonCandidate {
  /** the channel binding key to write into `human.principal.ref`. */
  principalRef: string;
  displayName: string;
  channelType: string;
  email?: string;
  hint?: string;
}

export interface PersonSuggestion {
  stepId: string;
  /** the name as it stands in the draft. */
  query: string;
  candidates: PersonCandidate[];
  /** at least one directory did not answer — an empty `candidates` proves nothing then. */
  partial: boolean;
}

export type ConductorPeopleSearch = (
  query: string,
  opts: { limit: number; channelType?: string },
) => Promise<{
  people: readonly { principalRef: string; displayName: string; channelType: string; email?: string; hint?: string }[];
  partial: boolean;
}>;

/** Bounds: distinct names searched per turn, candidates per name. */
const MAX_NAMES_PER_TURN = 5;
const MAX_CANDIDATES = 5;
const MIN_QUERY_CHARS = 2;

/**
 * A `user` ref is "resolved" (or dynamic) and must NOT be looked up as a name when it is an
 * address (`@`), a channel-native id (any token carrying digits — Slack `U0…` member ids,
 * AAD object ids, numeric Telegram ids), or a run-context expression — `{{steps.x.owner}}`
 * or a bare dotted path such as `stepResult.employee` (live finding 2026-10-30: the builder
 * emits those for "the affected person"). What is left — letters and spaces — is a NAME.
 */
export function isUnresolvedUserRef(ref: string): boolean {
  const t = ref.trim();
  if (t.length < MIN_QUERY_CHARS || t.includes('@') || /\d/.test(t)) return false;
  if (t.includes('{{') || t.includes('}}')) return false;
  if (t.includes('.') && !/\s/.test(t)) return false; // dotted path, not a name ("Dr. Biel" keeps its space)
  return true;
}

export async function collectPersonSuggestions(graph: WorkflowGraph, search: ConductorPeopleSearch): Promise<PersonSuggestion[]> {
  const steps = Array.isArray(graph.steps) ? graph.steps : [];
  // One lookup per distinct name (case-insensitive) — several steps may name the same person.
  const byName = new Map<string, { query: string; stepIds: string[] }>();
  for (const step of steps) {
    if (step.kind !== 'human' || step.human?.principal.kind !== 'user') continue;
    const ref = step.human.principal.ref;
    if (typeof ref !== 'string' || !isUnresolvedUserRef(ref)) continue;
    const key = ref.trim().toLowerCase();
    const entry = byName.get(key);
    if (entry) entry.stepIds.push(step.id);
    else if (byName.size < MAX_NAMES_PER_TURN) byName.set(key, { query: ref.trim(), stepIds: [step.id] });
  }
  if (byName.size === 0) return [];

  const out: PersonSuggestion[] = [];
  for (const { query, stepIds } of byName.values()) {
    const result = await search(query, { limit: MAX_CANDIDATES });
    const candidates: PersonCandidate[] = result.people.slice(0, MAX_CANDIDATES).map((p) => ({
      principalRef: p.principalRef,
      displayName: p.displayName,
      channelType: p.channelType,
      ...(p.email ? { email: p.email } : {}),
      ...(p.hint ? { hint: p.hint } : {}),
    }));
    for (const stepId of stepIds) out.push({ stepId, query, candidates, partial: result.partial });
  }
  return out;
}
