/**
 * #1556 follow-up — field-classification suggestions, the privacy guard's
 * half: which MASKED fields its Odoo tools return, and a small sample of
 * their values to vet with the guard's own detectors.
 *
 * Two structures, both in the service closure (never module scope), both
 * bounded:
 *
 *   - Observations — schema only (tool, field path, value shape, source
 *     models, counts, timestamps). Drained by `takeFieldObservations`; the
 *     kernel persists them.
 *   - Value samples — up to `MAX_SAMPLE_VALUES` distinct display strings per
 *     field (a many2one pair's label, or the string), each kept at most
 *     `SAMPLE_TTL_MS`. They are REAL values: never logged, never persisted,
 *     never handed to an LLM. Only the detector verdict (`fieldVetting.ts`)
 *     and the shape-masked preview leave the plugin.
 *
 * v1 scope: Odoo tools (`odoo_*`). Never a candidate: `sub-agent` narration,
 * canvas producers, `__k_` link keys, envelope metadata, fields an operator
 * rule already cleared (they are not masked), and mixed-shape fields.
 */

import type { FieldObservation, FieldValueShape } from '@omadia/plugin-api';

import { isLinkKeyField } from './v4/verbs/predicate.js';
import type { Dataset } from './v4/types.js';

/** Distinct (tool, field) observations held between two drains. */
export const MAX_OBSERVATIONS = 500;
/** Distinct values kept per (tool, field) sample. */
export const MAX_SAMPLE_VALUES = 50;
/** (tool, field) samples kept at once — bounds the buffer at
 *  `MAX_SAMPLE_FIELDS * MAX_SAMPLE_VALUES` values. The least recently fed
 *  field is dropped first. */
export const MAX_SAMPLE_FIELDS = 200;
/** A sampled value is dropped this long after it was last seen. */
export const SAMPLE_TTL_MS = 24 * 60 * 60 * 1000;
/** A longer value is cut to this many characters in the sample. */
export const MAX_SAMPLE_VALUE_CHARS = 500;

const OBSERVED_TOOL_PREFIX = 'odoo_';

/**
 * Field paths are raw tool-result keys; they end up in the admin page, the
 * audit log and — on an admin's confirm — in the `non_personal_fields`
 * setting. Only Odoo field names are recorded (no separators, wildcards,
 * whitespace or dots), so a key can never smuggle a second entry in.
 */
export const FIELD_PATH_GRAMMAR = /^[a-z_][a-z0-9_]*$/u;
/** Tool names a recorded observation may carry. */
export const TOOL_NAME_GRAMMAR = /^[a-z0-9_.-]+$/iu;
/** Odoo model names: dotted lowercase identifiers (same as the kernel's). */
export const MODEL_NAME_GRAMMAR = /^[a-z_][a-z0-9_]*(\.[a-z0-9_]+)*$/u;

/** The kept candidate shapes — `mixed` is never one. */
type CandidateShape = Exclude<FieldValueShape, 'mixed'>;

export interface FieldKey {
  readonly toolName: string;
  readonly fieldPath: string;
}

interface ObservationEntry {
  readonly toolName: string;
  readonly fieldPath: string;
  valueShape: CandidateShape;
  readonly sourceModels: Set<string>;
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

function keyOf(toolName: string, fieldPath: string): string {
  return `${toolName}\u0000${fieldPath}`;
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

/** A valid Odoo model name, trimmed — anything else is dropped. */
function validModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const model = value.trim();
  return MODEL_NAME_GRAMMAR.test(model) ? model : undefined;
}

/** The Odoo model a dataset was read from: the tool input's `model`, else
 *  an envelope's `model` metadata value. Invalid model names are dropped. */
function sourceModelOf(dataset: Dataset): string | undefined {
  const input = dataset.provenance.toolInput;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const model = validModel((input as Record<string, unknown>)['model']);
    if (model !== undefined) return model;
  }
  return validModel(dataset.envelope?.values['model']);
}

/** True for a tool whose results are observed at all. */
export function isObservedTool(toolName: string, excludedTools: ReadonlySet<string>): boolean {
  return (
    toolName.startsWith(OBSERVED_TOOL_PREFIX) &&
    TOOL_NAME_GRAMMAR.test(toolName) &&
    !excludedTools.has(toolName)
  );
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

  function observe(
    toolName: string,
    fieldPath: string,
    shape: CandidateShape,
    sourceModel: string | undefined,
  ): void {
    const key = keyOf(toolName, fieldPath);
    const at = new Date(now()).toISOString();
    const existing = observations.get(key);
    if (existing !== undefined) {
      existing.seenCount += 1;
      existing.lastSeenAt = at;
      // One field, two shapes across results: the latest wins (the kernel
      // resolves relation info from the schema, not from this).
      existing.valueShape = shape;
      if (sourceModel !== undefined) existing.sourceModels.add(sourceModel);
      return;
    }
    if (observations.size >= MAX_OBSERVATIONS) return;
    observations.set(key, {
      toolName,
      fieldPath,
      valueShape: shape,
      sourceModels: new Set(sourceModel === undefined ? [] : [sourceModel]),
      seenCount: 1,
      firstSeenAt: at,
      lastSeenAt: at,
    });
  }

  return {
    record(toolName, dataset, excludedTools) {
      if (!isObservedTool(toolName, excludedTools)) return;
      const sourceModel = sourceModelOf(dataset);
      for (const field of dataset.schema.fields) {
        if (field.classification !== 'sensitive-masked') continue;
        if (!FIELD_PATH_GRAMMAR.test(field.path) || isLinkKeyField(field.path)) continue;
        const values = dataset.rows.map((row) => row[field.path]);
        const shape = valueShapeOf(values);
        if (shape === undefined || shape === 'mixed') continue;
        observe(toolName, field.path, shape, sourceModel);
        const displays: string[] = [];
        for (const v of values) {
          const display = displayOf(v);
          if (display !== undefined) displays.push(display);
        }
        feedSample(keyOf(toolName, field.path), displays);
      }
    },

    take() {
      const out: FieldObservation[] = [...observations.values()].map((o) => ({
        toolName: o.toolName,
        fieldPath: o.fieldPath,
        valueShape: o.valueShape,
        sourceModels: [...o.sourceModels].sort(),
        seenCount: o.seenCount,
        firstSeenAt: o.firstSeenAt,
        lastSeenAt: o.lastSeenAt,
      }));
      observations.clear();
      return out;
    },

    sample(field) {
      return [...(liveSample(keyOf(field.toolName, field.fieldPath))?.keys() ?? [])];
    },

    clearSample(field) {
      samples.delete(keyOf(field.toolName, field.fieldPath));
    },
  };
}
