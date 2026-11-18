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

/**
 * Rows a chat render shows before it stops and says how many it left out.
 *
 * A 953-row Markdown table is not an answer anyone reads in a chat window,
 * and every channel has a ceiling it hits first: Teams clips at 25k chars and
 * then rejects the torn table as "Broken Markdown" (the whole turn fails after
 * the data work already succeeded), Telegram stops at 4096 chars. The cap
 * lives HERE, not in each channel, so the truncation is honest — a footer with
 * the exact count — instead of a byte-limit cut through a row. The full result
 * stays available through `create_xlsx` on the same `datasetId`.
 */
export const MAX_CHAT_ROWS = 50;

export interface MaterializeOptions {
  /** Row cap for the rendered text (and the structured table). Defaults to
   *  {@link MAX_CHAT_ROWS}; must be a positive integer. */
  readonly maxRows?: number;
  /** #1559 — a spreadsheet export tool is offered this turn. Only then does
   *  a truncated render's footer offer the full list as a file. */
  readonly fileExportAvailable?: boolean;
}

/** Result of materialization — the channel-bound answer body. */
export interface MaterializeResult {
  readonly text: string;
  /** Rows in the dataset — the number the answer is ABOUT, not the number
   *  shown. */
  readonly rowCount: number;
  /** Rows actually rendered into `text` (≤ `rowCount`). When smaller, `text`
   *  ends with a note naming how many were left out. */
  readonly renderedRowCount: number;
  /**
   * Distinct real values rendered into `text` from `sensitive-masked`
   * columns — the values the LLM never saw (it only ever saw `[masked]` in
   * the Digest). Channels MAY highlight their occurrences so the user sees
   * which data the server resolved behind the data-plane boundary. Empty
   * when the rendered columns were all `safe-cleartext`.
   */
  readonly maskedValues: readonly string[];
  /**
   * #1542 — labels of rendered columns in which at least one shown cell
   * could not be rendered (it shows {@link UNRENDERABLE_CELL} or a record
   * count). Labels only, never a value: the render ack names them so the
   * model can tell the user the content is withheld.
   */
  readonly unrenderedColumns: readonly string[];
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

/** Format the value of `field` for display. Odoo sends `false` for an empty
 *  non-boolean field (an unset many2one, char or date); outside a real
 *  boolean column that is "no value" and renders like `null`, not as the
 *  word "false" highlighted as a protected value (#1503).
 *
 *  Display only. The classifier still counts that `false` as a value, so a
 *  string or date column holding one stays mixed-type and masked: dropping
 *  it there let a sparse column (three e-mails among many `false`s) pass the
 *  low-cardinality enum rule into cleartext. A column that is `false` in
 *  every row types `boolean` and keeps rendering "false" — without field
 *  metadata it cannot be told from a real boolean. */
function fieldCell(value: unknown, field: FieldClassification): string {
  if (value === false && field.type !== 'boolean') return cell(null);
  return cell(value);
}

/**
 * #1542 — what a cell shows when its value cannot be rendered readably (a
 * deep or large structure with no text or display field). German, like every
 * other line the user reads from this renderer. Explicit on purpose: the old
 * `[nested]` read like data and nobody learned the content was not shown.
 * The column is reported in {@link MaterializeResult.unrenderedColumns} so the
 * model is told, too.
 */
export const UNRENDERABLE_CELL = '[Inhalt hier nicht darstellbar]';

/** A nested value with no readable rendering, inside its parent's. */
const ELIDED_CELL = '…';

/** Longest text a single cell shows before it is cut with an ellipsis. */
export const MAX_TEXT_CELL_CHARS = 1500;

/** A string leaf at least this long, and dominating its object, is the
 *  object's content (a page body) — rendered as text. */
const LONG_TEXT_MIN_CHARS = 120;
/** Share of an object's string characters the longest leaf must hold. */
const DOMINANT_TEXT_SHARE = 0.8;
/** Bound on the walk that looks for text leaves in a nested object. */
const MAX_TEXT_LEAF_DEPTH = 4;
const MAX_TEXT_LEAVES = 50;
/** Input bound for the HTML → text pass (its regexes are linear). */
const MAX_HTML_INPUT_CHARS = 50_000;
/** `key: value` rendering of a small object stops being readable here. */
const MAX_PAIRS_CHARS = 300;
const MAX_PAIRS = 20;

/** Display fields, most specific first. `key` + `name` render together. */
const DISPLAY_KEYS = ['displayName', 'display_name', 'name', 'title', 'number', 'value', 'key'] as const;

/** API bookkeeping (`_expandable`, `_links`, `_meta`): never content. */
function isNoiseKey(key: string): boolean {
  return key.startsWith('_');
}

function contentEntries(obj: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(obj).filter(([k]) => !isNoiseKey(k));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HTML_TAG_RE = /<\/?[a-z][a-z0-9]*\b[^<>]*>/i;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  euro: '€',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, ent: string) => {
    if (ent.startsWith('#')) {
      const code =
        ent[1] === 'x' || ent[1] === 'X'
          ? Number.parseInt(ent.slice(2), 16)
          : Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return Object.hasOwn(NAMED_ENTITIES, ent) ? (NAMED_ENTITIES[ent] ?? whole) : whole;
  });
}

/** Plain text of an HTML fragment (a Confluence `body.view.value`): tags
 *  stripped, block ends kept as line breaks, basic entities decoded. */
export function htmlToPlainText(html: string): string {
  const text = html
    .slice(0, MAX_HTML_INPUT_CHARS)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|blockquote|pre|section)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^<>]*>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, i, all) => line.length > 0 || (i > 0 && (all[i - 1] ?? '').length > 0))
    .join('\n')
    .trim();
}

function capText(text: string): string {
  return text.length > MAX_TEXT_CELL_CHARS
    ? `${text.slice(0, MAX_TEXT_CELL_CHARS).trimEnd()} …`
    : text;
}

/** Text a string leaf shows: HTML becomes plain text, everything is capped. */
function textCell(text: string): string {
  return capText(HTML_TAG_RE.test(text) ? htmlToPlainText(text) : text);
}

function collectTextLeaves(value: unknown, depth: number, out: string[]): void {
  if (out.length >= MAX_TEXT_LEAVES || depth > MAX_TEXT_LEAF_DEPTH) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (isPlainObject(value)) {
    for (const [, v] of contentEntries(value)) collectTextLeaves(v, depth + 1, out);
  }
}

/** The object's text content, when it is essentially one text leaf: the only
 *  HTML leaf, or a long leaf holding most of its characters (#1542). */
function dominantText(obj: Record<string, unknown>): string | undefined {
  const leaves: string[] = [];
  collectTextLeaves(obj, 0, leaves);
  if (leaves.length === 0) return undefined;
  const html = leaves.filter((l) => HTML_TAG_RE.test(l));
  if (html.length === 1 && html[0] !== undefined) return html[0];
  const longest = leaves.reduce((a, b) => (b.length > a.length ? b : a));
  const total = leaves.reduce((sum, l) => sum + l.length, 0);
  return longest.length >= LONG_TEXT_MIN_CHARS && longest.length >= DOMINANT_TEXT_SHARE * total
    ? longest
    : undefined;
}

function isDisplayScalar(v: unknown): v is string | number {
  return (typeof v === 'string' && v.trim().length > 0) || typeof v === 'number';
}

/** The label an object announces itself by (`version` → its `number`,
 *  `space` → `key – name`), when it has one. */
function displayLabel(obj: Record<string, unknown>): string | undefined {
  const key = obj['key'];
  const name = obj['name'];
  if (isDisplayScalar(key) && isDisplayScalar(name) && String(key) !== String(name)) {
    return `${String(key)} – ${String(name)}`;
  }
  for (const k of DISPLAY_KEYS) {
    const v = obj[k];
    if (isDisplayScalar(v)) return typeof v === 'string' ? textCell(v) : String(v);
  }
  return undefined;
}

/** A readable rendering of an object, or `undefined` when there is none. */
function renderObject(obj: Record<string, unknown>, depth: number): string | undefined {
  const entries = contentEntries(obj);
  if (entries.length === 0) return undefined;
  const text = dominantText(obj);
  if (text !== undefined) return textCell(text);
  const label = displayLabel(obj);
  if (label !== undefined) return label;
  // A shallow plain object with scalar-ish leaves is the common "totals" /
  // "stats" shape (e.g. Strava's `all_ride_totals: {count, distance, …}`).
  // Render it as readable `key: value` pairs for the AUTHORISED user — the raw
  // values were already masked from the LLM; the materialiser exists
  // precisely to show the real data here. Bounded by depth, field count and
  // length so a large/deep structure degrades to an explicit marker rather
  // than the unreadable JSON blob the old code guarded against.
  if (depth >= 2 || entries.length > MAX_PAIRS) return undefined;
  const pairs = entries.map(([k, v]) => [k, cell(v, depth + 1)] as const);
  // A pair list with an elided part would hide content silently — then the
  // whole value counts as not renderable, and says so.
  if (pairs.some(([, v]) => v === ELIDED_CELL)) return undefined;
  const rendered = pairs.map(([k, v]) => `${k}: ${v}`).join('; ');
  return rendered.length <= MAX_PAIRS_CHARS ? rendered : undefined;
}

/** Format a single cell value for display. `depth` bounds recursion into
 *  nested objects; a top-level value with no readable rendering becomes
 *  {@link UNRENDERABLE_CELL}, a nested one an ellipsis inside its parent. */
function cell(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return depth === 0 ? value : textCell(value);
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
  if (Array.isArray(value)) {
    // Records that each announce a label (`[{name:"a"},{name:"b"}]`) read as
    // a list; anything else stays a structure-only count, never raw JSON.
    const labels = value.map((e) => (isPlainObject(e) ? displayLabel(e) : undefined));
    if (labels.length > 0 && labels.every((l) => l !== undefined)) {
      const joined = labels.join(', ');
      if (joined.length <= MAX_PAIRS_CHARS) return joined;
    }
    return `[${String(value.length)} records]`;
  }
  if (isPlainObject(value)) {
    const rendered = renderObject(value, depth);
    if (rendered !== undefined) return rendered;
  }
  return depth === 0 ? UNRENDERABLE_CELL : ELIDED_CELL;
}

/** A top-level cell that shows a marker instead of the value's content. */
function isUnrenderedCell(text: string): boolean {
  return text === UNRENDERABLE_CELL || /^\[\d+ records\]$/.test(text);
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
  rows: ReadonlyArray<Dataset['rows'][number]>,
  columns: ReadonlyArray<ResolvedRenderColumn>,
  rankColumn: string | undefined,
): string {
  const headers = columns.map((c) => c.render.label);
  const cells = rankColumn !== undefined ? [rankColumn, ...headers] : headers;
  const header = `| ${cells.join(' | ')} |`;
  const separator = `| ${cells.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((row, i) => {
      const rowCells = columns.map((c) =>
        escapeCell(fieldCell(row[c.render.field], c.field)),
      );
      const all =
        rankColumn !== undefined ? [String(i + 1), ...rowCells] : rowCells;
      return `| ${all.join(' | ')} |`;
    })
    .join('\n');
  return `${header}\n${separator}\n${body}`;
}

function renderList(
  rows: ReadonlyArray<Dataset['rows'][number]>,
  columns: ReadonlyArray<ResolvedRenderColumn>,
): string {
  return rows
    .map(
      (row) =>
        `- ${columns
          .map((c) => `${c.render.label}: ${fieldCell(row[c.render.field], c.field)}`)
          .join(', ')}`,
    )
    .join('\n');
}

/** The honest footer under a capped render. German, like every other line
 *  the user reads from this assistant; the numbers are the point. The file
 *  offer only when an export tool can actually build the file (#1559). */
function truncationNote(total: number, shown: number, fileExportAvailable: boolean): string {
  const omitted = total - shown;
  const counted =
    `_… ${String(omitted)} weitere Zeile${omitted === 1 ? '' : 'n'} nicht angezeigt ` +
    `(${String(shown)} von ${String(total)}).`;
  return fileExportAvailable
    ? `${counted} Die vollständige Liste gibt es als Excel-Datei — einfach danach fragen._`
    : `${counted}_`;
}

/** #1542 — the user-facing note under a render with unrenderable cells: the
 *  content is not lost silently, and the user learns how to get it. */
function unrenderedNote(labels: readonly string[]): string {
  const named = labels.map((l) => `„${l}"`).join(', ');
  const which = labels.length === 1 ? `der Spalte ${named}` : `der Spalten ${named}`;
  return (
    `_Hinweis: Der Inhalt ${which} lässt sich in dieser geschützten Ansicht nicht ` +
    `darstellen. Ein Administrator kann den Datenschutz-Modus des Agenten auf ` +
    `„Bypass" stellen, dann wird er angezeigt._`
  );
}

/** Labels of the rendered columns with at least one unrendered shown cell. */
function collectUnrenderedColumns(
  rows: ReadonlyArray<Dataset['rows'][number]>,
  renderedColumns: ReadonlyArray<ResolvedRenderColumn>,
): string[] {
  return renderedColumns
    .filter((c) => rows.some((row) => isUnrenderedCell(fieldCell(row[c.render.field], c.field))))
    .map((c) => c.render.label);
}

function resolveMaxRows(opts: MaterializeOptions | undefined): number {
  const n = opts?.maxRows ?? MAX_CHAT_ROWS;
  if (!Number.isInteger(n) || n < 1) {
    throw new MaterializerError(`maxRows must be a positive integer, got ${String(n)}`);
  }
  return n;
}

function renderScalar(
  dataset: Dataset,
  columns: ReadonlyArray<ResolvedRenderColumn>,
): string {
  const first = dataset.rows[0];
  const col = columns[0];
  if (first === undefined || col === undefined) return '(no result)';
  return fieldCell(first[col.render.field], col.field);
}

/**
 * Collect the distinct real values rendered from `sensitive-masked` columns.
 * `renderedColumns` is the subset of the directive's columns that actually
 * appear in the output (all of them for table/list; just the first for
 * scalar). The `—` null placeholder is never reported.
 */
function collectMaskedValues(
  rows: ReadonlyArray<Dataset['rows'][number]>,
  renderedColumns: ReadonlyArray<ResolvedRenderColumn>,
): string[] {
  const maskedColumns = renderedColumns.filter(
    (c) => c.field.classification === 'sensitive-masked',
  );
  if (maskedColumns.length === 0) return [];
  const values = new Set<string>();
  for (const row of rows) {
    for (const c of maskedColumns) {
      const v = fieldCell(row[c.render.field], c.field);
      if (v.length > 0 && v !== '—') values.add(v);
    }
  }
  return [...values];
}

function buildStructuredTable(
  rows: ReadonlyArray<Dataset['rows'][number]>,
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

  const structuredRows = rows.map((row, index): StructuredRow => {
    const cells: Record<string, unknown> = {};
    if (rankColumn !== undefined) {
      cells.__rank = String(index + 1);
    }
    for (const column of columns) {
      cells[column.render.field] = fieldCell(
        row[column.render.field],
        column.field,
      );
    }
    return {
      rowKey: `r${index}`,
      cells,
    };
  });

  return {
    columns: structuredColumns,
    rows: structuredRows,
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
  opts?: MaterializeOptions,
): MaterializeResult {
  const maxRows = resolveMaxRows(opts);
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
      renderedRowCount: 0,
      maskedValues: [],
      unrenderedColumns: [],
    };
  }

  const resolvedColumns = resolveRenderColumns(dataset, directive.columns);
  const total = dataset.rows.length;
  // A scalar is one value by definition; tables and lists are capped so the
  // channel gets a readable answer plus an honest count, never a torn table.
  const shown = directive.format === 'scalar' ? total : Math.min(total, maxRows);
  const rows = dataset.rows.slice(0, shown);

  let body: string;
  let renderedColumns: ReadonlyArray<ResolvedRenderColumn>;
  let structuredTable: StructuredTable | undefined;
  switch (directive.format) {
    case 'table':
      body = renderTable(rows, resolvedColumns, directive.rankColumn);
      renderedColumns = resolvedColumns;
      structuredTable = buildStructuredTable(
        rows,
        resolvedColumns,
        directive.rankColumn,
      );
      break;
    case 'list':
      body = renderList(rows, resolvedColumns);
      renderedColumns = resolvedColumns;
      // `list` is intentionally prose-only: it is not a tabular UI primitive.
      break;
    case 'scalar':
      body = renderScalar(dataset, resolvedColumns);
      // Only the first column ever reaches the rendered scalar.
      renderedColumns = resolvedColumns.slice(0, 1);
      // `scalar` is intentionally prose-only: it is not a tabular UI primitive.
      break;
    default:
      throw new MaterializerError(
        `render directive has an unsupported format "${String(directive.format)}"`,
      );
  }
  if (shown < total) {
    body = `${body}\n\n${truncationNote(total, shown, opts?.fileExportAvailable === true)}`;
  }
  const unrenderedColumns = collectUnrenderedColumns(
    directive.format === 'scalar' ? rows.slice(0, 1) : rows,
    renderedColumns,
  );
  if (unrenderedColumns.length > 0) body = `${body}\n\n${unrenderedNote(unrenderedColumns)}`;

  return {
    text: withProse(directive.prose, body),
    rowCount: total,
    renderedRowCount: shown,
    // Only what was rendered: a value the footer left out never reached the
    // channel, so it must not be flagged as "resolved behind the boundary".
    maskedValues: collectMaskedValues(rows, renderedColumns),
    unrenderedColumns,
    ...(structuredTable !== undefined ? { structuredTable } : {}),
  };
}
