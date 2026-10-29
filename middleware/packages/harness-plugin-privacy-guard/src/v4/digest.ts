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
import { FILE_EXPORT_EXCEPTION, RENDER_CONTRACT } from './promptText.js';

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

/** A record (not a many2one `[id, label]` pair, not a scalar list) — the
 *  values the materializer can render only best-effort (#1542). */
function isStructure(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (!Array.isArray(value)) return true;
  return value.some((e) => e !== null && typeof e === 'object');
}

function holdsStructures(rows: ReadonlyArray<DatasetRow>, path: string): boolean {
  return rows.some((r) => isStructure(r[path]));
}

function buildFieldDigest(
  fc: FieldClassification,
  rows: ReadonlyArray<DatasetRow>,
): FieldDigest {
  if (fc.classification === 'sensitive-masked') {
    // Invariant I1: a placeholder + a count only — never a value. `shape` is
    // structural (is it an object?), never derived from a value's content.
    return {
      path: fc.path,
      type: fc.type,
      classification: 'sensitive-masked',
      placeholder: MASKED_PLACEHOLDER,
      distinctCount: fc.stats.distinctCount,
      ...(holdsStructures(rows, fc.path) ? { shape: 'nested' as const } : {}),
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
  const envelope = dataset.envelope;
  const metadata =
    envelope !== undefined && envelope.schema.fields.length > 0
      ? envelope.schema.fields.map((fc) => buildFieldDigest(fc, [envelope.values]))
      : undefined;
  return {
    datasetId: dataset.datasetId,
    rowCount: dataset.schema.rowCount,
    truncated: dataset.provenance.truncated,
    fields: dataset.schema.fields.map((fc) =>
      buildFieldDigest(fc, dataset.rows),
    ),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** #1561 — who reads a digest text (see `PrivacyDigestAudience`). */
export type DigestAudience = 'chat' | 'public-api';

export interface DigestTextOptions {
  /** Absent ⇒ `'chat'`. */
  readonly audience?: DigestAudience;
}

/**
 * Render a Digest as the text body of a `tool_result` block. The raw rows
 * stay server-side; the LLM receives this structural description only and
 * operates on the dataset through the Verb API (US5) + a render directive
 * (US6), keyed by `datasetId`.
 */
export function digestToToolResultText(digest: Digest, opts?: DigestTextOptions): string {
  if (opts?.audience === 'public-api') return digestToApiResultText(digest);
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
    `- ${RENDER_CONTRACT}`,
    '  Never drop an identity column, and never tell the user the data is',
    '  "filtered" or "cannot be shown" — they receive the real values, not',
    '  "[masked]".',
    `- EXCEPTION — file/download. ${FILE_EXPORT_EXCEPTION}`,
    '  Then reply with a short line like "Hier deine Excel-Datei:".',
    '- Never invent or guess a masked value yourself.',
    '- When a masked field is the SUBJECT of the answer (e.g. "which',
    '  department has the most …"), you cannot name it in your prose. Write',
    '  a complete sentence that points to the table instead, e.g. "Die',
    '  Abteilung mit den meisten aktiven Mitarbeitern steht in der Tabelle',
    '  unten (7 Mitarbeiter)." — never a sentence with a gap where the name',
    '  would be.',
    '- A masked field with "shape":"nested" holds a structure (a page body,',
    '  a version or space object). The server shows it as readable text where',
    '  it can, otherwise as "not renderable". Never promise its verbatim',
    '  content in your prose; if the render result names columns that could',
    '  not be shown, tell the user so in one sentence.',
    '- aggregate/group keep only the key + aggregate columns; to keep a',
    '  name on aggregated rows, join the result back to a dataset that',
    '  still carries the identity column.',
  ].join('\n');
  // An empty result is a fact the user must hear, not something to render:
  // without this line the header's "never say it cannot be shown" pushed
  // the model into a blind, contentless v4_render_answer list (#1467).
  const empty =
    digest.rowCount === 0
      ? '\n\nrowCount is 0: this dataset holds NO records. Do not call ' +
        'v4_render_answer for this dataset — tell the user plainly that ' +
        'there is no matching data.'
      : '';
  // v414 — envelope scalars (count, truncated, …) are metadata; a model that
  // took them for columns published them onto every canvas row.
  const metadata =
    digest.metadata !== undefined
      ? '\n\n"metadata" describes the WHOLE result (e.g. count, truncated) — ' +
        'it is NOT a row column: never select, render or publish a metadata ' +
        'path as a column; columns are the paths in "fields".'
      : '';
  return `${header}${empty}${metadata}\n\n${JSON.stringify(digest)}`;
}

/** Paths of the masked fields of a digest (records and metadata). */
function maskedPaths(fields: ReadonlyArray<FieldDigest>): string[] {
  return fields.filter((f) => f.classification === 'sensitive-masked').map((f) => f.path);
}

/**
 * #1561 — the digest as an external API caller (the public MCP endpoint)
 * receives it. That caller has no verb tools and no `v4_render_answer`, so
 * the chat header's instructions would be ones it cannot follow. This text
 * says what was returned (row count, the field paths, which are masked), that
 * the masked values are withheld for API callers, and where the caller can
 * get them. Same masking as the chat digest: the JSON below carries no
 * masked value, only safe-cleartext values and structure; the turn-scoped
 * `datasetId` is dropped because no tool the caller holds accepts it.
 */
export function digestToApiResultText(digest: Digest): string {
  const masked = [...maskedPaths(digest.fields), ...maskedPaths(digest.metadata ?? [])];
  const paths = digest.fields.map((f) => f.path);
  const rows = `${String(digest.rowCount)} row${digest.rowCount === 1 ? '' : 's'}`;
  const lines = [
    '[privacy-shield] This result passed the Privacy Shield. Below is its',
    'structure: the row count, every field path, and the values of the',
    'fields classified "safe-cleartext".',
    `Returned: ${rows}${digest.truncated ? ' (the source result was truncated)' : ''}; ` +
      `fields: ${JSON.stringify(paths)}.`,
  ];
  if (masked.length > 0) {
    lines.push(
      `Withheld: the values of ${JSON.stringify(masked)} ("sensitive-masked" —`,
      'personal or unclassified data) are not served to API callers over this',
      'endpoint; it never returns them, whatever the agent\'s privacy settings.',
      'An authorised user gets them through the chat (web chat or the public',
      'chat API, POST /api/public/v1/chat), where the server renders the real',
      'values for the authenticated caller.',
    );
  }
  if (digest.rowCount === 0) lines.push('The result holds no records.');
  if (paths.length === 1 && paths[0] === 'value' && masked.includes('value')) {
    lines.push(
      'The tool answered in prose, which is kept as one masked text field, so',
      'the row count says nothing about how many records the answer covered.',
    );
  }
  const { datasetId: _datasetId, ...structure } = digest;
  return `${lines.join('\n')}\n\n${JSON.stringify(structure)}`;
}
