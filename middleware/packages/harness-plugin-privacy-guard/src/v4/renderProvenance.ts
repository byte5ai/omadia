/**
 * Privacy Shield v4 — provenance note of a server render (#1543).
 *
 * The model never sees the rows of a table it rendered (#1402), and the rows
 * are turn-scoped: on the next turn they are gone. A follow-up about "the
 * table" can only be answered by running the query again — and the model has
 * to know WHICH query produced the table, or it silently answers from a
 * different scope and order. This note says it: the source tool, the verb
 * chain (field paths, ops, directions, `n`), the row counts and the columns.
 *
 * Model-bound and persisted with the turn, so it carries NO value: no row
 * cell, no filter value (a predicate's literal may be real data the user
 * typed or a surrogate of it), no tool input (a question text, a domain).
 * Only names the model itself wrote or saw in a digest.
 */

import type { DatasetStore, Predicate, RenderDirective } from './types.js';

/** Longest verb chain walked back to its origin — verbs nest shallowly. */
const MAX_CHAIN = 16;

/** Stand-in for every predicate literal. */
const HIDDEN = '…';

function quoted(path: unknown): string {
  return typeof path === 'string' ? `\`${path.replace(/`/g, "'")}\`` : '?';
}

function quotedList(value: unknown): string {
  const items = Array.isArray(value) ? value : [value];
  return items.map(quoted).join(', ');
}

/** A predicate with every literal replaced by {@link HIDDEN}. */
export function describePredicate(p: unknown, depth = 0): string {
  if (depth > 8 || typeof p !== 'object' || p === null) return '?';
  const pred = p as Predicate;
  switch (pred.op) {
    case 'and':
    case 'or':
      return `(${pred.clauses.map((c) => describePredicate(c, depth + 1)).join(` ${pred.op} `)})`;
    case 'not':
      return `not ${describePredicate(pred.clause, depth + 1)}`;
    case 'in':
      return `${quoted(pred.field)} in [${HIDDEN}]`;
    case 'between':
      return `${quoted(pred.field)} between ${HIDDEN} and ${HIDDEN}`;
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return `${quoted(pred.field)} ${pred.op} ${HIDDEN}`;
    default:
      return '?';
  }
}

function direction(value: unknown): string {
  return value === 'asc' || value === 'desc' ? value : '';
}

function describeAggregate(params: unknown): string {
  if (typeof params !== 'object' || params === null) return 'aggregate';
  const { groupBy, ops } = params as { groupBy?: unknown; ops?: unknown };
  const opText = Array.isArray(ops)
    ? ops
        .map((op: unknown) => {
          if (typeof op !== 'object' || op === null) return '?';
          const { fn, field, alias } = op as { fn?: unknown; field?: unknown; alias?: unknown };
          const fnName = typeof fn === 'string' ? fn : '?';
          return `${fnName}(${field === undefined ? '' : quoted(field)}) as ${quoted(alias)}`;
        })
        .join(', ')
    : '';
  const by = Array.isArray(groupBy) && groupBy.length > 0 ? ` by ${quotedList(groupBy)}` : '';
  return `aggregate ${opText}${by}`;
}

/** One verb step, structure only. */
export function describeVerbStep(verb: string, args: Readonly<Record<string, unknown>>): string {
  switch (verb) {
    case 'filter':
      return `filter ${describePredicate(args['predicate'])}`;
    case 'sort':
      return `sort by ${quoted(args['by'])} ${direction(args['direction'])}`.trimEnd();
    case 'top_n': {
      const n = typeof args['n'] === 'number' ? String(args['n']) : '?';
      return `top_n ${n} by ${quoted(args['by'])} ${direction(args['direction'])}`.trimEnd();
    }
    case 'group':
      return `group by ${quotedList(args['by'])}`;
    case 'aggregate':
      return describeAggregate(args['params']);
    case 'select':
      return `select ${quotedList(args['columns'])}`;
    case 'count':
      return 'count';
    case 'join': {
      const on = args['on'] as { left?: unknown; right?: unknown } | undefined;
      return `join with another dataset on ${quoted(on?.left)} = ${quoted(on?.right)}`;
    }
    case 'union':
      return 'union with another dataset';
    case 'distinct': {
      const keep = args['keep'] === 'last' ? 'last' : 'first';
      return `distinct by ${quotedList(args['by'])} keep ${keep}`;
    }
    default:
      return verb.replace(/[^\w-]/g, '');
  }
}

export interface RenderProvenanceFacts {
  readonly rowCount: number;
  readonly renderedRowCount: number;
}

/**
 * The provenance note of a render, or `undefined` when the dataset is gone.
 * Tool and verb names, field paths, ops, directions, counts and the
 * directive's column labels only.
 */
export function describeRenderProvenance(
  store: DatasetStore,
  directive: RenderDirective,
  facts: RenderProvenanceFacts,
): string | undefined {
  let ds = store.get(directive.datasetId);
  if (ds === undefined) return undefined;
  const steps: string[] = [];
  for (let hops = 0; ds.provenance.derivedFrom !== undefined; hops++) {
    if (hops >= MAX_CHAIN) {
      steps.unshift('…');
      break;
    }
    steps.unshift(describeVerbStep(ds.provenance.toolName, ds.provenance.verbArgs ?? {}));
    const parent = store.get(ds.provenance.derivedFrom);
    if (parent === undefined) break;
    ds = parent;
  }
  const source = ds.provenance.derivedFrom === undefined ? ds.provenance.toolName : 'unknown';
  const rows =
    facts.renderedRowCount < facts.rowCount
      ? `${String(facts.rowCount)} rows, the first ${String(facts.renderedRowCount)} shown`
      : `${String(facts.rowCount)} row${facts.rowCount === 1 ? '' : 's'}`;
  const columns = directive.columns
    .map((c) => `${quoted(c.label)} (${quoted(c.field)})`)
    .join(', ');
  return (
    `Table provenance (no values): source tool ${quoted(source)}` +
    `${ds.provenance.truncated ? ' (result truncated at intern)' : ''}; ` +
    `steps: ${steps.length > 0 ? steps.join(' → ') : 'none (rows as the tool returned them)'}; ` +
    `${rows}; format ${directive.format}; columns: ${columns}` +
    `${directive.rankColumn !== undefined ? `; rank column ${quoted(directive.rankColumn)}` : ''}.`
  );
}
