/**
 * #2060 — the names of migration 0067 (`agents.kind`), kept while the column
 * exists next to `agents.archetype` (migration 0070, #2088).
 *
 * New code reads the archetype through `./archetype.js` (`archetypeOf`,
 * `archetypeOmits`, `assertArchetypeAllows`). This file only carries what a
 * client of the previous contract still names: the closed `kind` vocabulary
 * of the API and of the column, and the old names of the guard.
 */

import {
  ArchetypeOmissionError,
  FACILITATOR_ARCHETYPE,
  assertArchetypeAllows,
  isArchetype,
  type ArchetypeBearer,
  type ArchetypeOmission,
} from './archetype.js';

export const AGENT_KINDS = ['standard', 'facilitator'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** The value of the legacy `kind` column for an archetype: the two it can
 *  hold, `standard` for everything else. For OUTPUT only; never decide on it. */
export function parseAgentKind(raw: unknown): AgentKind {
  return raw === 'facilitator' ? 'facilitator' : 'standard';
}

/** @deprecated ask `isArchetype(agent, 'facilitator')`, or better `archetypeOmits`. */
export function isFacilitatorKind(agent: ArchetypeBearer | undefined | null): boolean {
  return isArchetype(agent, FACILITATOR_ARCHETYPE);
}

/** @deprecated `ArchetypeOmission`. */
export type FacilitatorOmission = ArchetypeOmission;

/** @deprecated `ArchetypeOmissionError`. */
export const FacilitatorOmissionError = ArchetypeOmissionError;
export type FacilitatorOmissionError = ArchetypeOmissionError;

/** @deprecated `assertArchetypeAllows`. */
export const assertNotFacilitator = assertArchetypeAllows;
