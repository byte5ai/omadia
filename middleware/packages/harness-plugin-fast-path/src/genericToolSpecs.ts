import { FAST_PATH_TOOL_SPECS, type FastPathToolSpec } from './fastPath.js';
import { isRowTool } from './literalStripping.js';

/**
 * Generic planner specs — the fast path for EVERY plugin's read tools.
 *
 * Only `odoo_query` has a hand-written catalog spec (fastPath.ts); every
 * other read tool used to be invisible to router and planner until a learned
 * plan existed. Here a compact spec is derived from the tool's own registry
 * definition (description + JSON input schema) — the same definition the
 * answering agent offers its model:
 *
 *   - the NAME classifier stays the gate: only `isRowTool` names (read verb,
 *     no write token, no `describe`) get a spec; a catalog spec wins;
 *   - the text is plugin-authored (description, property names/types/enums)
 *     — never user data; emails and long digit runs are scrubbed anyway;
 *   - the prompt stays small and cache-stable: per-tool cap
 *     ({@link GENERIC_SPEC_MAX_CHARS}), total budget
 *     ({@link GENERIC_SPECS_BUDGET}), name order, deterministic truncation —
 *     the same tool set yields the byte-identical text on every turn;
 *   - the output shape is unknown, so a plan for a generic tool must name its
 *     `itemsPath` (planner.ts); `fetchRecipeRows` refuses a result where it is
 *     not an array, so a wrong guess falls back to the agent.
 */

/** A tool definition as the agent offers it to its model (Anthropic
 *  `{name, description, input_schema}`) — structural, so the kernel's
 *  `NativeToolSpec` and channel-sdk's `ChatAgentToolDefinition` both fit. */
export interface FastPathToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly input_schema?: unknown;
}

/** Hard cap of ONE generic spec line. */
export const GENERIC_SPEC_MAX_CHARS = 600;
/** Total size of all generic spec lines of one prompt. */
export const GENERIC_SPECS_BUDGET = 6000;
/** Tool description share of a spec. */
const DESCRIPTION_MAX_CHARS = 280;
/** Per-property description share (dropped first when a spec is too long). */
const PROPERTY_HINT_MAX_CHARS = 60;
/** Enum values listed per property. */
const MAX_ENUM_VALUES = 8;
/** Router one-liner of a generic tool. */
const PURPOSE_MAX_CHARS = 160;

/** Marker the planner rules refer to. */
export const GENERIC_MARKER = '[generic]';

/** The planner rule for generic tools — appended once when any is offered. */
export const GENERIC_TOOLS_RULE =
  `${GENERIC_MARKER} tools are described only by their own input schema; their output shape is NOT documented. ` +
  'For one: "input" must satisfy the schema exactly (only listed properties, required ones set); "itemsPath" is ' +
  'REQUIRED — the dot-path of the record ARRAY in the tool\'s JSON output (e.g. "records", "value", "data.items"); ' +
  '"map" only attributes the description names. A wrong itemsPath or map is refused at execution and the agent answers.';

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const LONG_NUMBER = /\b\d{5,}\b/g;

/** One line, no emails or long digit runs (phone/customer numbers). */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').replace(EMAIL, '<email>').replace(LONG_NUMBER, '<number>').trim();
}

/** `text` cut to `max` chars — at the last sentence end inside, else the
 *  last word boundary, with an ellipsis. Deterministic. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const sentence = head.lastIndexOf('. ');
  if (sentence >= max / 2) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(' ');
  return `${word >= max / 2 ? head.slice(0, word) : head}…`;
}

/** The first sentence of `text` (≤ `max`). */
function firstSentence(text: string, max: number): string {
  const end = text.search(/[.!?](\s|$)/);
  return clip(end > 0 ? text.slice(0, end + 1) : text, max);
}

/** Locale-independent order — the prompt must not depend on the ICU locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Compact JSON-schema type of one property: `string`, `integer`,
 *  `string[]`, `"a"|"b"`, `object`, … */
export function schemaType(schema: unknown): string {
  const s = asRecord(schema);
  if (!s) return 'any';
  const enumValues = s['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const shown = enumValues.slice(0, MAX_ENUM_VALUES).map((v) => JSON.stringify(v)).join('|');
    return enumValues.length > MAX_ENUM_VALUES ? `${shown}|…` : shown;
  }
  const type = s['type'];
  if (type === 'array') return `${schemaType(s['items'])}[]`;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string').join('|') || 'any';
  const variants = s['anyOf'] ?? s['oneOf'];
  if (Array.isArray(variants) && variants.length > 0) return variants.map(schemaType).join('|');
  return 'any';
}

/** The input-schema digest: `{ "k": type — hint, "opt"?: type }`. */
function inputDigest(schema: unknown, withHints: boolean): string {
  const s = asRecord(schema);
  const props = asRecord(s?.['properties']);
  if (!props || Object.keys(props).length === 0) return '{}';
  const required = new Set(Array.isArray(s?.['required']) ? (s['required'] as unknown[]) : []);
  const parts = Object.keys(props)
    .sort(byCodeUnit)
    .map((key) => {
      const prop = props[key];
      const hintRaw = asRecord(prop)?.['description'];
      const hint =
        withHints && typeof hintRaw === 'string' && hintRaw.trim().length > 0
          ? ` — ${firstSentence(clean(hintRaw), PROPERTY_HINT_MAX_CHARS)}`
          : '';
      return `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${schemaType(prop)}${hint}`;
    });
  return `{ ${parts.join(', ')} }`;
}

/**
 * The compact spec line of ONE tool, ≤ {@link GENERIC_SPEC_MAX_CHARS}:
 * name, marker, clipped description, input digest. Too long → the property
 * hints go first, then the digest is cut.
 */
export function genericToolSpec(def: FastPathToolDefinition): string {
  const description = clip(clean(def.description ?? ''), DESCRIPTION_MAX_CHARS);
  const head = `${def.name} ${GENERIC_MARKER} — ${description.length > 0 ? description : 'read tool'}`;
  for (const withHints of [true, false]) {
    const line = `${head} input: ${inputDigest(def.input_schema, withHints)}`;
    if (line.length <= GENERIC_SPEC_MAX_CHARS) return line;
  }
  return `${head} input: ${inputDigest(def.input_schema, false)}`.slice(0, GENERIC_SPEC_MAX_CHARS - 1) + '…';
}

/** The router's one-liner of a generic tool: its description's first sentence. */
export function genericToolPurpose(def: FastPathToolDefinition): string {
  const description = clean(def.description ?? '');
  return description.length > 0 ? firstSentence(description, PURPOSE_MAX_CHARS) : 'read tool';
}

/**
 * Generic planner specs for the `definitions` the agent offers: row tools by
 * name (`isRowTool`) without a catalog spec and not in `exclude`, in name
 * order, each ≤ {@link GENERIC_SPEC_MAX_CHARS}, together ≤ `budget` (a tool
 * that no longer fits is skipped; smaller later ones may still fit).
 * Duplicate names: the first definition counts. Same input → same output.
 */
export function genericToolSpecs(
  definitions: readonly FastPathToolDefinition[],
  opts: { exclude?: ReadonlySet<string>; budget?: number } = {},
): FastPathToolSpec[] {
  const budget = opts.budget ?? GENERIC_SPECS_BUDGET;
  const seen = new Set<string>();
  const candidates = definitions
    .filter((d) => {
      if (typeof d.name !== 'string' || seen.has(d.name)) return false;
      seen.add(d.name);
      return isRowTool(d.name) && FAST_PATH_TOOL_SPECS[d.name] === undefined && opts.exclude?.has(d.name) !== true;
    })
    .sort((a, b) => byCodeUnit(a.name, b.name));
  const out: FastPathToolSpec[] = [];
  let used = 0;
  for (const def of candidates) {
    const spec = genericToolSpec(def);
    if (used + spec.length > budget) continue;
    used += spec.length;
    out.push({ name: def.name, spec, purpose: genericToolPurpose(def), generic: true });
  }
  return out;
}
