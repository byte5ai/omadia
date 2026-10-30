/**
 * #1556 follow-up — field-classification suggestions, the privacy guard's
 * half: which MASKED fields its tools return, per source (tool + scope, see
 * `scopeOf`), and a small sample of their values to vet with the guard's own
 * detectors.
 *
 * Two structures, both in the service closure (never module scope), both
 * bounded:
 *
 *   - Observations — schema only (tool, scope, field path, value shape,
 *     counts, timestamps), one per (tool, scope, path). Drained by
 *     `takeFieldObservations`; the kernel persists them.
 *   - Value samples — up to `MAX_SAMPLE_VALUES` distinct display strings per
 *     (tool, scope, path) (a many2one pair's label, or the string), each kept
 *     at most `SAMPLE_TTL_MS`. They are REAL values: never logged, never
 *     persisted, never handed to an LLM. Only the detector verdict
 *     (`fieldVetting.ts`), the shape-masked preview and the admin-only
 *     `fieldSampleForAdmin` leave the plugin.
 *
 * Scope (contract v2): every interned tool result — plugin tools, Odoo, MCP
 * tools, uploads read via `query_dataset`. Never a candidate: `sub-agent`
 * narration, canvas producers (the caller's `excludedTools`), `v4_*` verbs,
 * `__k_` link keys, envelope metadata, fields an operator rule already
 * cleared (they are not masked), mixed-shape fields, any (tool, scope, path)
 * that cannot form exactly one scoped `non_personal_fields` entry, a path
 * that is itself a value (an e-mail-keyed map, a person as a CSV header —
 * `valueLikeFieldName.ts`), and the `key` / `value` / `groups` fields of a
 * grouped `query_dataset` result (`{ groups: [{ key, value }] }` — the keys
 * are the grouped column's VALUES, not a column).
 */

import type { FieldKey, FieldObservation, FieldValueShape } from '@omadia/plugin-api';

import { DATASET_TOOL, formatScopedEntry } from './nonPersonalFields.js';
import { isValueLikeFieldName } from './valueLikeFieldName.js';
import { isLinkKeyField } from './v4/verbs/predicate.js';
import { scopeOf } from './v4/datasetStore.js';
import type { Dataset } from './v4/types.js';

/** Distinct (tool, scope, field) observations held between two drains. */
export const MAX_OBSERVATIONS = 500;
/** Distinct values kept per (tool, scope, field) sample. */
export const MAX_SAMPLE_VALUES = 50;
/** (tool, scope, field) samples kept at once — bounds the buffer at
 *  `MAX_SAMPLE_FIELDS * MAX_SAMPLE_VALUES` values. The least recently fed
 *  field is dropped first. */
export const MAX_SAMPLE_FIELDS = 200;
/** A sampled value is dropped this long after it was last seen. */
export const SAMPLE_TTL_MS = 24 * 60 * 60 * 1000;
/** A longer value is cut to this many characters in the sample. */
export const MAX_SAMPLE_VALUE_CHARS = 500;

/** The Privacy Shield's own verbs — their rows come from observed sources. */
const VERB_TOOL_PREFIX = 'v4_';

/** The fields of a grouped `query_dataset` result: never a dataset column. */
const DATASET_GROUP_FIELDS: ReadonlySet<string> = new Set(['key', 'value', 'groups']);

/** Tool names a recorded observation may carry. */
export const TOOL_NAME_GRAMMAR = /^[a-z0-9_.-]+$/iu;

/** The kept candidate shapes — `mixed` is never one. */
type CandidateShape = Exclude<FieldValueShape, 'mixed'>;

interface ObservationEntry {
  readonly toolName: string;
  readonly scope: string;
  readonly fieldPath: string;
  valueShape: CandidateShape;
  seenCount: number;
  readonly firstSeenAt: string;
  lastSeenAt: string;
}

export interface FieldObservationRecorder {
  /** Record the masked, in-scope fields of a freshly interned dataset. */
  record(toolName: string, dataset: Dataset, excludedTools: ReadonlySet<string>): void;
  /** The observations since the last call, then cleared. Schema only. */
  take(): FieldObservation[];
  /** The field's live sample values (expired ones dropped first). */
  sample(field: FieldKey): readonly string[];
  /** Drop the field's sample. */
  clearSample(field: FieldKey): void;
}

function keyOf(field: FieldKey): string {
  return `${field.toolName}\u0000${field.scope}\u0000${field.fieldPath}`;
}

function isM2oPair(value: unknown): value is readonly [number, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'string'
  );
}

/** Odoo writes `false` for an unset field; null/undefined are absent. */
function isUnset(value: unknown): boolean {
  return value === null || value === undefined || value === false;
}

/**
 * The shape of a field's set values: `m2o` when every one is an Odoo
 * `[id, "label"]` pair, `text` when every one is a string, otherwise
 * `mixed`. `undefined` when no row sets the field.
 */
export function valueShapeOf(values: readonly unknown[]): FieldValueShape | undefined {
  const set = values.filter((v) => !isUnset(v));
  if (set.length === 0) return undefined;
  if (set.every(isM2oPair)) return 'm2o';
  if (set.every((v) => typeof v === 'string')) return 'text';
  return 'mixed';
}

/** The display string a sample keeps for one value, `undefined` when none. */
function displayOf(value: unknown): string | undefined {
  const text = isM2oPair(value) ? value[1] : typeof value === 'string' ? value : undefined;
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_SAMPLE_VALUE_CHARS ? trimmed.slice(0, MAX_SAMPLE_VALUE_CHARS) : trimmed;
}

/** True for a tool whose results are observed at all. */
export function isObservedTool(toolName: string, excludedTools: ReadonlySet<string>): boolean {
  return (
    TOOL_NAME_GRAMMAR.test(toolName) &&
    !toolName.startsWith(VERB_TOOL_PREFIX) &&
    !excludedTools.has(toolName)
  );
}

/** True when (tool, scope, path) may be recorded: not a link key, not a
 *  grouped dataset result's `key`/`value`/`groups`, not a value used as a
 *  key, and it forms exactly one scoped entry (the scoped-field grammar: a CSV header
 *  with inner spaces is fine; no line break, `:`, `;`, `,`, `/`, no `__k_`),
 *  so a key can never smuggle a second entry into the setting. */
export function isRecordableField(field: FieldKey): boolean {
  if (field.fieldPath.startsWith('__k_') || isLinkKeyField(field.fieldPath)) return false;
  if (field.toolName === DATASET_TOOL && DATASET_GROUP_FIELDS.has(field.fieldPath)) return false;
  // A key that is a value (an e-mail, a person's name) is never observed.
  if (isValueLikeFieldName(field.fieldPath)) return false;
  return formatScopedEntry({ tool: field.toolName, scope: field.scope }, field.fieldPath) !== undefined;
}

export function createFieldObservationRecorder(opts?: {
  readonly now?: () => number;
}): FieldObservationRecorder {
  const now = opts?.now ?? ((): number => Date.now());
  const observations = new Map<string, ObservationEntry>();
  // value → last seen (ms). Map order per field = insertion order.
  const samples = new Map<string, Map<string, number>>();

  function liveSample(key: string): Map<string, number> | undefined {
    const values = samples.get(key);
    if (values === undefined) return undefined;
    const cutoff = now() - SAMPLE_TTL_MS;
    for (const [value, seenAt] of values) {
      if (seenAt < cutoff) values.delete(value);
    }
    if (values.size === 0) {
      samples.delete(key);
      return undefined;
    }
    return values;
  }

  function feedSample(key: string, displays: readonly string[]): void {
    if (displays.length === 0) return;
    const values = liveSample(key) ?? new Map<string, number>();
    // Re-insert so the least recently fed field is the first one evicted.
    samples.delete(key);
    samples.set(key, values);
    const at = now();
    for (const display of displays) {
      if (values.has(display) || values.size < MAX_SAMPLE_VALUES) values.set(display, at);
    }
    while (samples.size > MAX_SAMPLE_FIELDS) {
      const oldest = samples.keys().next().value;
      if (oldest === undefined) break;
      samples.delete(oldest);
    }
  }

  function observe(field: FieldKey, shape: CandidateShape): void {
    const key = keyOf(field);
    const at = new Date(now()).toISOString();
    const existing = observations.get(key);
    if (existing !== undefined) {
      existing.seenCount += 1;
      existing.lastSeenAt = at;
      // One field, two shapes across results: the latest wins (the kernel
      // resolves relation info from the schema, not from this).
      existing.valueShape = shape;
      return;
    }
    if (observations.size >= MAX_OBSERVATIONS) return;
    observations.set(key, {
      toolName: field.toolName,
      scope: field.scope,
      fieldPath: field.fieldPath,
      valueShape: shape,
      seenCount: 1,
      firstSeenAt: at,
      lastSeenAt: at,
    });
  }

  return {
    record(toolName, dataset, excludedTools) {
      if (!isObservedTool(toolName, excludedTools)) return;
      const scope =
        dataset.provenance.sources?.find((s) => s.tool === toolName)?.scope ??
        scopeOf(toolName, dataset.provenance.toolInput, dataset.envelope?.values);
      for (const field of dataset.schema.fields) {
        if (field.classification !== 'sensitive-masked') continue;
        const key: FieldKey = { toolName, scope, fieldPath: field.path };
        if (!isRecordableField(key)) continue;
        const values = dataset.rows.map((row) => row[field.path]);
        const shape = valueShapeOf(values);
        if (shape === undefined || shape === 'mixed') continue;
        observe(key, shape);
        const displays: string[] = [];
        for (const v of values) {
          const display = displayOf(v);
          if (display !== undefined) displays.push(display);
        }
        feedSample(keyOf(key), displays);
      }
    },

    take() {
      const out: FieldObservation[] = [...observations.values()].map((o) => ({
        toolName: o.toolName,
        scope: o.scope,
        fieldPath: o.fieldPath,
        valueShape: o.valueShape,
        seenCount: o.seenCount,
        firstSeenAt: o.firstSeenAt,
        lastSeenAt: o.lastSeenAt,
      }));
      observations.clear();
      return out;
    },

    sample(field) {
      return [...(liveSample(keyOf(field))?.keys() ?? [])];
    },

    clearSample(field) {
      samples.delete(keyOf(field));
    },
  };
}
