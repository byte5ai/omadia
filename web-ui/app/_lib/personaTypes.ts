// -----------------------------------------------------------------------------
// Persona-UI types — TS-Mirror of `PersonaConfigSchema` in
// middleware/src/plugins/builder/agentSpec.ts. Phase 4 (`harness-persona`,
// conditional) will move the canonical Zod schema into
// middleware/packages/plugin-api/src/persona.ts; this mirror exists so the
// Browser-View has a stable typed surface without importing the middleware
// bundle at compile time. Keep in sync manually until the schema is
// promoted to a shared package.
// -----------------------------------------------------------------------------

/** The 8 core axes — primary slider block (always visible). */
export const CORE_PERSONA_AXES = [
  'formality',
  'directness',
  'warmth',
  'humor',
  'sarcasm',
  'conciseness',
  'proactivity',
  'autonomy',
] as const;

/** The 4 extended axes — secondary slider block (collapsed by default). */
export const EXTENDED_PERSONA_AXES = [
  'risk_tolerance',
  'creativity',
  'drama',
  'philosophy',
] as const;

export type CorePersonaAxis = (typeof CORE_PERSONA_AXES)[number];
export type ExtendedPersonaAxis = (typeof EXTENDED_PERSONA_AXES)[number];
export type PersonaAxisKey = CorePersonaAxis | ExtendedPersonaAxis;

export const ALL_PERSONA_AXES: readonly PersonaAxisKey[] = [
  ...CORE_PERSONA_AXES,
  ...EXTENDED_PERSONA_AXES,
];

/** Range 0–100, default 50 = neutral (Family-Default behaviour). */
export type PersonaAxisValue = number;

export type PersonaAxes = Partial<Record<PersonaAxisKey, PersonaAxisValue>>;

export interface PersonaConfig {
  /** Optional template id (e.g. "software-engineer"). When set, Slider
   *  values originate from the template; "Reset to template" restores
   *  them. Templates ship with the Phase-4 `harness-persona` plugin —
   *  Phase 3 only carries the slot. */
  template?: string;
  axes?: PersonaAxes;
  /** Free-text override / clarifications. 2000-char cap (server-side). */
  custom_notes?: string;
}

/**
 * Slider label pair per axis. Mirrors Kemia's persona-dimensions.ts —
 * left = lower-end behaviour, right = upper-end behaviour. Range 0–100,
 * 50 = neutral / family-default.
 */
export const PERSONA_AXIS_LABELS: Record<
  PersonaAxisKey,
  { left: string; right: string; description: string }
> = {
  // Core (8) ──────────────────────────────────────────────────────────
  formality: {
    left: 'CASUAL',
    right: 'FORMAL',
    description: 'Du-Form & Umgangssprache vs. Sie-Form & Fachsprache.',
  },
  directness: {
    left: 'DIPLOMATIC',
    right: 'DIRECT',
    description: 'Höflichkeitspuffer vs. Kernaussage zuerst.',
  },
  warmth: {
    left: 'COOL',
    right: 'WARM',
    description: 'Sachlich-distanziert vs. empathisch & anerkennend.',
  },
  humor: {
    left: 'SERIOUS',
    right: 'PLAYFUL',
    description: 'Ohne Witz vs. spielerisch (sparsam einsetzen).',
  },
  sarcasm: {
    left: 'SINCERE',
    right: 'SARCASTIC',
    description: 'Ehrlich-direkt vs. ironisch (selten passend).',
  },
  conciseness: {
    left: 'EXPANSIVE',
    right: 'TERSE',
    description: 'Ausführlich vs. minimaler Wort-Output.',
  },
  proactivity: {
    left: 'REACTIVE',
    right: 'PROACTIVE',
    description: 'Antwortet auf Anfragen vs. schlägt von sich aus vor.',
  },
  autonomy: {
    left: 'CONSULTING',
    right: 'AUTONOMOUS',
    description: 'Fragt zurück vs. handelt eigenständig.',
  },
  // Extended (4) ──────────────────────────────────────────────────────
  risk_tolerance: {
    left: 'CAUTIOUS',
    right: 'BOLD',
    description: 'Sicherheits-zuerst vs. Risiko-tolerant.',
  },
  creativity: {
    left: 'CONVENTIONAL',
    right: 'INVENTIVE',
    description: 'Bewährte Lösungen vs. unkonventionelle Ideen.',
  },
  drama: {
    left: 'UNDERSTATED',
    right: 'DRAMATIC',
    description: 'Sachlich vs. emotional aufgeladen.',
  },
  philosophy: {
    left: 'PRAGMATIC',
    right: 'PHILOSOPHICAL',
    description: 'Lösung-orientiert vs. abstrakt-grundsätzlich.',
  },
};

/** Default value when an axis is unset — visual mid-point, no delta emission. */
export const PERSONA_AXIS_NEUTRAL = 50;

/** Hard cap for `custom_notes`; the Builder-Tool enforces this server-side. */
export const PERSONA_CUSTOM_NOTES_MAX_LENGTH = 2000;
