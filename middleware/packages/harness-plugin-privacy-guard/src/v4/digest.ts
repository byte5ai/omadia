/**
 * Privacy Shield v4 — Digest builder (US3).
 *
 * Assembles the identity-free `Digest` the LLM receives in place of a raw
 * tool result. The Digest upholds invariant I1: no `sensitive-masked` field
 * carries any value, sample, prefix, suffix, or hash — only a placeholder and
 * an integer `distinctCount`. This is the assertion target of the on-the-wire
 * harness (US4).
 *
 * `buildDigest` is injected into the Dataset Store (US1) as its `DigestBuilder`.
 *
 * Contract: specs/001-privacy-shield-v4/contracts/dataset-store-and-digest.md
 */

import {
  MASKED_PLACEHOLDER,
  type Dataset,
  type DatasetRow,
  type Digest,
  type FieldClassification,
  type FieldDigest,
  type SafeSummary,
  type SafeType,
} from './types.js';

/** Below this row count, `safe-cleartext` values are inlined row-aligned in
 *  the Digest; at or above it, a summary is used instead (Digest invariant
 *  I2 — size is bounded by shape, not row content). */
export const INLINE_VALUES_MAX_ROWS = 25;

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function minMax(present: ReadonlyArray<unknown>):
  | { min: unknown; max: unknown }
  | undefined {
  if (present.length === 0) return undefined;
  let min: unknown = present[0];
  let max: unknown = present[0];
  for (const v of present) {
    if (compareValues(v, min) < 0) min = v;
    if (compareValues(v, max) > 0) max = v;
  }
  return { min, max };
}

function buildFieldDigest(
  fc: FieldClassification,
  rows: ReadonlyArray<DatasetRow>,
): FieldDigest {
  if (fc.classification === 'sensitive-masked') {
    // Invariant I1: a placeholder + a count only — never a value.
    return {
      path: fc.path,
      type: fc.type,
      classification: 'sensitive-masked',
      placeholder: MASKED_PLACEHOLDER,
      distinctCount: fc.stats.distinctCount,
    };
  }

  const type = fc.type as SafeType;
  const column = rows.map((r) => r[fc.path]);
  const present = column.filter((v) => v !== null && v !== undefined);

  // Small dataset — inline the actual safe values, row-aligned.
  if (rows.length <= INLINE_VALUES_MAX_ROWS) {
    return {
      path: fc.path,
      type,
      classification: 'safe-cleartext',
      values: column,
    };
  }

  // Larger dataset — a summary instead of every value.
  const summary: SafeSummary = {};
  if (type === 'number' || type === 'date') {
    const mm = minMax(present);
    if (mm !== undefined) {
      return {
        path: fc.path,
        type,
        classification: 'safe-cleartext',
        summary: { min: mm.min, max: mm.max },
      };
    }
  }
  if (type === 'enum') {
    return {
      path: fc.path,
      type,
      classification: 'safe-cleartext',
      summary: {
        distinctValues: [...new Set(present.map((v) => String(v)))],
      },
    };
  }
  return { path: fc.path, type, classification: 'safe-cleartext', summary };
}

/** Build the identity-free Digest for a stored Dataset. */
export function buildDigest(dataset: Dataset): Digest {
  return {
    datasetId: dataset.datasetId,
    rowCount: dataset.schema.rowCount,
    truncated: dataset.provenance.truncated,
    fields: dataset.schema.fields.map((fc) =>
      buildFieldDigest(fc, dataset.rows),
    ),
  };
}

/**
 * Render a Digest as the text body of a `tool_result` block. The raw rows
 * stay server-side; the LLM receives this structural description only and
 * operates on the dataset through the Verb API (US5) + a render directive
 * (US6), keyed by `datasetId`.
 */
export function digestToToolResultText(digest: Digest): string {
  const header = [
    '[privacy-shield-v4] The raw tool result is held server-side; you',
    'receive this structural digest only — no row data. Work on it through',
    'the verb tools (filter/sort/group/aggregate/top_n/select/count/join)',
    'keyed by datasetId, then call v4_render_answer to produce the final',
    'answer.',
    '',
    'A field whose digest shows "classification":"sensitive-masked" is',
    'hidden from YOU only — its real value exists server-side and the end',
    'user IS authorised to see it. Therefore:',
    '- To show masked values (names, e-mails, …) in the answer, INCLUDE',
    '  that column in v4_render_answer.columns — the server fills in the',
    '  real values for the user.',
    '- The final data answer MUST be a v4_render_answer call. Never write',
    '  the table/list yourself, never drop an identity column, and never',
    '  tell the user the data is "filtered" or "cannot be shown" — they',
    '  receive the real values, not "[masked]".',
    '- EXCEPTION — file/download: if the user wants a downloadable FILE (an',
    '  Excel/.xlsx export, a report document) rather than an inline answer,',
    '  do NOT use v4_render_answer. Instead call the file-export tool (e.g.',
    '  `create_xlsx`) and pass this `datasetId` — the server materializes the',
    '  real rows into the file. Then reply with a short line like "Hier deine',
    '  Excel-Datei:".',
    '- Never invent or guess a masked value yourself.',
    '- aggregate/group keep only the key + aggregate columns; to keep a',
    '  name on aggregated rows, join the result back to a dataset that',
    '  still carries the identity column.',
  ].join('\n');
  return `${header}\n\n${JSON.stringify(digest)}`;
}
