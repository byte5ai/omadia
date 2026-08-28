/**
 * Agent identity → system prompt (#914 follow-up).
 *
 * The identity's authored text, its persona axes, its boundaries and its
 * sycophancy level are four different things an operator sets in four
 * different controls. The agent speaks with ONE prompt. This module is the
 * single place that turns the first into the second.
 *
 * IT COMPILES NOTHING ITSELF. Every section comes from the compiler that
 * already owns it — `composePersonaSection` (the delta math against the model
 * family), `compileBoundariesSection` (the kemia preset library),
 * `compileSycophancyGuard` (the anti-flattery guard). Re-implementing any of
 * them here would fork the behaviour between a deployed agent and the
 * Builder's preview of the same settings, which is exactly the drift the
 * builder's own parity test exists to prevent.
 *
 * ORDER IS THE CONTRACT: instructions → persona → boundaries → sycophancy.
 * It mirrors `dynamicAgentRuntime`'s `[header, persona, boundaries,
 * sycophancy, skill]` for sub-agents: who you are, how you sound, what you
 * must not do, how not to flatter. Identity text takes the header slot
 * because it is the operator's own words about this agent.
 *
 * EMPTY IN, EMPTY OUT. An identity with nothing authored compiles to `''`,
 * and the caller stores NULL — which is what makes the platform-wide
 * assistant identity apply unchanged to every agent that never used this.
 */

import { compileBoundariesSection } from '../plugins/builder/boundaryPresets.js';
import type {
  PersonaConfig,
  QualityConfig,
} from '../plugins/builder/agentSpec.js';
import { composePersonaSection } from '../plugins/personaCompose.js';
import type { PersonaModelFamily } from '../plugins/personaDelta.js';
import { compileSycophancyGuard } from '../plugins/sycophancyGuard.js';

export interface ComposeAgentIdentityPromptInput {
  /** The operator's own text about this agent. */
  readonly instructions: string | null;
  readonly persona: PersonaConfig | null;
  readonly quality: QualityConfig | null;
  /** Which model family the persona deltas are computed against. */
  readonly family: PersonaModelFamily;
}

export interface ComposedAgentIdentityPrompt {
  /** The assembled prompt, or `null` when nothing was authored. */
  readonly text: string | null;
  /** Boundary preset ids this build could not resolve. Surfaced to the
   *  operator rather than dropped in silence: a preset that vanished from the
   *  library is a rule the agent stopped following. */
  readonly droppedBoundaryPresets: readonly string[];
}

export function composeAgentIdentityPrompt(
  input: ComposeAgentIdentityPromptInput,
): ComposedAgentIdentityPrompt {
  const sections: string[] = [];

  const instructions = input.instructions?.trim() ?? '';
  if (instructions.length > 0) sections.push(instructions);

  const persona = composePersonaSection({
    persona: input.persona ?? undefined,
    family: input.family,
  });
  if (persona.length > 0) sections.push(persona);

  const boundaries = compileBoundariesSection(
    input.quality?.boundaries?.presets ?? [],
    input.quality?.boundaries?.custom ?? [],
  );
  if (boundaries.text.length > 0) sections.push(boundaries.text);

  const sycophancy = compileSycophancyGuard(input.quality?.sycophancy);
  if (sycophancy.length > 0) sections.push(sycophancy);

  return {
    text: sections.length > 0 ? sections.join('\n\n') : null,
    droppedBoundaryPresets: boundaries.droppedIds,
  };
}

/**
 * Which persona family an agent's configured model belongs to.
 *
 * Deliberately a re-export of the delta module's own mapper rather than a second
 * `includes('haiku')` chain: the family decides which axes are emitted at
 * all, and two mappers disagreeing would mean the preview and the running
 * agent describe different characters.
 */
export { inferFamilyFromModel } from '../plugins/personaDelta.js';
