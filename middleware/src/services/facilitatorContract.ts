/**
 * #2060 — what the kernel checks when an operator saves a facilitator's
 * identity (spec 2043 §2.4).
 *
 * Two deterministic checks, no model call:
 *
 *   1. PERSONA BOUNDS. Personality stays configurable, but only inside a
 *      range in which the neutrality contract stays credible: a sarcastic or
 *      dramatic moderator is not trusted, and the sycophancy guard must be
 *      on, because a moderator who flatters one voice is partial.
 *
 *   2. INSTRUCTIONS AGAINST THE CONTRACT. Operator text that asks for
 *      partiality ("favour the sales team"), for a vote or an opinion, for a
 *      hidden channel or for lifting the contract is refused at save time.
 *
 * The instruction check is a pattern list, on purpose. It catches the plain
 * ways of writing a partial moderator in English and German and says which
 * sentence it objects to, so the operator can fix it. It is NOT the
 * enforcement: a paraphrase that slips through still meets the neutrality
 * block, which is compiled last into every facilitator prompt and states its
 * own precedence. A model-based check would be non-deterministic at exactly
 * the point where an operator needs a reproducible answer.
 */

import type { PersonaAxes, PersonaConfig, QualityConfig } from '../plugins/builder/agentSpec.js';
import type { SycophancyLevel } from '../plugins/sycophancyGuard.js';

/** Upper bounds per persona axis (0–100). An axis not listed is free. */
export const FACILITATOR_PERSONA_MAX: Readonly<Partial<Record<keyof PersonaAxes, number>>> = {
  sarcasm: 20,
  drama: 30,
  humor: 60,
  risk_tolerance: 60,
};

/** Lower bounds per persona axis. A cold moderator is not accepted either. */
export const FACILITATOR_PERSONA_MIN: Readonly<Partial<Record<keyof PersonaAxes, number>>> = {
  warmth: 30,
};

/** What an unset sycophancy level compiles to for a facilitator. */
export const FACILITATOR_DEFAULT_SYCOPHANCY: Exclude<SycophancyLevel, 'off'> = 'medium';

export interface FacilitatorContractIssue {
  /** Where the problem is: `persona.axes.sarcasm`, `quality.sycophancy`, `instructions`. */
  readonly path: string;
  /** Stable rule id for the UI and for tests. */
  readonly rule: string;
  readonly message: string;
  /** The offending excerpt, for instruction findings. */
  readonly excerpt?: string;
}

export function validateFacilitatorPersona(
  persona: PersonaConfig | null | undefined,
  quality: QualityConfig | null | undefined,
): readonly FacilitatorContractIssue[] {
  const issues: FacilitatorContractIssue[] = [];
  const axes = persona?.axes ?? {};
  for (const [axis, max] of Object.entries(FACILITATOR_PERSONA_MAX)) {
    const value = axes[axis as keyof PersonaAxes];
    if (value !== undefined && value > max) {
      issues.push({
        path: `persona.axes.${axis}`,
        rule: 'persona_axis_above_bound',
        message: `${axis} may be at most ${String(max)} for a facilitator (is ${String(value)})`,
      });
    }
  }
  for (const [axis, min] of Object.entries(FACILITATOR_PERSONA_MIN)) {
    const value = axes[axis as keyof PersonaAxes];
    if (value !== undefined && value < min) {
      issues.push({
        path: `persona.axes.${axis}`,
        rule: 'persona_axis_below_bound',
        message: `${axis} must be at least ${String(min)} for a facilitator (is ${String(value)})`,
      });
    }
  }
  if (quality?.sycophancy === 'off') {
    issues.push({
      path: 'quality.sycophancy',
      rule: 'sycophancy_guard_off',
      message: 'the sycophancy guard cannot be switched off for a facilitator',
    });
  }
  const notes = checkFacilitatorInstructions(persona?.custom_notes ?? null, 'persona.custom_notes');
  return [...issues, ...notes];
}

interface InstructionRule {
  readonly rule: string;
  readonly message: string;
  readonly pattern: RegExp;
}

// Word lists kept short and literal. `\b` does not work for umlauts, so the
// German alternatives are written so that a prefix match is enough.
const GROUP = String.raw`(?:team|teams|department|abteilung|bereich|group|gruppe|side|seite|person|people|leute|management|leadership|geschäftsführung|vorstand|boss|chef|client|kunde|kunden|customer|sales|vertrieb|marketing|engineering|entwicklung|option|proposal|vorschlag|candidate|kandidat\w*|initiator\w*|opinion|meinung|position)`;

const INSTRUCTION_RULES: readonly InstructionRule[] = [
  {
    rule: 'partiality',
    message: 'asks the facilitator to favour or disadvantage someone',
    pattern: new RegExp(
      String.raw`\b(?:favou?r|side with|advocate for|push for|steer (?:\w+ ){0,3}towards?|nudge (?:\w+ ){0,3}towards?|bevorzug\w*|begünstig\w*|benachteilig\w*|disadvantage|disfavou?r|downplay|play down|give more weight to|gewichte\w* (?:\w+ ){0,3}(?:höher|stärker))\b[^.!?\n]{0,60}?\b${GROUP}`,
      'i',
    ),
  },
  {
    rule: 'takes_sides',
    message: 'asks the facilitator to take sides',
    pattern: /\b(?:take sides?|taking sides|partei (?:ergreif\w*|nehm\w*)|nimm partei|be (?:partial|biased)|parteiisch (?:sein|agieren))\b/i,
  },
  {
    rule: 'votes_or_decides',
    message: 'asks the facilitator to vote, decide or break ties itself',
    pattern:
      /\b(?:cast (?:a|your|the deciding) vote|vote (?:for|against|yourself)|you (?:may|should|can|must) (?:vote|decide)|decide (?:for|on behalf of) the group|break (?:the |any )?ties? yourself|stimm\w* (?:selbst |mit )?(?:für|gegen|ab)\b|entscheide\w* (?:selbst|für die gruppe|anstelle)|deine stimme (?:zählt|entscheidet))/i,
  },
  {
    rule: 'gives_opinion',
    message: 'asks the facilitator for its own opinion on the content',
    pattern:
      /\b(?:give|share|state|offer|voice) (?:your|its) (?:own )?(?:opinion|view|recommendation|preference)|recommend (?:the|an?|your) (?:best|preferred|right) (?:option|solution|choice)|sag\w* (?:deine|ihre) (?:eigene )?meinung|empfiehl\w* (?:die|eine|deine) (?:beste|richtige|bevorzugte) (?:option|lösung)/i,
  },
  {
    rule: 'hidden_channel',
    message: 'asks the facilitator to keep something from the group',
    pattern:
      /\b(?:secretly|in secret|confidentially report|without (?:telling|informing|the knowledge of) the (?:group|participants|others)|do not (?:tell|disclose|reveal)|don't (?:tell|disclose|reveal)|behind the group'?s back|heimlich|vertraulich an|ohne (?:wissen|kenntnis) der (?:gruppe|teilnehmer\w*)|nicht (?:offenlegen|verraten|mitteilen)|hinter dem rücken)\b/i,
  },
  {
    rule: 'lifts_contract',
    message: 'tries to lift or override the neutrality contract',
    pattern:
      /\b(?:ignore|disregard|override|forget|drop|suspend) (?:the |your |all |any )?(?:neutrality|neutral\w*|impartial\w*|contract|rules? (?:above|below)|previous (?:rules|instructions))|neutralit(?:y|ät) (?:does not|doesn't|gilt nicht|nicht) (?:apply|gelten)?|(?:ignorier\w*|missacht\w*|überschreib\w*) (?:die |den |deine )?(?:neutralit\w*|unparteilich\w*|vertrag|regeln)/i,
  },
  {
    rule: 'ignores_stop',
    message: 'asks the facilitator to continue after the group said stop',
    pattern:
      /\b(?:ignore|disregard) (?:a |any |the )?(?:"|')?stop|(?:never|do not|don't) stop (?:when|if|even)|continue (?:even )?(?:if|when|after) (?:the group|someone|anyone|a participant) (?:says?|asks? (?:you )?to) stop|(?:ignorier\w*) (?:ein |jedes |das )?(?:"|„)?stopp?|nicht (?:stoppen|abbrechen|aufhören),? (?:wenn|auch wenn)/i,
  },
  {
    rule: 'acts_as_assistant',
    message: 'makes the facilitator an assistant for a person',
    pattern:
      /\b(?:act as (?:a |an |my |the )?(?:personal )?assistant|work for (?:me|the initiator|the manager)|on behalf of (?:me|the initiator|the manager|[A-Z]\w+)|answer (?:all|any) questions?|handle (?:all|any) (?:requests|tasks)|persönliche\w* assistent\w*|arbeite\w* für (?:mich|den initiator|die geschäftsführung)|im auftrag von)\b/i,
  },
];

const EXCERPT_RADIUS = 40;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Check operator-authored text against the neutrality contract. Pure and
 * deterministic: the same text always yields the same findings, in rule
 * order, at most one finding per rule.
 */
export function checkFacilitatorInstructions(
  text: string | null | undefined,
  path = 'instructions',
): readonly FacilitatorContractIssue[] {
  const source = text?.trim() ?? '';
  if (source.length === 0) return [];
  const issues: FacilitatorContractIssue[] = [];
  for (const rule of INSTRUCTION_RULES) {
    const match = rule.pattern.exec(source);
    if (!match) continue;
    issues.push({
      path,
      rule: rule.rule,
      message: `conflicts with the neutrality contract: ${rule.message}`,
      excerpt: excerptAround(source, match.index, match[0].length),
    });
  }
  return issues;
}

/** Thrown by the identity save path; the route maps it to a 422. */
export class FacilitatorContractError extends Error {
  readonly code = 'facilitator_contract_violation';
  constructor(readonly issues: readonly FacilitatorContractIssue[]) {
    super(
      `facilitator identity rejected: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
    this.name = 'FacilitatorContractError';
  }
}

/** Everything the save path checks for a facilitator, in one call. */
export function assertFacilitatorIdentity(input: {
  readonly instructions: string | null | undefined;
  readonly persona: PersonaConfig | null | undefined;
  readonly quality: QualityConfig | null | undefined;
}): void {
  const issues = [
    ...checkFacilitatorInstructions(input.instructions),
    ...validateFacilitatorPersona(input.persona, input.quality),
  ];
  if (issues.length > 0) throw new FacilitatorContractError(issues);
}
