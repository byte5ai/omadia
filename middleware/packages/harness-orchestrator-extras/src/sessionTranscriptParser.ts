import type { EntityRef } from '@omadia/plugin-api';

/**
 * Reverse of `SessionLogger.renderTurn()` — turns a stored Markdown
 * transcript back into structured turns so we can replay them into a fresh
 * KnowledgeGraph on startup. Intentionally tolerant: a malformed or
 * hand-edited turn is skipped rather than crashing the backfill.
 */
export interface ParsedTurn {
  time: string; // ISO (day from filename + HH:MM:SS from heading)
  userMessage: string;
  assistantAnswer: string;
  toolCalls?: number;
  iterations?: number;
  entityRefs: EntityRef[];
}

/**
 * Parses one daily transcript file. `day` is `YYYY-MM-DD` extracted from the
 * filename so we can build full ISO timestamps.
 */
export function parseSessionTranscript(
  day: string,
  markdown: string,
): ParsedTurn[] {
  // Drop the file header — everything before the first `### HH:MM:SSZ` heading.
  const firstHeading = markdown.search(/^### \d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/m);
  if (firstHeading === -1) return [];
  const body = markdown.slice(firstHeading);

  // Each turn block is delimited by a `\n---\n` separator. `---` can appear
  // inside the assistant answer (e.g. markdown tables), so we anchor on the
  // exact separator pattern our renderer emits.
  const blocks = body.split(/\n---\n\n?/);
  const turns: ParsedTurn[] = [];
  for (const block of blocks) {
    const turn = parseTurnBlock(day, block);
    if (turn) turns.push(turn);
  }
  return turns;
}

function parseTurnBlock(day: string, block: string): ParsedTurn | undefined {
  // Heading shape: `### HH:MM:SS(.mmm)?Z`. Optional milliseconds keep back-to-back
  // turns uniquely identifiable when the graph replays them on backfill.
  const headingMatch = /^### (\d\d:\d\d:\d\d(?:\.\d{1,3})?)Z$/m.exec(block);
  if (!headingMatch) return undefined;
  const time = `${day}T${headingMatch[1] ?? ''}Z`;

  const userMessage = extractBetween(block, '\n**User:**\n\n', '\n\n**Assistant:**\n\n');
  const rest = afterMarker(block, '\n\n**Assistant:**\n\n');
  if (rest === undefined || userMessage === undefined) return undefined;

  // Assistant answer runs until the telemetry line, the entity comment, or
  // the end of the block — whichever comes first.
  const cutIndex = earliestIndex(rest, [
    '\n*Telemetrie:',
    '\n<!-- entities:',
  ]);
  const assistantAnswer = (cutIndex === -1 ? rest : rest.slice(0, cutIndex)).trim();

  const telemetry = /\*Telemetrie: tools=(\d+|\?), iterations=(\d+|\?)\*/.exec(block);
  const toolCalls = telemetry && telemetry[1] !== '?' ? Number(telemetry[1]) : undefined;
  const iterations = telemetry && telemetry[2] !== '?' ? Number(telemetry[2]) : undefined;

  const entityRefs = extractEntityRefs(block);

  return {
    time,
    userMessage: userMessage.trim(),
    assistantAnswer,
    toolCalls,
    iterations,
    entityRefs,
  };
}

function extractBetween(source: string, start: string, end: string): string | undefined {
  const s = source.indexOf(start);
  if (s === -1) return undefined;
  const from = s + start.length;
  const e = source.indexOf(end, from);
  if (e === -1) return undefined;
  return source.slice(from, e);
}

function afterMarker(source: string, marker: string): string | undefined {
  const idx = source.indexOf(marker);
  if (idx === -1) return undefined;
  return source.slice(idx + marker.length);
}

function earliestIndex(source: string, needles: string[]): number {
  let best = -1;
  for (const n of needles) {
    const i = source.indexOf(n);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

function extractEntityRefs(block: string): EntityRef[] {
  const match = /<!-- entities: (\[.*?\]) -->/.exec(block);
  if (!match || match[1] === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: EntityRef[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const system = rec['s'];
    const model = rec['m'];
    const id = rec['id'];
    if (
      (system !== 'odoo' && system !== 'confluence') ||
      typeof model !== 'string' ||
      (typeof id !== 'string' && typeof id !== 'number')
    ) {
      continue;
    }
    const n = rec['n'];
    out.push({
      system,
      model,
      id,
      displayName: typeof n === 'string' ? n : undefined,
      op: 'read',
    });
  }
  return out;
}
