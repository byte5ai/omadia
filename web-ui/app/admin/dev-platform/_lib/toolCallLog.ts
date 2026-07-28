import type { DevJobEventMessage } from '@/app/_lib/useDevJobEvents';

import { computeLineDiff, type DiffLine } from './lineDiff';

/**
 * Epic #470 — turns the raw `dev_job_events` SSE tail into renderable log
 * items for the job-detail implement-phase pane. Two responsibilities:
 *
 *   1. `foldDevJobEvent` pairs a tool call's two independent wire events
 *      (`{name, inputPreview}` at start, `{ok, name, outputPreview}` at
 *      result — no shared correlation id) into one `ToolCallEntry`, by
 *      walking back to the nearest still-pending entry with the same tool
 *      name. Safe for the single-threaded CLI agent loop this feeds from: a
 *      tool cannot start a second call under the same name before the first
 *      resolves.
 *   2. `summarizeToolCall` turns a paired entry's raw JSON `inputPreview`
 *      into a one-line headline + a tool-shaped detail (a diff for `Edit`,
 *      a command for `Bash`, etc.) instead of the previous `$ Name {...raw
 *      JSON...}` dump. Unknown tool names fall back to the raw
 *      input/output text — nothing silently disappears.
 */

export type ToolCallStatus = 'pending' | 'ok' | 'error';

export interface ToolCallEntry {
  id: string;
  name: string;
  status: ToolCallStatus;
  inputPreview?: string;
  outputPreview?: string;
}

export type LogItem =
  | { kind: 'text'; id: string; stream: 'agent' | 'stderr'; text: string }
  | { kind: 'tool'; entry: ToolCallEntry };

export function foldDevJobEvent(items: LogItem[], ev: DevJobEventMessage): LogItem[] {
  if (ev.type === 'tool') return foldToolEvent(items, ev);
  if (ev.type === 'log') return foldLogEvent(items, ev);
  return items;
}

function foldToolEvent(items: LogItem[], ev: DevJobEventMessage): LogItem[] {
  const p = ev.payload;
  const name = typeof p['name'] === 'string' ? p['name'] : 'tool';
  const hasResult = typeof p['ok'] === 'boolean';

  if (!hasResult) {
    const inputPreview = typeof p['inputPreview'] === 'string' ? p['inputPreview'] : undefined;
    return [...items, { kind: 'tool', entry: { id: String(ev.id), name, status: 'pending', inputPreview } }];
  }

  const ok = p['ok'] === true;
  const outputPreview = typeof p['outputPreview'] === 'string' ? p['outputPreview'] : undefined;
  const idx = findLastPending(items, name);
  if (idx === -1) {
    // No matching start (e.g. a reconnect landed mid-call) — render standalone.
    return [
      ...items,
      { kind: 'tool', entry: { id: String(ev.id), name, status: ok ? 'ok' : 'error', outputPreview } },
    ];
  }

  const target = items[idx];
  if (!target || target.kind !== 'tool') return items;
  const next = items.slice();
  next[idx] = { kind: 'tool', entry: { ...target.entry, status: ok ? 'ok' : 'error', outputPreview } };
  return next;
}

function foldLogEvent(items: LogItem[], ev: DevJobEventMessage): LogItem[] {
  const p = ev.payload;
  const text = typeof p['text'] === 'string' ? p['text'] : '';
  if (!text) return items;
  return [...items, { kind: 'text', id: String(ev.id), stream: p['stream'] === 'stderr' ? 'stderr' : 'agent', text }];
}

function findLastPending(items: LogItem[], name: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && item.kind === 'tool' && item.entry.name === name && item.entry.status === 'pending') return i;
  }
  return -1;
}

// --- Summarization -----------------------------------------------------

export type ToolCallDetail =
  | { kind: 'diff'; filePath: string; diff: DiffLine[]; added: number; removed: number }
  | { kind: 'command'; command: string; description?: string; output?: string }
  | { kind: 'file'; filePath: string; preview?: string }
  | { kind: 'agent'; subagentType?: string; description?: string; prompt?: string; output?: string }
  | { kind: 'search'; pattern: string; scope?: string; output?: string }
  | { kind: 'raw'; input?: string; output?: string };

export interface ToolCallSummary {
  headline: string;
  detail: ToolCallDetail;
}

export function summarizeToolCall(entry: ToolCallEntry): ToolCallSummary {
  const input = parseJsonObject(entry.inputPreview);
  switch (entry.name) {
    case 'Read':
    case 'Write':
      return summarizeFileTool(input, entry.outputPreview);
    case 'Edit':
      return summarizeEdit(input);
    case 'Bash':
      return summarizeBash(input, entry.outputPreview);
    case 'Agent':
    case 'Task':
      return summarizeAgent(input, entry.outputPreview);
    case 'Grep':
    case 'Glob':
      return summarizeSearch(entry.name, input, entry.outputPreview);
    default:
      return { headline: entry.name, detail: { kind: 'raw', input: entry.inputPreview, output: entry.outputPreview } };
  }
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function summarizeFileTool(input: Record<string, unknown>, output: string | undefined): ToolCallSummary {
  const filePath = str(input['file_path']) ?? '?';
  return { headline: filePath, detail: { kind: 'file', filePath, preview: output } };
}

function summarizeEdit(input: Record<string, unknown>): ToolCallSummary {
  const filePath = str(input['file_path']) ?? '?';
  const oldString = str(input['old_string']) ?? '';
  const newString = str(input['new_string']) ?? '';
  const diff = computeLineDiff(oldString, newString);
  const added = diff.filter((l) => l.type === 'add').length;
  const removed = diff.filter((l) => l.type === 'remove').length;
  return { headline: filePath, detail: { kind: 'diff', filePath, diff, added, removed } };
}

function summarizeBash(input: Record<string, unknown>, output: string | undefined): ToolCallSummary {
  const command = str(input['command']) ?? '';
  const description = str(input['description']);
  return { headline: description ?? command, detail: { kind: 'command', command, description, output } };
}

function summarizeAgent(input: Record<string, unknown>, output: string | undefined): ToolCallSummary {
  const description = str(input['description']);
  const subagentType = str(input['subagent_type']);
  const prompt = str(input['prompt']);
  const headline = [description, subagentType ? `(${subagentType})` : undefined].filter(Boolean).join(' ');
  return {
    headline: headline.length > 0 ? headline : 'Agent',
    detail: { kind: 'agent', subagentType, description, prompt, output },
  };
}

function summarizeSearch(
  name: string,
  input: Record<string, unknown>,
  output: string | undefined,
): ToolCallSummary {
  const pattern = str(input['pattern']) ?? '';
  const scope = str(input['path']) ?? str(input['glob']);
  return { headline: pattern.length > 0 ? pattern : name, detail: { kind: 'search', pattern, scope, output } };
}
