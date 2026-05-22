/**
 * Privacy Shield v4 — Materializer (US6).
 *
 * Renders the final answer server-side from the real dataset a verb chain
 * produced. The LLM emits PII-free prose + a `RenderDirective`
 * `{ datasetId, columns, format }`; the Materializer resolves the dataset and
 * renders the REAL values — including `sensitive-masked` columns — into the
 * channel-bound output for the authenticated internal user (FR-016/FR-017).
 * Real identity values never pass back through the LLM.
 *
 * It also returns `maskedValues`: the distinct real values it rendered from
 * `sensitive-masked` columns — i.e. exactly the values that never reached the
 * LLM. Channels surface these (e.g. a violet highlight) so the asker can see
 * at a glance which data the server filled in behind the boundary.
 *
 * Design note: the spec suggested generalizing `routineTemplateRenderer`.
 * That renderer is coupled to the routine-template section model (narrative
 * slots, adaptive cards, mustache interpolation); driving an ad-hoc directive
 * through it is heavier than a focused renderer. A standalone materializer is
 * the simpler choice (Constitution: reject unjustified complexity) and leaves
 * the routine path untouched.
 *
 * Contract: specs/001-privacy-shield-v4/contracts/verb-api.md §4
 */

import type {
  Dataset,
  DatasetStore,
  RenderColumn,
  RenderDirective,
} from './types.js';

/** Raised when a render directive cannot be honoured. */
export class MaterializerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializerError';
  }
}

/** Result of materialization — the channel-bound answer body. */
export interface MaterializeResult {
  readonly text: string;
  readonly rowCount: number;
  /**
   * Distinct real values rendered into `text` from `sensitive-masked`
   * columns — the values the LLM never saw (it only ever saw `[masked]` in
   * the Digest). Channels MAY highlight their occurrences so the user sees
   * which data the server resolved behind the data-plane boundary. Empty
   * when the rendered columns were all `safe-cleartext`.
   */
  readonly maskedValues: readonly string[];
}

/** Format a single cell value for display. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Odoo many2one fields arrive as a [id, "Display Name"] pair — render the
  // display label, not the raw `[198,"…"]` tuple. Restricted to exactly
  // [number, string] so genuine two-element data arrays are left untouched.
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'string'
  ) {
    return value[1];
  }
  return JSON.stringify(value);
}

/** Escape a value for a Markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function withProse(prose: string | undefined, body: string): string {
  return prose !== undefined && prose.length > 0 ? `${prose}\n\n${body}` : body;
}

function renderTable(
  dataset: Dataset,
  columns: ReadonlyArray<RenderColumn>,
  rankColumn: string | undefined,
): string {
  const headers = columns.map((c) => c.label);
  const cells = rankColumn !== undefined ? [rankColumn, ...headers] : headers;
  const header = `| ${cells.join(' | ')} |`;
  const separator = `| ${cells.map(() => '---').join(' | ')} |`;
  const body = dataset.rows
    .map((row, i) => {
      const rowCells = columns.map((c) => escapeCell(cell(row[c.field])));
      const all =
        rankColumn !== undefined ? [String(i + 1), ...rowCells] : rowCells;
      return `| ${all.join(' | ')} |`;
    })
    .join('\n');
  return `${header}\n${separator}\n${body}`;
}

function renderList(
  dataset: Dataset,
  columns: ReadonlyArray<RenderColumn>,
): string {
  return dataset.rows
    .map(
      (row) =>
        `- ${columns.map((c) => `${c.label}: ${cell(row[c.field])}`).join(', ')}`,
    )
    .join('\n');
}

function renderScalar(
  dataset: Dataset,
  columns: ReadonlyArray<RenderColumn>,
): string {
  const first = dataset.rows[0];
  const col = columns[0];
  if (first === undefined || col === undefined) return '(no result)';
  return cell(first[col.field]);
}

/**
 * Collect the distinct real values rendered from `sensitive-masked` columns.
 * `renderedColumns` is the subset of the directive's columns that actually
 * appear in the output (all of them for table/list; just the first for
 * scalar). The `—` null placeholder is never reported.
 */
function collectMaskedValues(
  dataset: Dataset,
  renderedColumns: ReadonlyArray<RenderColumn>,
): string[] {
  const maskedPaths = new Set(
    dataset.schema.fields
      .filter((f) => f.classification === 'sensitive-masked')
      .map((f) => f.path),
  );
  const maskedColumns = renderedColumns.filter((c) =>
    maskedPaths.has(c.field),
  );
  if (maskedColumns.length === 0) return [];
  const values = new Set<string>();
  for (const row of dataset.rows) {
    for (const c of maskedColumns) {
      const v = cell(row[c.field]);
      if (v.length > 0 && v !== '—') values.add(v);
    }
  }
  return [...values];
}

/**
 * Render a `RenderDirective` against the turn's Dataset Store. Throws
 * `MaterializerError` for an unknown `datasetId`, an unknown column, or an
 * unsupported format — never renders a guess (FR-019).
 */
export function materialize(
  store: DatasetStore,
  directive: RenderDirective,
): MaterializeResult {
  const dataset = store.get(directive.datasetId);
  if (dataset === undefined) {
    throw new MaterializerError(
      `render directive references unknown datasetId "${directive.datasetId}"`,
    );
  }
  if (directive.columns.length === 0) {
    throw new MaterializerError('render directive specifies no columns');
  }

  if (dataset.rows.length === 0) {
    return {
      text: withProse(directive.prose, '(no rows)'),
      rowCount: 0,
      maskedValues: [],
    };
  }

  const known = new Set(dataset.schema.fields.map((f) => f.path));
  for (const column of directive.columns) {
    if (!known.has(column.field)) {
      throw new MaterializerError(
        `render directive references unknown column "${column.field}"`,
      );
    }
  }

  let body: string;
  let renderedColumns: ReadonlyArray<RenderColumn>;
  switch (directive.format) {
    case 'table':
      body = renderTable(dataset, directive.columns, directive.rankColumn);
      renderedColumns = directive.columns;
      break;
    case 'list':
      body = renderList(dataset, directive.columns);
      renderedColumns = directive.columns;
      break;
    case 'scalar':
      body = renderScalar(dataset, directive.columns);
      // Only the first column ever reaches the rendered scalar.
      renderedColumns = directive.columns.slice(0, 1);
      break;
    default:
      throw new MaterializerError(
        `render directive has an unsupported format "${String(directive.format)}"`,
      );
  }

  return {
    text: withProse(directive.prose, body),
    rowCount: dataset.rows.length,
    maskedValues: collectMaskedValues(dataset, renderedColumns),
  };
}
