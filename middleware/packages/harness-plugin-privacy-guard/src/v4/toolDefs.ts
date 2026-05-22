/**
 * Privacy Shield v4 — LLM-facing tool surface (US5 exposure / US6 directive).
 *
 * The 8 verbs are offered to the LLM as individual tool calls (research D7).
 * This module is the verification-friendly core of that exposure: the tool
 * specs (name + description + JSON input schema), a robust dispatcher that
 * parses LLM-provided input and routes to the Verb engine, and the parser for
 * the final-answer render directive. The thin orchestrator registration wires
 * these in.
 *
 * Contract: specs/001-privacy-shield-v4/contracts/verb-api.md
 */

import type {
  AggregateOp,
  Predicate,
  RenderDirective,
  RenderFormat,
  SortDirection,
  VerbResult,
} from './types.js';
import {
  VerbError,
  type AggregateParams,
  type VerbEngine,
} from './verbs/index.js';

// ---------------------------------------------------------------------------
// Tool specs offered to the LLM
// ---------------------------------------------------------------------------

export interface V4ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input. */
  readonly inputSchema: Record<string, unknown>;
}

const DATASET_ID = {
  type: 'string',
  description: 'A datasetId from a tool digest or an earlier verb result.',
};

/** The 8 verb tools. Every verb returns a new datasetId + digest, so verbs
 *  compose. The LLM never receives row data — only digests. */
export const VERB_TOOL_SPECS: ReadonlyArray<V4ToolSpec> = [
  {
    name: 'v4_filter',
    description:
      'Keep only rows matching a predicate. The predicate is a JSON tree ' +
      'using ops eq/ne/lt/lte/gt/gte/in/between/and/or/not over safe ' +
      '(non-masked) fields only.',
    inputSchema: {
      type: 'object',
      properties: { datasetId: DATASET_ID, predicate: { type: 'object' } },
      required: ['datasetId', 'predicate'],
    },
  },
  {
    name: 'v4_sort',
    description: 'Reorder rows by a field, ascending or descending.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: DATASET_ID,
        by: { type: 'string' },
        direction: { enum: ['asc', 'desc'] },
      },
      required: ['datasetId', 'by'],
    },
  },
  {
    name: 'v4_top_n',
    description: 'Return the first n rows after sorting by a field.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: DATASET_ID,
        n: { type: 'integer', minimum: 0 },
        by: { type: 'string' },
        direction: { enum: ['asc', 'desc'] },
      },
      required: ['datasetId', 'n', 'by'],
    },
  },
  {
    name: 'v4_group',
    description:
      'Return the distinct combinations of one or more safe fields.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: DATASET_ID,
        by: { type: 'array', items: { type: 'string' } },
      },
      required: ['datasetId', 'by'],
    },
  },
  {
    name: 'v4_aggregate',
    description:
      'Compute aggregates (count/sum/min/max/avg). With groupBy, emits one ' +
      'row per group; without it, one row over the whole dataset.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: DATASET_ID,
        groupBy: { type: 'array', items: { type: 'string' } },
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              alias: { type: 'string' },
              fn: { enum: ['count', 'sum', 'min', 'max', 'avg'] },
              field: { type: 'string' },
            },
            required: ['alias', 'fn'],
          },
        },
      },
      required: ['datasetId', 'ops'],
    },
  },
  {
    name: 'v4_select',
    description: 'Project the dataset down to a subset of columns.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: DATASET_ID,
        columns: { type: 'array', items: { type: 'string' } },
      },
      required: ['datasetId', 'columns'],
    },
  },
  {
    name: 'v4_count',
    description: 'Return the row count of a dataset as a single scalar.',
    inputSchema: {
      type: 'object',
      properties: { datasetId: DATASET_ID },
      required: ['datasetId'],
    },
  },
  {
    name: 'v4_join',
    description: 'Inner-join two datasets on a pair of safe key fields.',
    inputSchema: {
      type: 'object',
      properties: {
        leftDatasetId: DATASET_ID,
        rightDatasetId: DATASET_ID,
        leftKey: { type: 'string' },
        rightKey: { type: 'string' },
      },
      required: ['leftDatasetId', 'rightDatasetId', 'leftKey', 'rightKey'],
    },
  },
];

/** The terminal render tool — the LLM's final answer. The orchestrator
 *  intercepts this, materializes server-side, and the rendered output (real
 *  values) becomes the channel answer; it never returns through the LLM. */
export const RENDER_TOOL_SPEC: V4ToolSpec = {
  name: 'v4_render_answer',
  description:
    'Produce the final answer — ALWAYS end a data question with this call; ' +
    'never write the data table/list yourself. Provide PII-free prose plus ' +
    'the datasetId, the columns to show, and a format (table/list/scalar). ' +
    '`columns` SHOULD include identity / sensitive-masked fields (names, ' +
    'e-mails): the server fills in their real values for the authorised ' +
    'user. The rendered answer never returns through you.',
  inputSchema: {
    type: 'object',
    properties: {
      datasetId: DATASET_ID,
      columns: { type: 'array', items: { type: 'string' } },
      format: { enum: ['table', 'list', 'scalar'] },
      prose: { type: 'string' },
    },
    required: ['datasetId', 'columns', 'format'],
  },
};

const VERB_TOOL_NAMES: ReadonlySet<string> = new Set(
  VERB_TOOL_SPECS.map((s) => s.name),
);

/** True when `name` is one of the v4 verb tools. */
export function isVerbToolName(name: string): boolean {
  return VERB_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Input parsing — LLM-provided tool input is untrusted JSON
// ---------------------------------------------------------------------------

function asObject(value: unknown, ctx: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new VerbError(`${ctx}: expected an object input`);
  }
  return value as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new VerbError(`missing or invalid string field "${key}"`);
  }
  return v;
}

function reqStringArray(o: Record<string, unknown>, key: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new VerbError(`missing or invalid string-array field "${key}"`);
  }
  return v as string[];
}

function optStringArray(
  o: Record<string, unknown>,
  key: string,
): string[] | undefined {
  return o[key] === undefined ? undefined : reqStringArray(o, key);
}

function reqInteger(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new VerbError(`missing or invalid integer field "${key}"`);
  }
  return v;
}

function optDirection(value: unknown): SortDirection | undefined {
  if (value === undefined) return undefined;
  if (value === 'asc' || value === 'desc') return value;
  throw new VerbError('"direction" must be "asc" or "desc"');
}

function reqAggregateOps(value: unknown): AggregateOp[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new VerbError('"ops" must be a non-empty array');
  }
  return value.map((raw): AggregateOp => {
    const o = asObject(raw, 'aggregate op');
    const fn = o.fn;
    if (
      fn !== 'count' &&
      fn !== 'sum' &&
      fn !== 'min' &&
      fn !== 'max' &&
      fn !== 'avg'
    ) {
      throw new VerbError('aggregate op "fn" must be count/sum/min/max/avg');
    }
    const field = o.field;
    if (field !== undefined && typeof field !== 'string') {
      throw new VerbError('aggregate op "field" must be a string');
    }
    const alias = reqString(o, 'alias');
    return field === undefined ? { alias, fn } : { alias, fn, field };
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Parse an LLM verb-tool call and run it on the engine. Throws `VerbError`
 *  for malformed input or an unknown verb. */
export function dispatchVerbCall(
  engine: VerbEngine,
  toolName: string,
  input: unknown,
): VerbResult {
  const o = asObject(input, `verb "${toolName}"`);
  switch (toolName) {
    case 'v4_filter': {
      const predicate = o.predicate;
      if (predicate === null || typeof predicate !== 'object') {
        throw new VerbError('"predicate" must be a predicate object');
      }
      return engine.filter(reqString(o, 'datasetId'), predicate as Predicate);
    }
    case 'v4_sort':
      return engine.sort(
        reqString(o, 'datasetId'),
        reqString(o, 'by'),
        optDirection(o.direction),
      );
    case 'v4_top_n':
      return engine.topN(
        reqString(o, 'datasetId'),
        reqInteger(o, 'n'),
        reqString(o, 'by'),
        optDirection(o.direction),
      );
    case 'v4_group':
      return engine.group(reqString(o, 'datasetId'), reqStringArray(o, 'by'));
    case 'v4_aggregate': {
      const groupBy = optStringArray(o, 'groupBy');
      const params: AggregateParams =
        groupBy === undefined
          ? { ops: reqAggregateOps(o.ops) }
          : { groupBy, ops: reqAggregateOps(o.ops) };
      return engine.aggregate(reqString(o, 'datasetId'), params);
    }
    case 'v4_select':
      return engine.select(
        reqString(o, 'datasetId'),
        reqStringArray(o, 'columns'),
      );
    case 'v4_count':
      return engine.count(reqString(o, 'datasetId'));
    case 'v4_join':
      return engine.join(
        reqString(o, 'leftDatasetId'),
        reqString(o, 'rightDatasetId'),
        { left: reqString(o, 'leftKey'), right: reqString(o, 'rightKey') },
      );
    default:
      throw new VerbError(`unknown verb tool "${toolName}"`);
  }
}

/** Parse an LLM `v4_render_answer` call into a validated `RenderDirective`. */
export function parseRenderDirective(input: unknown): RenderDirective {
  const o = asObject(input, 'render directive');
  const format = o.format;
  if (format !== 'table' && format !== 'list' && format !== 'scalar') {
    throw new VerbError('render "format" must be table/list/scalar');
  }
  const prose = o.prose;
  if (prose !== undefined && typeof prose !== 'string') {
    throw new VerbError('render "prose" must be a string');
  }
  const directive: RenderDirective = {
    datasetId: reqString(o, 'datasetId'),
    columns: reqStringArray(o, 'columns'),
    format: format as RenderFormat,
    ...(typeof prose === 'string' ? { prose } : {}),
  };
  return directive;
}
