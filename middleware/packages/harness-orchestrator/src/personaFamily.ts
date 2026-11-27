/**
 * #1893 / ADR-0217 — which persona baseline a model id is measured against.
 *
 * Character sliders are absolute target levels; the persona compiler writes
 * only the difference to the natural behaviour of the model family the agent
 * runs on. The family therefore has to follow the real model: a Fable agent
 * gets the Fable baseline, an OpenAI agent the GPT profile, and a model nobody
 * profiled the neutral `unknown` profile — never silently the Sonnet one.
 *
 * ONE MAPPER. The middleware's persona compiler (`personaDelta.ts`) and the
 * turn loop's fallback switch (`Orchestrator.familyOf`) both use this
 * function: the compiled per-family prompts are stored under its keys, and a
 * second mapper would let the fallback pick a prompt compiled for another
 * family.
 */

/** Anthropic tiers with their own baseline (`FAMILY_DEFAULTS`). */
export const CLAUDE_PERSONA_TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type ClaudePersonaTier = (typeof CLAUDE_PERSONA_TIERS)[number];

/** Vendor families of the kemia baseline registry (`basePersonas.ts`). */
export const VENDOR_PERSONA_FAMILIES = [
  'anthropic-claude',
  'openai-gpt',
  'google-gemini',
  'meta-llama',
  'mistral',
  'alibaba-qwen',
  'deepseek',
  'moonshot-kimi',
  'zhipu-glm',
  '01ai-yi',
  'google-gemma',
  'microsoft-phi',
  'unknown',
] as const;
export type VendorPersonaFamily = (typeof VENDOR_PERSONA_FAMILIES)[number];

export type PersonaModelFamily = ClaudePersonaTier | VendorPersonaFamily;

/** The family of a model nobody profiled, and of an unresolved ref. */
export const UNKNOWN_PERSONA_FAMILY: PersonaModelFamily = 'unknown';

/**
 * Ordered: the first matching pattern wins, so the Claude tiers come before
 * the generic Claude entry. Short names (`o3`, `yi-`, `phi-3`) are anchored to
 * the start of the id or a separator so they cannot match inside other ids.
 */
const FAMILY_PATTERNS: readonly (readonly [RegExp, PersonaModelFamily])[] = [
  [/haiku/, 'haiku'],
  [/opus/, 'opus'],
  [/sonnet/, 'sonnet'],
  [/fable/, 'fable'],
  [/claude/, 'anthropic-claude'],
  [/gpt|openai|(^|[/:])o\d(-|$)/, 'openai-gpt'],
  [/gemma/, 'google-gemma'],
  [/gemini/, 'google-gemini'],
  [/llama/, 'meta-llama'],
  [/mistral|mixtral|codestral|magistral|ministral|pixtral/, 'mistral'],
  [/qwen|qwq/, 'alibaba-qwen'],
  [/deepseek/, 'deepseek'],
  [/kimi|moonshot/, 'moonshot-kimi'],
  [/glm/, 'zhipu-glm'],
  [/(^|[/:-])yi-/, '01ai-yi'],
  [/(^|[/:-])phi-?\d/, 'microsoft-phi'],
];

/**
 * Map a CONCRETE model id (`claude-fable-5-1`, `anthropic:claude-opus-5`,
 * `gpt-5`, `opus-cli`) to its persona family. A class ref (`class:balanced`),
 * `auto` or an empty id is not a model: resolve it first (the registry's
 * `runModelFor`); unresolved, it maps to `unknown`, as does any id no
 * pattern recognises.
 */
export function inferPersonaFamily(modelId: string): PersonaModelFamily {
  const lower = modelId.trim().toLowerCase();
  if (lower.length === 0 || lower === 'auto' || lower.startsWith('class:')) {
    return UNKNOWN_PERSONA_FAMILY;
  }
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(lower)) return family;
  }
  return UNKNOWN_PERSONA_FAMILY;
}
