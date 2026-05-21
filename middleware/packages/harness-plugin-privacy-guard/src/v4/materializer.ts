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
}

/** Format a single cell value for display. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
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
  columns: ReadonlyArray<string>,
): string {
  const header = `| ${columns.join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = dataset.rows
    .map(
      (row) =>
        `| ${columns.map((c) => escapeCell(cell(row[c]))).join(' | ')} |`,
    )
    .join('\n');
  return `${header}\n${separator}\n${body}`;
}

function renderList(
  dataset: Dataset,
  columns: ReadonlyArray<string>,
): string {
  return dataset.rows
    .map(
      (row) =>
        `- ${columns.map((c) => `${c}: ${cell(row[c])}`).join(', ')}`,
    )
    .join('\n');
}

function renderScalar(
  dataset: Dataset,
  columns: ReadonlyArray<string>,
): string {
  const first = dataset.rows[0];
  const col = columns[0];
  if (first === undefined || col === undefined) return '(no result)';
  return cell(first[col]);
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
    return { text: withProse(directive.prose, '(no rows)'), rowCount: 0 };
  }

  const known = new Set(dataset.schema.fields.map((f) => f.path));
  for (const column of directive.columns) {
    if (!known.has(column)) {
      throw new MaterializerError(
        `render directive references unknown column "${column}"`,
      );
    }
  }

  let body: string;
  switch (directive.format) {
    case 'table':
      body = renderTable(dataset, directive.columns);
      break;
    case 'list':
      body = renderList(dataset, directive.columns);
      break;
    case 'scalar':
      body = renderScalar(dataset, directive.columns);
      break;
    default:
      throw new MaterializerError(
        `render directive has an unsupported format "${String(directive.format)}"`,
      );
  }

  return {
    text: withProse(directive.prose, body),
    rowCount: dataset.rows.length,
  };
}
