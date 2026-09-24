import { z } from 'zod';
import {
  DatasetQueryValidationError,
  normalizeDatasetUuid,
  type KnowledgeGraph,
} from '@omadia/plugin-api';

import { createBaselineDetector, maskPrompt } from '@omadia/plugin-privacy-guard';

import {
  decryptRows,
  isEncryptedCell,
  resolveDatasetCellKey,
  type DatasetCellKey,
} from '../datasetCellCrypto.js';
import { isLinkKeyColumn } from '../datasetLinkKey.js';
import { turnContext } from '../turnContext.js';

/**
 * #430 — native tool over `KnowledgeGraph.{listDatasets,getDataset,
 * queryDatasetRows}`. Mirrors `KnowledgeGraphTool`'s multi-query-shape
 * pattern (one tool, a `query` discriminator picks the operation) rather
 * than three separate tool specs — keeps the tool list short.
 *
 * ACL: every operation resolves the caller's CANONICAL `omadiaUserId` from
 * `turnContext.current()?.resolvedOmadiaUserId` — the same per-turn value
 * `ingestAttachments` uses to set `ownerOmadiaUserId` on CSV import (see
 * `resolveTurnOwnerIdentity`). This is deliberately NOT `turnContext.current()
 * ?.userId`: for a channel turn (Teams/Slack/Telegram) that field is the RAW
 * channel-native id (Teams AAD oid, …), which never matches the canonical
 * uuid a dataset was actually stored under — reading it here would make
 * every channel-native user's own just-imported datasets permanently
 * unfindable (#430 fixup, reviewer round 5). There is no anonymous dataset
 * access, and a dataset the caller doesn't own is indistinguishable from a
 * missing one (`not_found_or_not_owned`), matching the `/api/v1/memory`
 * ACL convention of never leaking existence to non-owners.
 *
 * `query_rows` never returns more than `filters`/`limit` allow — the
 * `KnowledgeGraph` implementation pages/aggregates server-side (see
 * `DatasetQueryOptions`), so this tool can't accidentally dump a whole
 * dataset into turn context even if the model asks it to.
 */

const FilterSchema = z.object({
  column: z.string().min(1).max(200),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const AggregateSchema = z.object({
  fn: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  /** Required for every `fn` except `count`. */
  column: z.string().min(1).max(200).optional(),
});

const QueryDatasetInputSchema = z.object({
  query: z.enum(['list_datasets', 'get_schema', 'query_rows']),
  /** Required for `get_schema` and `query_rows`. */
  dataset_id: z.string().min(1).max(200).optional(),
  /** `query_rows` only. Every `column` MUST be one of `get_schema`'s
   *  returned column names — unknown columns are rejected. */
  filters: z.array(FilterSchema).max(10).optional(),
  group_by: z.string().min(1).max(200).optional(),
  aggregate: AggregateSchema.optional(),
  /** Row cap for `query_rows` without `aggregate`. Clamped server-side to
   *  [1, 200]. */
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

/** A dataset the caller doesn't own is indistinguishable from a missing one
 *  (see the ACL note above) — an id that cannot address a row joins them. */
const NOT_FOUND_RESULT = JSON.stringify({ error: 'not_found_or_not_owned' });

/**
 * #1093 — `dataset_id` arrives straight from the model and used to reach the
 * persistence layer unchecked. On the Neon backend it lands in
 * `WHERE tenant_id = $1 AND id = $2` against a `uuid` column, so a non-uuid
 * id raises Postgres `22P02` BEFORE any owner check ever runs — which the
 * `get_schema` branch did not catch, so the rejection left the handler and
 * (streaming path) killed the whole turn.
 *
 * The id the model actually passes is a `ds_<uuid>` from a Privacy-Shield
 * digest: a turn-scoped IN-MEMORY dataset, a different id space from the
 * uploaded datasets this tool reads. That confusion is not the model being
 * careless — the digest and the orchestrator system prompt both tell it to
 * carry a `datasetId` to other tools (`create_xlsx` takes exactly this one),
 * so the `ds_` case gets its own message naming the right id space. Without
 * it the model re-sends the same id on the next iteration.
 *
 * Returns either the canonical id to query with, or the tool result to send
 * INSTEAD of dispatching.
 */
function resolveDatasetId(
  datasetId: string,
): { id: string } | { refusal: string } {
  const id = normalizeDatasetUuid(datasetId);
  if (id !== undefined) return { id };
  if (datasetId.trim().startsWith('ds_')) {
    return {
      refusal:
        'Error: privacy_shield_dataset_id — that id names a turn-scoped ' +
        'Privacy-Shield dataset (the `datasetId` from a digest), which lives ' +
        'in a different id space than the uploaded datasets `query_dataset` ' +
        'reads. Work on it with the `v4_*` verbs (or pass it to a file-export ' +
        'tool such as `create_xlsx`). `query_dataset` accepts only the uuid ' +
        'ids returned by `list_datasets` — call that first.',
    };
  }
  return { refusal: NOT_FOUND_RESULT };
}

export const QUERY_DATASET_TOOL_NAME = 'query_dataset';

export const queryDatasetToolSpec = {
  name: QUERY_DATASET_TOOL_NAME,
  description:
    'Query structured datasets (CSV imports) the current user has uploaded — tables of rows with typed columns, as opposed to free-text documents. ' +
    'Three operations via `query`:\n' +
    '- `list_datasets`: list the caller\'s datasets (id, name, row count, column names+types). Call this FIRST when you don\'t already know the `dataset_id`.\n' +
    '- `get_schema`: full column schema (name, inferred type, sample value) for one dataset — pass `dataset_id`.\n' +
    '- `query_rows`: filter/aggregate over a dataset\'s rows — pass `dataset_id` plus any of `filters` (column/op/value, `op` one of eq/neq/gt/gte/lt/lte/contains — gt/gte/lt/lte only on number columns, contains only on string columns), `group_by` (a column name), `aggregate` ({fn: count/sum/avg/min/max, column?}), `limit`, `offset`. ' +
    'A valid `dataset_id` is the uuid `list_datasets` returned for an UPLOADED dataset. A `ds_…` id from a privacy digest is a different id space and is NOT accepted here — use the `v4_*` verbs for those. ' +
    'NEVER invent column names — call `get_schema` first if unsure. Results are always paged/aggregated server-side; the response includes `totalMatched` so you can tell the user when there is more than what was returned. ' +
    'Columns named `__k_<column>` are LINK KEYS: a stable, identity-free key of `<column>` (same value in any of this user\'s uploads ⇒ same key, case/whitespace-insensitive). They are safe verb keys — use them as `by`/join keys in `v4_distinct`/`v4_join` to de-duplicate or match people across files or pages; never show them to the user and never filter on them with a guessed value.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        enum: ['list_datasets', 'get_schema', 'query_rows'],
      },
      dataset_id: { type: 'string' },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string' },
            op: {
              type: 'string',
              enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'],
            },
            value: {},
          },
          required: ['column', 'op', 'value'],
        },
      },
      group_by: { type: 'string' },
      aggregate: {
        type: 'object',
        properties: {
          fn: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
          column: { type: 'string' },
        },
        required: ['fn'],
      },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
    required: ['query'],
  },
};

/**
 * Turn stored `enc1:` cells into what THIS caller may see.
 *
 * - Behind the Privacy Shield (the turn carries a `privacyHandle`, so the
 *   result is about to be interned and the model gets a digest): the REAL
 *   values — that is what the materializer and `create_xlsx` need, and the
 *   model never receives them.
 * - Without a guard the result goes to the model in clear, so every
 *   decrypted cell is re-masked on read, with ONE pseudonym map across the
 *   page so different people get different surrogates.
 * - No key: cells stay `[verschlüsselt — …]` markers; nothing is guessed.
 */
async function revealOrMaskCells(
  rows: ReadonlyArray<Record<string, unknown>>,
  ownerOmadiaUserId: string,
  reveal: boolean,
): Promise<Array<Record<string, unknown>>> {
  if (!rows.some((r) => Object.values(r).some(isEncryptedCell))) return [...rows];
  const key = resolveDatasetCellKey();
  const cellKey: DatasetCellKey | undefined =
    key === undefined ? undefined : { key, ownerOmadiaUserId };
  const decrypted = decryptRows(cellKey, rows);
  if (reveal || cellKey === undefined) return decrypted;

  const detectors = [createBaselineDetector()];
  let map: Awaited<ReturnType<typeof maskPrompt>>['map'] | undefined;
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < decrypted.length; i++) {
    const original = rows[i]!;
    const row = { ...decrypted[i]! };
    for (const [column, value] of Object.entries(original)) {
      if (!isEncryptedCell(value) || typeof row[column] !== 'string') continue;
      const masked = await maskPrompt(row[column], detectors, map);
      map = masked.map;
      row[column] = masked.maskedText;
    }
    out.push(row);
  }
  return out;
}

export class QueryDatasetTool {
  constructor(private readonly graph: KnowledgeGraph) {}

  async handle(input: unknown): Promise<string> {
    const parsed = QueryDatasetInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid query_dataset input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    const args = parsed.data;
    const viewerOmadiaUserId = turnContext.current()?.resolvedOmadiaUserId;
    if (!viewerOmadiaUserId) {
      return 'Error: query_dataset requires a resolved user identity — not available for this channel/turn.';
    }

    switch (args.query) {
      case 'list_datasets': {
        try {
          const datasets = await this.graph.listDatasets({
            ownerOmadiaUserId: viewerOmadiaUserId,
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          });
          return JSON.stringify({
            datasets: datasets.map((d) => ({
              id: d.id,
              name: d.name,
              sourceFileName: d.sourceFileName,
              rowCount: d.rowCount,
              columns: d.columns.map((c) => ({ name: c.name, type: c.type })),
              createdAt: d.createdAt,
            })),
          });
        } catch (err) {
          // #1093 — every branch of this tool answers with the `Error:`
          // string convention rather than throwing: a backend blip (a
          // dropped Neon connection) is something the model can retry or
          // report, while a throw is a dead turn on the streaming path.
          return `Error: query_dataset failed — ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'get_schema': {
        if (!args.dataset_id) {
          return 'Error: get_schema requires `dataset_id`.';
        }
        const resolved = resolveDatasetId(args.dataset_id);
        if ('refusal' in resolved) return resolved.refusal;
        try {
          const dataset = await this.graph.getDataset(
            resolved.id,
            viewerOmadiaUserId,
          );
          if (!dataset) {
            return NOT_FOUND_RESULT;
          }
          return JSON.stringify({
            id: dataset.id,
            name: dataset.name,
            rowCount: dataset.rowCount,
            columns: dataset.columns,
          });
        } catch (err) {
          // #1093 — this branch used to have no catch at all: a rejection
          // left the handler and, in the streaming dispatch path, ended the
          // turn. A tool error the model can read and react to is always
          // preferable to a dead turn.
          return `Error: query_dataset failed — ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'query_rows': {
        if (!args.dataset_id) {
          return 'Error: query_rows requires `dataset_id`.';
        }
        const resolved = resolveDatasetId(args.dataset_id);
        if ('refusal' in resolved) return resolved.refusal;
        // A `__k_*` link key is safe to SEE but must never be a filter
        // target: `eq`/`contains` with a model-chosen value would let the
        // model test guesses against a stable per-person handle. The prompt
        // says so too, but the prompt is advice — this is the gate.
        const keyFilter = args.filters?.find((f) => isLinkKeyColumn(f.column));
        if (keyFilter) {
          return `Error: link_key_filter — column "${keyFilter.column}" is a link key; link keys can be join/distinct keys in v4 verbs but never filter targets.`;
        }
        try {
          const result = await this.graph.queryDatasetRows(
            resolved.id,
            viewerOmadiaUserId,
            {
              ...(args.filters ? { filters: args.filters } : {}),
              ...(args.group_by ? { groupBy: args.group_by } : {}),
              ...(args.aggregate ? { aggregate: args.aggregate } : {}),
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
              ...(args.offset !== undefined ? { offset: args.offset } : {}),
            },
          );
          if (!result) {
            return NOT_FOUND_RESULT;
          }
          if (result.rows === undefined) return JSON.stringify(result);
          // Real values only when this result is about to be interned behind
          // the Privacy Shield — the turn's privacy handle is the signal the
          // orchestrator itself uses to decide interning. No handle ⇒ the
          // model would read this string, so cells are re-masked instead.
          const reveal = turnContext.current()?.privacyHandle !== undefined;
          const rows = await revealOrMaskCells(result.rows, viewerOmadiaUserId, reveal);
          return JSON.stringify({ ...result, rows });
        } catch (err) {
          if (err instanceof DatasetQueryValidationError) {
            return `Error: ${err.code} — ${err.message}. Call \`get_schema\` to see the real column names/types.`;
          }
          return `Error: query_dataset failed — ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
}
