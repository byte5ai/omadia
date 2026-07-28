import { z } from 'zod';
import {
  DatasetQueryValidationError,
  type KnowledgeGraph,
} from '@omadia/plugin-api';

import { turnContext } from '../turnContext.js';

/**
 * #430 — native tool over `KnowledgeGraph.{listDatasets,getDataset,
 * queryDatasetRows}`. Mirrors `KnowledgeGraphTool`'s multi-query-shape
 * pattern (one tool, a `query` discriminator picks the operation) rather
 * than three separate tool specs — keeps the tool list short.
 *
 * ACL: every operation resolves the caller's `omadiaUserId` from
 * `turnContext.current()` (same source the MCP-ingest path in
 * `orchestrator.ts` uses for `aclOwners`) — there is no anonymous dataset
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

export const QUERY_DATASET_TOOL_NAME = 'query_dataset';

export const queryDatasetToolSpec = {
  name: QUERY_DATASET_TOOL_NAME,
  description:
    'Query structured datasets (CSV imports) the current user has uploaded — tables of rows with typed columns, as opposed to free-text documents. ' +
    'Three operations via `query`:\n' +
    '- `list_datasets`: list the caller\'s datasets (id, name, row count, column names+types). Call this FIRST when you don\'t already know the `dataset_id`.\n' +
    '- `get_schema`: full column schema (name, inferred type, sample value) for one dataset — pass `dataset_id`.\n' +
    '- `query_rows`: filter/aggregate over a dataset\'s rows — pass `dataset_id` plus any of `filters` (column/op/value, `op` one of eq/neq/gt/gte/lt/lte/contains — gt/gte/lt/lte only on number columns, contains only on string columns), `group_by` (a column name), `aggregate` ({fn: count/sum/avg/min/max, column?}), `limit`, `offset`. ' +
    'NEVER invent column names — call `get_schema` first if unsure. Results are always paged/aggregated server-side; the response includes `totalMatched` so you can tell the user when there is more than what was returned.',
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
    const viewerOmadiaUserId = turnContext.current()?.userId;
    if (!viewerOmadiaUserId) {
      return 'Error: query_dataset requires a resolved user identity — not available for this channel/turn.';
    }

    switch (args.query) {
      case 'list_datasets': {
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
      }

      case 'get_schema': {
        if (!args.dataset_id) {
          return 'Error: get_schema requires `dataset_id`.';
        }
        const dataset = await this.graph.getDataset(
          args.dataset_id,
          viewerOmadiaUserId,
        );
        if (!dataset) {
          return JSON.stringify({ error: 'not_found_or_not_owned' });
        }
        return JSON.stringify({
          id: dataset.id,
          name: dataset.name,
          rowCount: dataset.rowCount,
          columns: dataset.columns,
        });
      }

      case 'query_rows': {
        if (!args.dataset_id) {
          return 'Error: query_rows requires `dataset_id`.';
        }
        try {
          const result = await this.graph.queryDatasetRows(
            args.dataset_id,
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
            return JSON.stringify({ error: 'not_found_or_not_owned' });
          }
          return JSON.stringify(result);
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
