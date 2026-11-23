/**
 * #2060 — what the working-mode route checks before a mode is attached to an
 * agent of an archetype other than `standard` (spec 2043 §2.3).
 *
 * The facilitator is allowed working modes that add moderation methods; it is
 * refused any mode that would change who speaks or what it is:
 *
 *   1. IDENTITY REPLACEMENT. A mode written as an identity of its own (a new
 *      name, a persona, speaking as someone else) is refused. The same check
 *      runs again when the agent is built (`workingModesKeepingIdentity`), so
 *      a skill edited after it was attached cannot bring it back.
 *   2. THE ROLE CONTRACT. For a facilitator the mode's text is checked against
 *      the neutrality contract like its instructions ("favour the sales
 *      team" is refused here too).
 *   3. NO CAPABILITIES. A skill can declare `requires_tools`; for an agent
 *      whose archetype omits tool grants that would be a tool grant through
 *      the back door, so such a mode is refused. The hydration leaves
 *      skill-bound tools out for these agents as well.
 *
 * A refusal is a `FacilitatorContractError` (422 with the findings), the same
 * answer the identity save gives.
 */

import {
  FACILITATOR_ARCHETYPE,
  STANDARD_ARCHETYPE,
  archetypeOf,
  archetypeOmits,
  findWorkingModeIdentityReplacement,
  type ArchetypeBearer,
} from '@omadia/orchestrator';

import { parseRequiresTools } from '../agents/subAgentToolHydration.js';
import {
  FacilitatorContractError,
  checkFacilitatorInstructions,
  type FacilitatorContractIssue,
} from './facilitatorContract.js';

export interface WorkingModeSkill {
  readonly name: string;
  readonly description: string | null;
  readonly body: string;
  readonly frontmatter: Record<string, unknown>;
}

export function workingModeIssues(
  agent: ArchetypeBearer,
  skill: WorkingModeSkill,
): readonly FacilitatorContractIssue[] {
  const archetype = archetypeOf(agent);
  if (archetype === STANDARD_ARCHETYPE) return [];
  const identity: FacilitatorContractIssue[] = findWorkingModeIdentityReplacement(skill).map((f) => ({
    path: f.path,
    rule: f.rule,
    message: f.message,
    ...(f.excerpt !== undefined ? { excerpt: f.excerpt } : {}),
  }));
  const contract =
    archetype === FACILITATOR_ARCHETYPE
      ? [
          ...checkFacilitatorInstructions(skill.description, 'working_mode.description'),
          ...checkFacilitatorInstructions(skill.body, 'working_mode.body'),
        ]
      : [];
  const tools: FacilitatorContractIssue[] =
    archetypeOmits(agent, 'tool_grant') && parseRequiresTools(skill.frontmatter).length > 0
      ? [
          {
            path: 'working_mode.frontmatter.requires_tools',
            rule: 'working_mode_tools',
            message:
              'a working mode of this agent cannot bring tools: its archetype omits tool grants, and a mode only changes how it works',
          },
        ]
      : [];
  return [...identity, ...contract, ...tools];
}

/** Throws the 422 refusal when the mode may not be attached to the agent. */
export function assertWorkingModeAllowed(agent: ArchetypeBearer, skill: WorkingModeSkill): void {
  const issues = workingModeIssues(agent, skill);
  if (issues.length > 0) throw new FacilitatorContractError(issues, 'working mode');
}
