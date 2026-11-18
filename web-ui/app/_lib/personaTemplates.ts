/**
 * Frontend mirror of `middleware/src/plugins/builder/personaTemplates.ts`.
 *
 * Lets `PersonaPillar` render the gallery + previews without a server
 * round-trip. The middleware snapshot tests + this file's structure
 * test guard against drift.
 *
 * @see Issue #53
 */

import {
  ALL_PERSONA_AXES,
  PERSONA_AXIS_NEUTRAL,
  type PersonaAxes,
  type PersonaConfig,
} from './personaTypes';

export type PersonaTemplateId =
  | 'customer-service'
  | 'sales-dev'
  | 'content-marketing'
  | 'research-analyst'
  | 'software-engineer'
  | 'team-lead';

export interface PersonaTemplateIdentity {
  creature: string;
  vibe: string;
}

export interface PersonaTemplateSuggestedSkill {
  role: string;
  tonality: string;
}

export interface PersonaTemplate {
  id: PersonaTemplateId;
  labelKey: string;
  axes: Required<PersonaAxes>;
  identity?: PersonaTemplateIdentity;
  suggested_skill?: PersonaTemplateSuggestedSkill;
}

const FULL_AXES = (
  formality: number,
  directness: number,
  warmth: number,
  humor: number,
  sarcasm: number,
  conciseness: number,
  proactivity: number,
  autonomy: number,
  risk_tolerance: number,
  creativity: number,
  drama: number,
  philosophy: number,
): Required<PersonaAxes> => ({
  formality,
  directness,
  warmth,
  humor,
  sarcasm,
  conciseness,
  proactivity,
  autonomy,
  risk_tolerance,
  creativity,
  drama,
  philosophy,
});

export const PERSONA_TEMPLATES: readonly PersonaTemplate[] = [
  {
    id: 'customer-service',
    labelKey: 'template.customer-service',
    axes: FULL_AXES(75, 30, 85, 20, 0, 40, 30, 20, 15, 25, 10, 5),
    identity: { creature: 'Assistent', vibe: 'Hilfsbereit, geduldig, lösungsorientiert' },
    suggested_skill: {
      role: 'Customer Service Agent',
      tonality: 'Freundlich, geduldig, verständnisvoll',
    },
  },
  {
    id: 'sales-dev',
    labelKey: 'template.sales-dev',
    axes: FULL_AXES(70, 65, 70, 30, 10, 60, 85, 50, 55, 45, 20, 10),
    identity: { creature: 'Berater', vibe: 'Überzeugend, authentisch, hartnäckig' },
    suggested_skill: {
      role: 'Sales Development Representative',
      tonality: 'Überzeugend, authentisch, hartnäckig',
    },
  },
  {
    id: 'content-marketing',
    labelKey: 'template.content-marketing',
    axes: FULL_AXES(40, 50, 60, 50, 25, 50, 80, 65, 60, 80, 45, 30),
    identity: { creature: 'Kreativer', vibe: 'Inspirierend, originell, markenaffin' },
    suggested_skill: {
      role: 'Content & Marketing Agent',
      tonality: 'Inspirierend, originell, markenaffin',
    },
  },
  {
    id: 'research-analyst',
    labelKey: 'template.research-analyst',
    axes: FULL_AXES(80, 70, 40, 10, 5, 30, 75, 70, 30, 40, 5, 55),
    identity: { creature: 'Analyst', vibe: 'Präzise, methodisch, quellenbasiert' },
    suggested_skill: {
      role: 'Research Analyst',
      tonality: 'Präzise, methodisch, quellenbasiert',
    },
  },
  {
    id: 'software-engineer',
    labelKey: 'template.software-engineer',
    axes: FULL_AXES(30, 80, 45, 40, 30, 80, 60, 75, 45, 55, 10, 20),
    identity: { creature: 'Entwickler', vibe: 'Pragmatisch, direkt, qualitätsbewusst' },
    suggested_skill: {
      role: 'Software Engineer',
      tonality: 'Pragmatisch, direkt, qualitätsbewusst',
    },
  },
  {
    id: 'team-lead',
    labelKey: 'template.team-lead',
    axes: FULL_AXES(55, 50, 70, 25, 15, 70, 85, 55, 40, 35, 15, 40),
    identity: { creature: 'Koordinator', vibe: 'Übersichtlich, diplomatisch, verbindlich' },
    suggested_skill: {
      role: 'Team Lead / Coordinator',
      tonality: 'Übersichtlich, diplomatisch, verbindlich',
    },
  },
];

export function getPersonaTemplate(id: string): PersonaTemplate | undefined {
  return PERSONA_TEMPLATES.find((t) => t.id === id);
}

/**
 * The axes after switching `current` to `next` (#1897, #1791).
 *
 * A template supplies all twelve axes, so the stored axes cannot tell an
 * operator's tuning apart from the previous template's profile. The baseline
 * makes that distinction: the previous template's profile, or neutral when no
 * template was set. Only axes that differ from it are the operator's own and
 * stay on top of the new template; every other axis follows the new one.
 */
export function axesForTemplate(
  current: PersonaConfig | undefined,
  next: PersonaTemplate,
): Required<PersonaAxes> {
  const baseline = current?.template
    ? getPersonaTemplate(current.template)?.axes
    : undefined;
  const axes: Required<PersonaAxes> = { ...next.axes };
  for (const axis of ALL_PERSONA_AXES) {
    const value = current?.axes?.[axis];
    if (value === undefined) continue;
    if (value !== (baseline?.[axis] ?? PERSONA_AXIS_NEUTRAL)) axes[axis] = value;
  }
  return axes;
}
