/**
 * The text answer of a deterministic chat turn: the rendered summary
 * sentence plus a compact markdown table of the rows (capped, with a
 * truncation note). Every channel renders markdown text, so this is the one
 * shape that works on web, Teams, Telegram, Slack and the HTTP API alike.
 * The rows only ever reach the user — no model sees this text.
 */

/** Rows shown in a chat table; the rest is summarised in a note. */
export const MAX_TABLE_ROWS = 50;
const MAX_CELL_CHARS = 200;

function cell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  const flat = s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const capped = flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 1)}…` : flat;
  return capped.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function truncationNote(hidden: number, shown: number, locale: string | undefined): string {
  return locale?.toLowerCase().startsWith('de')
    ? `_${hidden} weitere Zeilen nicht angezeigt (erste ${shown})._`
    : `_${hidden} more rows not shown (first ${shown})._`;
}

export function renderChatAnswer(opts: {
  summary: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  /** column order = fieldKeys of the fetch map */
  columns: readonly string[];
  labels: Readonly<Record<string, string>>;
  locale?: string;
  maxRows?: number;
}): string {
  if (opts.rows.length === 0 || opts.columns.length === 0) return opts.summary;
  const max = opts.maxRows ?? MAX_TABLE_ROWS;
  const shown = opts.rows.slice(0, max);
  const header = `| ${opts.columns.map((k) => cell(opts.labels[k] ?? k)).join(' | ')} |`;
  const rule = `| ${opts.columns.map(() => '---').join(' | ')} |`;
  const body = shown.map((r) => `| ${opts.columns.map((k) => cell(r[k])).join(' | ')} |`);
  const parts = [opts.summary, '', header, rule, ...body];
  if (opts.rows.length > shown.length) {
    parts.push('', truncationNote(opts.rows.length - shown.length, shown.length, opts.locale));
  }
  return parts.join('\n');
}

/** `fast_path_channels`: unset / empty / "all" / "*" → every channel;
 *  "none" → no channel; else a comma list of channel names (lower-case). */
export function parseFastPathChannels(raw: string | undefined): (channel: string) => boolean {
  const v = raw?.trim().toLowerCase() ?? '';
  if (v === '' || v === 'all' || v === '*') return () => true;
  if (v === 'none') return () => false;
  const set = new Set(
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  return (channel) => set.has(channel.toLowerCase());
}
