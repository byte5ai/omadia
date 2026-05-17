/**
 * Phase C.4 / C.6 — Routine Template Renderer.
 *
 * Composes the final user-facing output from three inputs:
 *
 *   - `template`: the `RoutineOutputTemplate` validated by
 *     `parseRoutineOutputTemplate` (C.1)
 *   - `rawToolResults`: the `Map<toolName, unknown>` captured during
 *     dispatch (C.2). Values that are strings get parsed as JSON on
 *     demand — tool handlers in this codebase return strings today;
 *     a future structured-result migration would land typed objects
 *     directly and skip the parse.
 *   - `slots`: the `NarrativeSlotResponse.slots` produced by the LLM
 *     and validated against the template by `parseSlotResponse` (C.3)
 *
 * Two output formats are supported:
 *
 *   - `format: 'markdown'` (C.4) — single markdown string. Sections
 *     compose in render order with one blank line between them; empty
 *     sections collapse silently. Suitable for web-ui, plain-text
 *     channels, and as a fallback `text` body when the channel cannot
 *     render rich primitives.
 *
 *   - `format: 'adaptive-card'` (C.6) — array of Adaptive Card 1.5 body
 *     items. Channel adapters (e.g. Teams) embed the items directly
 *     into a card frame. Schema: `TextBlock` for narrative-slot /
 *     static-markdown / titles, `Table` for data-table (with per-group
 *     headers when `groupBy` is set), and a `TextBlock` with markdown
 *     bullets for data-list. The shape is the portable Adaptive Card
 *     JSON, so any channel speaking the spec (Outlook, Cortana
 *     historically) can consume it identically.
 *
 *   - `format: 'html'` is reserved; returns `{ ok: false }` until a real
 *     consumer needs it.
 *
 * Failure mode is graceful: when a `data-table` / `data-list` source
 * is missing, unparseable, or the wrong shape, the section renders
 * its `emptyText` (or a `—` placeholder) instead of throwing. The
 * routine still ships with whatever narrative slots are valid, and
 * the operator sees the receipt diagnostic (deferred to S-7.5).
 */

import type {
  RoutineDataListSection,
  RoutineDataTableSection,
  RoutineOutputTemplate,
  RoutineTemplateColumn,
} from './routineOutputTemplate.js';

export interface RenderRoutineTemplateOptions {
  readonly template: RoutineOutputTemplate;
  readonly rawToolResults: ReadonlyMap<string, unknown>;
  readonly slots: Readonly<Record<string, string>>;
  /**
   * Locale used to format `format: 'date'` / `'currency'` columns.
   * Defaults to `de-DE` to match the existing routine/output language.
   */
  readonly locale?: string;
  /**
   * ISO currency code for `format: 'currency'` columns. Defaults to
   * `EUR`. Operator can override per-routine when a future template
   * carries explicit currency metadata; for v1 we keep it global.
   */
  readonly currency?: string;
}

export type RenderRoutineTemplateResult =
  | { readonly ok: true; readonly format: 'markdown'; readonly text: string }
  | {
      readonly ok: true;
      readonly format: 'adaptive-card';
      readonly items: readonly unknown[];
    }
  | { readonly ok: false; readonly reason: string };

const DEFAULT_EMPTY_TEXT = '—';

export function renderRoutineTemplate(
  options: RenderRoutineTemplateOptions,
): RenderRoutineTemplateResult {
  const { template } = options;
  if (template.format === 'markdown') {
    return { ok: true, format: 'markdown', text: renderMarkdown(options) };
  }
  if (template.format === 'adaptive-card') {
    return {
      ok: true,
      format: 'adaptive-card',
      items: renderAdaptiveCardItems(options),
    };
  }
  return {
    ok: false,
    reason: `format '${template.format}' is not yet supported`,
  };
}

function renderMarkdown(options: RenderRoutineTemplateOptions): string {
  const parts: string[] = [];
  for (const section of options.template.sections) {
    let rendered = '';
    if (section.kind === 'narrative-slot') {
      const text = options.slots[section.id];
      if (typeof text === 'string') {
        rendered = text.trim();
      }
    } else if (section.kind === 'static-markdown') {
      rendered = section.text.trim();
    } else if (section.kind === 'data-table') {
      rendered = renderDataTable(section, options);
    } else if (section.kind === 'data-list') {
      rendered = renderDataList(section, options);
    }
    if (rendered.length > 0) parts.push(rendered);
  }
  return parts.join('\n\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Adaptive Card (Phase C.6)

/**
 * Walk the template and produce Adaptive Card 1.5 body items. Channel
 * adapters (Teams etc.) embed the items directly into a card frame —
 * the renderer does not produce the outer `AdaptiveCard` envelope or
 * any `actions` row; those belong to the channel's card-wrapper.
 *
 * Section mapping:
 *   - `narrative-slot` / `static-markdown` → `TextBlock` with markdown
 *     `wrap: true`. Empty text collapses silently.
 *   - `data-table` → `TextBlock` title (when resolved) + `Table` per
 *     group bucket (or single Table when `groupBy` is unset). Empty
 *     data renders `emptyText` (or `—`) as a TextBlock.
 *   - `data-list` → optional title TextBlock + a single TextBlock
 *     containing markdown bullets (`- item` per row).
 *
 * Adjacent items are not joined; the Adaptive Card host applies its
 * own spacing. Empty sections are skipped.
 */
function renderAdaptiveCardItems(
  options: RenderRoutineTemplateOptions,
): readonly unknown[] {
  const items: unknown[] = [];
  for (const section of options.template.sections) {
    if (section.kind === 'narrative-slot') {
      const text = options.slots[section.id];
      if (typeof text === 'string' && text.trim().length > 0) {
        items.push(textBlock(text.trim()));
      }
      continue;
    }
    if (section.kind === 'static-markdown') {
      const text = section.text.trim();
      if (text.length > 0) items.push(textBlock(text));
      continue;
    }
    if (section.kind === 'data-table') {
      items.push(...adaptiveCardItemsForTable(section, options));
      continue;
    }
    if (section.kind === 'data-list') {
      items.push(...adaptiveCardItemsForList(section, options));
      continue;
    }
  }
  return items;
}

function adaptiveCardItemsForTable(
  section: RoutineDataTableSection,
  options: RenderRoutineTemplateOptions,
): unknown[] {
  const rows = resolveRows(
    section.sourceTool,
    section.sourcePath,
    options.rawToolResults,
  );
  const title = resolveTitle(section.title, section.titleSlot, options.slots);
  const items: unknown[] = [];
  if (title !== undefined) items.push(titleBlock(title));
  if (rows.length === 0) {
    items.push(textBlock(renderEmpty(section.emptyText)));
    return items;
  }
  if (section.groupBy !== undefined) {
    const { order, buckets } = bucketByGroup(rows, section.groupBy);
    for (const key of order) {
      if (key.length > 0) items.push(subHeaderBlock(key));
      items.push(tableElement(section.columns, buckets.get(key)!, options));
    }
    return items;
  }
  items.push(tableElement(section.columns, rows, options));
  return items;
}

function adaptiveCardItemsForList(
  section: RoutineDataListSection,
  options: RenderRoutineTemplateOptions,
): unknown[] {
  const rows = resolveRows(
    section.sourceTool,
    section.sourcePath,
    options.rawToolResults,
  );
  const title = resolveTitle(section.title, section.titleSlot, options.slots);
  const items: unknown[] = [];
  if (title !== undefined) items.push(titleBlock(title));
  if (rows.length === 0) {
    items.push(textBlock(renderEmpty(section.emptyText)));
    return items;
  }
  const bullets = rows
    .map((row) => `- ${interpolateMustache(section.itemTemplate, row)}`)
    .join('\n');
  items.push(textBlock(bullets));
  return items;
}

function tableElement(
  columns: readonly RoutineTemplateColumn[],
  rows: ReadonlyArray<Record<string, unknown>>,
  options: RenderRoutineTemplateOptions,
): unknown {
  const cardColumns = columns.map(() => ({ width: 1 }));
  const headerRow = {
    type: 'TableRow',
    cells: columns.map((c) => ({
      type: 'TableCell',
      items: [
        {
          type: 'TextBlock',
          text: c.label,
          weight: 'Bolder',
          wrap: true,
        },
      ],
    })),
  };
  const bodyRows = rows.map((row) => ({
    type: 'TableRow',
    cells: columns.map((c) => ({
      type: 'TableCell',
      items: [
        {
          type: 'TextBlock',
          text: formatCellValue(row[c.field], c.format, options),
          wrap: true,
        },
      ],
    })),
  }));
  return {
    type: 'Table',
    columns: cardColumns,
    firstRowAsHeader: true,
    rows: [headerRow, ...bodyRows],
  };
}

function textBlock(text: string): unknown {
  return {
    type: 'TextBlock',
    text,
    wrap: true,
  };
}

function titleBlock(text: string): unknown {
  return {
    type: 'TextBlock',
    text,
    weight: 'Bolder',
    size: 'Medium',
    wrap: true,
  };
}

function subHeaderBlock(text: string): unknown {
  return {
    type: 'TextBlock',
    text,
    weight: 'Bolder',
    size: 'Small',
    wrap: true,
    spacing: 'Medium',
  };
}

function bucketByGroup(
  rows: ReadonlyArray<Record<string, unknown>>,
  groupKey: string,
): {
  order: readonly string[];
  buckets: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>;
} {
  const order: string[] = [];
  const buckets = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const raw = row[groupKey];
    const key = raw === undefined || raw === null ? '' : String(raw);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(row);
  }
  return { order, buckets };
}

// ──────────────────────────────────────────────────────────────────────────
// Data-table

function renderDataTable(
  section: RoutineDataTableSection,
  options: RenderRoutineTemplateOptions,
): string {
  const rows = resolveRows(section.sourceTool, section.sourcePath, options.rawToolResults);
  const title = resolveTitle(section.title, section.titleSlot, options.slots);
  if (rows.length === 0) {
    return composeTitled(title, renderEmpty(section.emptyText));
  }
  if (section.groupBy !== undefined) {
    return renderGroupedTable(section, rows, title, options);
  }
  return composeTitled(title, renderMarkdownTable(section.columns, rows, options));
}

function renderGroupedTable(
  section: RoutineDataTableSection,
  rows: ReadonlyArray<Record<string, unknown>>,
  title: string | undefined,
  options: RenderRoutineTemplateOptions,
): string {
  const groupKey = section.groupBy!;
  // Preserve insertion order of distinct group values (first-seen wins).
  const order: string[] = [];
  const buckets = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const raw = row[groupKey];
    const key = raw === undefined || raw === null ? '' : String(raw);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(row);
  }
  const blocks: string[] = [];
  for (const key of order) {
    const bucketRows = buckets.get(key)!;
    const groupHeader = key.length > 0 ? `### ${escapeMarkdown(key)}` : '';
    const tableMd = renderMarkdownTable(section.columns, bucketRows, options);
    blocks.push([groupHeader, tableMd].filter((s) => s.length > 0).join('\n\n'));
  }
  const body = blocks.join('\n\n');
  return composeTitled(title, body);
}

function renderMarkdownTable(
  columns: readonly RoutineTemplateColumn[],
  rows: ReadonlyArray<Record<string, unknown>>,
  options: RenderRoutineTemplateOptions,
): string {
  const header = `| ${columns.map((c) => escapeCell(c.label)).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => {
    const cells = columns.map((c) =>
      escapeCell(formatCellValue(row[c.field], c.format, options)),
    );
    return `| ${cells.join(' | ')} |`;
  });
  return [header, sep, ...body].join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Data-list

function renderDataList(
  section: RoutineDataListSection,
  options: RenderRoutineTemplateOptions,
): string {
  const rows = resolveRows(section.sourceTool, section.sourcePath, options.rawToolResults);
  const title = resolveTitle(section.title, section.titleSlot, options.slots);
  if (rows.length === 0) {
    return composeTitled(title, renderEmpty(section.emptyText));
  }
  const items = rows.map(
    (row) => `- ${interpolateMustache(section.itemTemplate, row)}`,
  );
  return composeTitled(title, items.join('\n'));
}

// ──────────────────────────────────────────────────────────────────────────
// Row resolution

function resolveRows(
  sourceTool: string,
  sourcePath: string | undefined,
  rawToolResults: ReadonlyMap<string, unknown>,
): ReadonlyArray<Record<string, unknown>> {
  const captured = rawToolResults.get(sourceTool);
  if (captured === undefined) return [];
  const parsed = coerceCapturedValue(captured);
  if (parsed === undefined) return [];
  const rooted =
    sourcePath !== undefined
      ? readSourcePath(parsed, sourcePath)
      : parsed;
  if (!Array.isArray(rooted)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const r of rooted) {
    if (r !== null && typeof r === 'object' && !Array.isArray(r)) {
      rows.push(r as Record<string, unknown>);
    }
  }
  return rows;
}

/**
 * Tool handlers in this codebase return strings (see C.2 capture
 * point — `dispatchToolInner` returns a string). Most domain tools
 * encode their result as JSON; some embed JSON in a markdown wrapper
 * (header + ``` fences). We try `JSON.parse` first; if that fails
 * we attempt to extract the first balanced `{…}` / `[…]` block from
 * the payload. Non-string captures (future structured handlers) pass
 * through verbatim.
 */
function coerceCapturedValue(captured: unknown): unknown {
  if (typeof captured !== 'string') return captured;
  const trimmed = captured.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractFirstJsonBlock(trimmed);
    if (extracted === null) return undefined;
    try {
      return JSON.parse(extracted);
    } catch {
      return undefined;
    }
  }
}

function extractFirstJsonBlock(raw: string): string | null {
  const candidates: Array<{ open: string; close: string }> = [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
  ];
  for (const { open, close } of candidates) {
    const start = raw.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i]!;
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function readSourcePath(root: unknown, path: string): unknown {
  if (root === null || typeof root !== 'object') return undefined;
  if (path.length === 0) return root;
  // v1: single-level path lookup. Nested dot-paths (`data.absences`)
  // are intentionally out of scope — operators flatten their tool
  // results or use a wrapper tool. Revisit when a real template
  // needs nesting; complexity not free.
  return (root as Record<string, unknown>)[path];
}

// ──────────────────────────────────────────────────────────────────────────
// Cell formatting + escaping

function formatCellValue(
  value: unknown,
  format: RoutineTemplateColumn['format'],
  options: RenderRoutineTemplateOptions,
): string {
  if (value === null || value === undefined) return '';
  if (format === 'date') return formatDate(value, options.locale);
  if (format === 'currency') return formatCurrency(value, options.locale, options.currency);
  // 'plain' or undefined → stringify primitives, JSON-stringify objects.
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function formatDate(value: unknown, locale: string | undefined): string {
  const d =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  if (d === null || Number.isNaN(d.getTime())) {
    return typeof value === 'string' ? value : '';
  }
  // Default to YYYY-MM-DD when no locale supplied — locale-neutral
  // and grep-friendly in logs / receipts.
  return new Intl.DateTimeFormat(locale ?? 'de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function formatCurrency(
  value: unknown,
  locale: string | undefined,
  currency: string | undefined,
): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return typeof value === 'string' ? value : '';
  return new Intl.NumberFormat(locale ?? 'de-DE', {
    style: 'currency',
    currency: currency ?? 'EUR',
  }).format(n);
}

/**
 * Escape pipe + newline characters that would break markdown table
 * cells. Backslash-escape for `|`, replace newline with space — keeps
 * the table valid even if the source data carries inline returns.
 */
function escapeCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Escape only what would break a non-table markdown context — used
 *  for group headers, narrative passthrough is verbatim. */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*])/g, '\\$1');
}

// ──────────────────────────────────────────────────────────────────────────
// Mustache interpolation (data-list itemTemplate)

const MUSTACHE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

function interpolateMustache(template: string, row: Record<string, unknown>): string {
  return template.replace(MUSTACHE_RE, (_match, key: string) => {
    const v = row[key];
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Title + empty helpers

function resolveTitle(
  literal: string | undefined,
  slotId: string | undefined,
  slots: Readonly<Record<string, string>>,
): string | undefined {
  if (slotId !== undefined) {
    const v = slots[slotId];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    return undefined;
  }
  if (literal !== undefined && literal.trim().length > 0) return literal.trim();
  return undefined;
}

function composeTitled(title: string | undefined, body: string): string {
  const trimmedBody = body.trim();
  if (title === undefined) return trimmedBody;
  if (trimmedBody.length === 0) return `## ${title}`;
  return `## ${title}\n\n${trimmedBody}`;
}

function renderEmpty(emptyText: string | undefined): string {
  if (emptyText === undefined) return DEFAULT_EMPTY_TEXT;
  return emptyText.trim();
}
