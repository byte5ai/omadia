/**
 * #2085 — the side channel for data (spec 2042 §5.13). A data action the
 * agent asked for runs in the harness; its result reaches people as
 * `SemanticAnswer.data` and never reaches a model. The agent's model gets a
 * status only (row count, columns).
 *
 * `text` stays the one field every connector MUST render, so the harness also
 * renders each payload into it as plain markdown, after the agent's prose and
 * before the AI disclosure fold. A channel that renders `data` natively shows
 * `textWithoutData` (the same text, disclosure included, without that
 * rendering) next to its own table.
 */

import type { DataPayload, TableData } from '@omadia/plugin-api';

export type { DataPayload, TableData } from '@omadia/plugin-api';

/** Rows a markdown rendering shows; the payload itself may hold more. */
export const SIDE_CHANNEL_TEXT_MAX_ROWS = 50;
const MAX_CELL = 200;

const cellText = (v: string | number | boolean | null): string => {
  const s = v === null ? '' : String(v);
  const flat = s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
};

/** One table as markdown: caption, header, at most 50 rows, a "more" line. */
export function renderTableText(table: TableData): string {
  const head = table.caption ? `**${cellText(table.caption)}**\n\n` : '';
  if (table.rows.length === 0 || table.columns.length === 0) return `${head}—`;
  const lines = [
    `| ${table.columns.map(cellText).join(' | ')} |`,
    `| ${table.columns.map(() => '---').join(' | ')} |`,
  ];
  for (const row of table.rows.slice(0, SIDE_CHANNEL_TEXT_MAX_ROWS)) {
    lines.push(`| ${table.columns.map((_, i) => cellText(row[i] ?? null)).join(' | ')} |`);
  }
  const hidden = table.rows.length - SIDE_CHANNEL_TEXT_MAX_ROWS;
  const more = hidden > 0 ? `\n\n_… +${String(hidden)}_` : '';
  return `${head}${lines.join('\n')}${more}`;
}

/** Every payload rendered, in order, as one block. Empty for no data. */
export function renderDataText(data: readonly DataPayload[] | undefined): string {
  if (!data || data.length === 0) return '';
  return data.map(renderTableText).join('\n\n');
}

/** The agent's prose with the data rendering after it. */
export function withDataText(prose: string, data: readonly DataPayload[] | undefined): string {
  const block = renderDataText(data);
  if (block === '') return prose;
  return prose.trim().length > 0 ? `${prose}\n\n${block}` : block;
}

/**
 * `text` (prose + rendering + any disclosure fold) without the data
 * rendering {@link withDataText} put in. Unchanged when it is not there.
 */
export function withoutDataText(text: string, data: readonly DataPayload[] | undefined): string {
  const block = renderDataText(data);
  if (block === '') return text;
  const joined = `\n\n${block}`;
  if (text.includes(joined)) return text.replace(joined, '');
  if (text.startsWith(block)) return text.slice(block.length).replace(/^\n\n/, '');
  return text;
}
