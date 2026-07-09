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
  FieldClassification,
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
  /** Present only for tabular renders with at least one row. */
  readonly structuredTable?: StructuredTable;
}

export interface StructuredColumn {
  readonly fieldKey: string;
  readonly label: string;
  readonly type?: string;
  readonly privacy?: 'guard-protected';
}

export interface StructuredRow {
  readonly rowKey: string;
  readonly cells: Record<string, unknown>;
}

export interface StructuredTable {
  readonly columns: readonly StructuredColumn[];
  readonly rows: readonly StructuredRow[];
}

interface ResolvedRenderColumn {
  readonly render: RenderColumn;
  readonly field: FieldClassification;
}

/** Format a single cell value for display. `depth` bounds recursion into nested
 *  objects so a genuinely deep structure degrades to a marker, not a blob. */
function cell(value: unknown, depth = 0): string {
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
  // A remaining array of scalars is safe to join (e.g. tags/codes).
  if (
    Array.isArray(value) &&
    value.every(
      (e) =>
        e === null ||
        typeof e === 'string' ||
        typeof e === 'number' ||
        typeof e === 'boolean',
    )
  ) {
    return value.map((e) => cell(e, depth + 1)).join(', ');
  }
  // A shallow plain object with scalar-ish leaves is the common "totals" /
  // "stats" shape (e.g. Strava's `all_ride_totals: {count, distance, …}`).
  // Render it as readable `key: value` pairs for the AUTHORISED user instead of
  // an opaque `[nested]` — the raw values were already masked from the LLM; the
  // materialiser exists precisely to show the real data here. Bounded by depth,
  // field count and length so a large/deep structure still degrades to a compact
  // marker rather than the unreadable JSON blob the old code guarded against.
  if (
    !Array.isArray(value) &&
    typeof value === 'object' &&
    depth < 2
  ) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 0 && entries.length <= 20) {
      const rendered = entries
        .map(([k, v]) => `${k}: ${cell(v, depth + 1)}`)
        .join('; ');
      if (rendered.length <= 300) return rendered;
    }
  }
  if (Array.isArray(value)) return `[${String(value.length)} records]`;
  return '[nested]';
}

/** Escape a value for a Markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function withProse(prose: string | undefined, body: string): string {
  return prose !== undefined && prose.length > 0 ? `${prose}\n\n${body}` : body;
}

function resolveRenderColumns(
  dataset: Dataset,
  columns: ReadonlyArray<RenderColumn>,
): ResolvedRenderColumn[] {
  const known = new Map(
    dataset.schema.fields.map((field) => [field.path, field] as const),
  );
  return columns.map((render): ResolvedRenderColumn => {
    const field = known.get(render.field);
    if (field === undefined) {
      throw new MaterializerError(
        `render directive references unknown column "${render.field}"`,
      );
    }
    return { render, field };
  });
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

function buildStructuredTable(
  dataset: Dataset,
  columns: ReadonlyArray<ResolvedRenderColumn>,
  rankColumn: string | undefined,
): StructuredTable {
  const structuredColumns: StructuredColumn[] =
    rankColumn !== undefined
      ? [
          // Mirror the Markdown ranking column so the canvas table matches the
          // spoken/final answer byte-for-byte in column order and meaning.
          { fieldKey: '__rank', label: rankColumn, type: 'number' },
        ]
      : [];
  for (const column of columns) {
    structuredColumns.push({
      fieldKey: column.render.field,
      label: column.render.label,
      ...(column.field.type !== 'unknown' ? { type: column.field.type } : {}),
      ...(column.field.classification === 'sensitive-masked'
        ? { privacy: 'guard-protected' as const }
        : {}),
    });
  }

  const rows = dataset.rows.map((row, index): StructuredRow => {
    const cells: Record<string, unknown> = {};
    if (rankColumn !== undefined) {
      cells.__rank = String(index + 1);
    }
    for (const column of columns) {
      cells[column.render.field] = cell(row[column.render.field]);
    }
    return {
      rowKey: `r${index}`,
      cells,
    };
  });

  return {
    columns: structuredColumns,
    rows,
  };
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
    // Intentionally no structured table for an empty render: the existing
    // user-visible contract is the Markdown `(no rows)` body, and verb-derived
    // empty datasets may no longer retain enough schema to validate columns
    // without inventing a second resolution path.
    return {
      text: withProse(directive.prose, '(no rows)'),
      rowCount: 0,
      maskedValues: [],
    };
  }

  const resolvedColumns = resolveRenderColumns(dataset, directive.columns);
  const renderColumns = resolvedColumns.map((column) => column.render);

  let body: string;
  let renderedColumns: ReadonlyArray<RenderColumn>;
  let structuredTable: StructuredTable | undefined;
  switch (directive.format) {
    case 'table':
      body = renderTable(dataset, renderColumns, directive.rankColumn);
      renderedColumns = renderColumns;
      structuredTable = buildStructuredTable(
        dataset,
        resolvedColumns,
        directive.rankColumn,
      );
      break;
    case 'list':
      body = renderList(dataset, renderColumns);
      renderedColumns = renderColumns;
      // `list` is intentionally prose-only: it is not a tabular UI primitive.
      break;
    case 'scalar':
      body = renderScalar(dataset, renderColumns);
      // Only the first column ever reaches the rendered scalar.
      renderedColumns = renderColumns.slice(0, 1);
      // `scalar` is intentionally prose-only: it is not a tabular UI primitive.
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
    ...(structuredTable !== undefined ? { structuredTable } : {}),
  };
}
