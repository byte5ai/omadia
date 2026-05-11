import type { PersonaConfig } from './builder/agentSpec.js';
import {
  computePersonaDeltas,
  significantDeltas,
  type PersonaAxisDelta,
  type PersonaModelFamily,
} from './personaDelta.js';

/**
 * Phase 3 / OB-67 Slice 9 — XML `<persona>`-section builder.
 *
 * Lifts a PersonaConfig + model family to a deterministic system-prompt
 * fragment. Only delta-based axes (operator-set values that diverge
 * meaningfully from the family default) and the optional `custom_notes`
 * carry through — neutral axes are silenced so the prompt stays terse
 * and the cache key only churns when settings actually changed.
 *
 * Output shape:
 *
 *   <persona>
 *   You communicate with the following intentional traits, relative to
 *   your default behaviour for this model:
 *   - directness: very high — lead with the core point, skip pleasantries
 *   - sarcasm: very high — wry, ironic, biting wit is welcome
 *   - warmth: noticeably lower — keep emotional distance
 *
 *   Personal notes from the operator:
 *   Antworte auf Deutsch wenn der User auf Deutsch schreibt.
 *   </persona>
 *
 * Empty input or all-neutral axes → empty string. The orchestrator's
 * compose path treats empty-string as "no persona section" and emits
 * the unmodified prompt — cache shape stays byte-identical to a
 * persona-less profile.
 */

const PERSONA_AXIS_PROSE: Record<
  string,
  Record<'lower' | 'higher', { slightly: string; strong: string }>
> = {
  formality: {
    lower: {
      slightly: 'a bit more casual — du-form is fine when it fits',
      strong: 'much more casual — du-form, colloquial, conversational',
    },
    higher: {
      slightly: 'slightly more formal — Sie-form, professional register',
      strong: 'much more formal — strict Sie-form, formal register, no slang',
    },
  },
  directness: {
    lower: {
      slightly: 'a bit more diplomatic — soften critical points',
      strong: 'much more diplomatic — lead with empathy, frame critique gently',
    },
    higher: {
      slightly: 'a bit more direct — surface the core point earlier',
      strong: 'very direct — lead with the core point, skip pleasantries',
    },
  },
  warmth: {
    lower: {
      slightly: 'slightly cooler — keep some emotional distance',
      strong: 'noticeably cooler — task-focused, minimal emotional registration',
    },
    higher: {
      slightly: 'a bit warmer — acknowledge the user\'s situation',
      strong: 'very warm — explicitly empathetic, acknowledge feelings',
    },
  },
  humor: {
    lower: {
      slightly: 'a bit more serious — minimal levity',
      strong: 'strictly serious — no jokes, no wordplay',
    },
    higher: {
      slightly: 'a bit more playful — light wordplay welcome',
      strong: 'distinctly playful — wit and wordplay are welcome',
    },
  },
  sarcasm: {
    lower: {
      slightly: 'a bit more earnest — avoid ironic framing',
      strong: 'fully sincere — no irony, no sarcasm',
    },
    higher: {
      slightly: 'a touch ironic — light sardonic notes are fine',
      strong: 'wry, ironic, biting wit is welcome',
    },
  },
  conciseness: {
    lower: {
      slightly: 'allow yourself a bit more elaboration',
      strong: 'expansive — explain the why and surface nuance',
    },
    higher: {
      slightly: 'a bit tighter — trim filler phrases',
      strong: 'very tight — minimal words, no padding',
    },
  },
  proactivity: {
    lower: {
      slightly: 'a bit more reactive — answer what was asked',
      strong: 'strictly reactive — answer what was asked, do not volunteer extras',
    },
    higher: {
      slightly: 'a bit more proactive — surface adjacent useful info',
      strong: 'distinctly proactive — anticipate needs, suggest next steps',
    },
  },
  autonomy: {
    lower: {
      slightly: 'lean toward asking back when steps are ambiguous',
      strong: 'strictly consultative — confirm before each non-trivial step',
    },
    higher: {
      slightly: 'lean toward acting on best-guess interpretation',
      strong: 'highly autonomous — pick a reasonable interpretation and execute',
    },
  },
  risk_tolerance: {
    lower: {
      slightly: 'a bit more cautious — surface trade-offs explicitly',
      strong: 'safety-first — flag risks, prefer reversible options',
    },
    higher: {
      slightly: 'a bit bolder — recommend the assertive option',
      strong: 'risk-tolerant — willing to recommend bold paths if rationale is sound',
    },
  },
  creativity: {
    lower: {
      slightly: 'a bit more conventional — prefer well-trodden patterns',
      strong: 'strictly conventional — pick the textbook solution',
    },
    higher: {
      slightly: 'a bit more inventive — entertain unusual angles',
      strong: 'distinctly inventive — surface unconventional ideas',
    },
  },
  drama: {
    lower: {
      slightly: 'a bit more understated — minimal emphasis markers',
      strong: 'understated — neutral register, no emotional escalation',
    },
    higher: {
      slightly: 'allow more emphasis when stakes are real',
      strong: 'dramatic — emphasise stakes, register emotional weight',
    },
  },
  philosophy: {
    lower: {
      slightly: 'a bit more pragmatic — focus on the immediate fix',
      strong: 'strictly pragmatic — solution-first, skip the abstractions',
    },
    higher: {
      slightly: 'allow brief framing in larger principles',
      strong: 'philosophical — connect specifics to underlying principles',
    },
  },
};

const MAGNITUDE_PREFIX: Record<'slightly' | 'strong', string> = {
  slightly: 'slightly',
  strong: 'strongly',
};

export interface ComposePersonaInput {
  persona: PersonaConfig | undefined;
  family: PersonaModelFamily;
}

/**
 * Render the `<persona>…</persona>` system-prompt section. Returns an
 * empty string when there is nothing meaningful to emit (operator
 * cleared the block, all axes are within neutral threshold AND no
 * custom_notes).
 */
export function composePersonaSection({
  persona,
  family,
}: ComposePersonaInput): string {
  if (!persona) return '';

  const deltas = significantDeltas(
    computePersonaDeltas(persona.axes, family),
  );
  const notes = persona.custom_notes?.trim() ?? '';

  if (deltas.length === 0 && notes.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('<persona>');
  if (deltas.length > 0) {
    lines.push(
      'You communicate with the following intentional traits, relative ' +
        'to your default behaviour for this model:',
    );
    for (const d of deltas) {
      lines.push(formatAxisLine(d));
    }
  }
  if (notes.length > 0) {
    if (deltas.length > 0) lines.push('');
    lines.push('Personal notes from the operator:');
    lines.push(notes);
  }
  lines.push('</persona>');
  return lines.join('\n');
}

function formatAxisLine(d: PersonaAxisDelta): string {
  const prose = PERSONA_AXIS_PROSE[d.axis as string];
  if (!prose) {
    // Forward-compat: an unknown axis name falls back to a numeric line.
    const dirWord = d.direction === 'lower' ? 'lower' : 'higher';
    return `- ${d.axis}: ${MAGNITUDE_PREFIX[d.magnitude as 'slightly' | 'strong']} ${dirWord} (${d.value} vs base ${d.base})`;
  }
  const description = prose[d.direction][d.magnitude as 'slightly' | 'strong'];
  return `- ${d.axis}: ${description}`;
}
