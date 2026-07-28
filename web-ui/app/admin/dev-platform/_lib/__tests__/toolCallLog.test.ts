import { describe, expect, it } from 'vitest';

import type { DevJobEventMessage } from '@/app/_lib/useDevJobEvents';

import { foldDevJobEvent, summarizeToolCall, type LogItem, type ToolCallEntry } from '../toolCallLog';

function ev(
  id: number,
  type: DevJobEventMessage['type'],
  payload: Record<string, unknown>,
): DevJobEventMessage {
  return { id, jobId: 'job-1', provision: 1, seq: id, type, ts: '2026-01-01T00:00:00Z', payload };
}

describe('foldDevJobEvent — tool pairing', () => {
  it('appends a pending entry on the start event', () => {
    const items = foldDevJobEvent([], ev(1, 'tool', { name: 'Read', inputPreview: '{"file_path":"a.ts"}' }));
    expect(items).toEqual<LogItem[]>([
      { kind: 'tool', entry: { id: '1', name: 'Read', status: 'pending', inputPreview: '{"file_path":"a.ts"}' } },
    ]);
  });

  it('pairs the result event into the matching pending entry', () => {
    let items = foldDevJobEvent([], ev(1, 'tool', { name: 'Read', inputPreview: '{"file_path":"a.ts"}' }));
    items = foldDevJobEvent(items, ev(2, 'tool', { name: 'Read', ok: true, outputPreview: 'file contents' }));
    expect(items).toEqual<LogItem[]>([
      {
        kind: 'tool',
        entry: {
          id: '1',
          name: 'Read',
          status: 'ok',
          inputPreview: '{"file_path":"a.ts"}',
          outputPreview: 'file contents',
        },
      },
    ]);
  });

  it('marks status error when ok is false', () => {
    let items = foldDevJobEvent([], ev(1, 'tool', { name: 'Bash', inputPreview: '{"command":"false"}' }));
    items = foldDevJobEvent(items, ev(2, 'tool', { name: 'Bash', ok: false, outputPreview: 'exit 1' }));
    expect((items[0] as { kind: 'tool'; entry: ToolCallEntry }).entry.status).toBe('error');
  });

  it('pairs same-name calls in order (FIFO) rather than the first pending one incorrectly', () => {
    let items = foldDevJobEvent([], ev(1, 'tool', { name: 'Read', inputPreview: '{"file_path":"a.ts"}' }));
    items = foldDevJobEvent(items, ev(2, 'tool', { name: 'Read', ok: true, outputPreview: 'A' }));
    items = foldDevJobEvent(items, ev(3, 'tool', { name: 'Read', inputPreview: '{"file_path":"b.ts"}' }));
    items = foldDevJobEvent(items, ev(4, 'tool', { name: 'Read', ok: true, outputPreview: 'B' }));
    const entries = items.map((i) => (i as { kind: 'tool'; entry: ToolCallEntry }).entry);
    expect(entries).toEqual([
      { id: '1', name: 'Read', status: 'ok', inputPreview: '{"file_path":"a.ts"}', outputPreview: 'A' },
      { id: '3', name: 'Read', status: 'ok', inputPreview: '{"file_path":"b.ts"}', outputPreview: 'B' },
    ]);
  });

  it('renders a standalone result when no matching start exists', () => {
    const items = foldDevJobEvent([], ev(1, 'tool', { name: 'Read', ok: true, outputPreview: 'orphan' }));
    expect(items).toEqual<LogItem[]>([
      { kind: 'tool', entry: { id: '1', name: 'Read', status: 'ok', outputPreview: 'orphan' } },
    ]);
  });
});

describe('foldDevJobEvent — log/other events', () => {
  it('appends agent-stream text', () => {
    const items = foldDevJobEvent([], ev(1, 'log', { text: 'thinking…', stream: 'agent' }));
    expect(items).toEqual<LogItem[]>([{ kind: 'text', id: '1', stream: 'agent', text: 'thinking…' }]);
  });

  it('routes stderr stream text', () => {
    const items = foldDevJobEvent([], ev(1, 'log', { text: 'boom', stream: 'stderr' }));
    expect(items).toEqual<LogItem[]>([{ kind: 'text', id: '1', stream: 'stderr', text: 'boom' }]);
  });

  it('drops empty-text log events', () => {
    expect(foldDevJobEvent([], ev(1, 'log', { text: '' }))).toEqual([]);
  });

  it('ignores status/phase/heartbeat events entirely', () => {
    expect(foldDevJobEvent([], ev(1, 'status', { state: 'agent_started' }))).toEqual([]);
    expect(foldDevJobEvent([], ev(1, 'phase', { phase: 'implement', state: 'start' }))).toEqual([]);
  });
});

describe('summarizeToolCall', () => {
  const entry = (overrides: Partial<ToolCallEntry>): ToolCallEntry => ({
    id: '1',
    name: 'Read',
    status: 'ok',
    ...overrides,
  });

  it('summarizes Read/Write as the file path', () => {
    const summary = summarizeToolCall(
      entry({ name: 'Read', inputPreview: '{"file_path":"src/a.ts"}', outputPreview: 'body' }),
    );
    expect(summary.headline).toBe('src/a.ts');
    expect(summary.detail).toEqual({ kind: 'file', filePath: 'src/a.ts', preview: 'body' });
  });

  it('summarizes Edit as a diff with add/remove counts', () => {
    const summary = summarizeToolCall(
      entry({
        name: 'Edit',
        inputPreview: JSON.stringify({ file_path: 'src/a.ts', old_string: 'foo', new_string: 'bar' }),
      }),
    );
    expect(summary.headline).toBe('src/a.ts');
    expect(summary.detail.kind).toBe('diff');
    if (summary.detail.kind === 'diff') {
      expect(summary.detail.filePath).toBe('src/a.ts');
      expect(summary.detail.added).toBe(1);
      expect(summary.detail.removed).toBe(1);
    }
  });

  it('summarizes Bash using the description when present, else the command', () => {
    const withDescription = summarizeToolCall(
      entry({
        name: 'Bash',
        inputPreview: JSON.stringify({ command: 'ls -la', description: 'List files' }),
        outputPreview: 'total 0',
      }),
    );
    expect(withDescription.headline).toBe('List files');
    expect(withDescription.detail).toEqual({
      kind: 'command',
      command: 'ls -la',
      description: 'List files',
      output: 'total 0',
    });

    const withoutDescription = summarizeToolCall(
      entry({ name: 'Bash', inputPreview: JSON.stringify({ command: 'ls -la' }) }),
    );
    expect(withoutDescription.headline).toBe('ls -la');
  });

  it('summarizes Agent/Task with description + subagent type', () => {
    const summary = summarizeToolCall(
      entry({
        name: 'Agent',
        inputPreview: JSON.stringify({ description: 'Find X', subagent_type: 'Explore', prompt: 'find x' }),
      }),
    );
    expect(summary.headline).toBe('Find X (Explore)');
    expect(summary.detail).toEqual({
      kind: 'agent',
      subagentType: 'Explore',
      description: 'Find X',
      prompt: 'find x',
      output: undefined,
    });
  });

  it('falls back to "Agent" headline when neither description nor subagent type is present', () => {
    const summary = summarizeToolCall(entry({ name: 'Agent', inputPreview: '{}' }));
    expect(summary.headline).toBe('Agent');
  });

  it('summarizes Grep/Glob using the pattern', () => {
    const summary = summarizeToolCall(
      entry({ name: 'Grep', inputPreview: JSON.stringify({ pattern: 'TODO', path: 'src' }) }),
    );
    expect(summary.headline).toBe('TODO');
    expect(summary.detail).toEqual({ kind: 'search', pattern: 'TODO', scope: 'src', output: undefined });
  });

  it('falls back to raw input/output for unknown tool names', () => {
    const summary = summarizeToolCall(
      entry({ name: 'TodoWrite', inputPreview: '{"todos":[]}', outputPreview: 'ok' }),
    );
    expect(summary.headline).toBe('TodoWrite');
    expect(summary.detail).toEqual({ kind: 'raw', input: '{"todos":[]}', output: 'ok' });
  });

  it('tolerates malformed JSON input without throwing', () => {
    const summary = summarizeToolCall(entry({ name: 'Read', inputPreview: 'not json' }));
    expect(summary.headline).toBe('?');
  });

  it('renders an orphan result (no captured start) as raw/output-only, not a misleading zero-diff', () => {
    // Regression: a start event dropped at an SSE reconnect boundary leaves
    // inputPreview undefined; summarizeEdit must not be reached — it would
    // silently compute file_path '?' and a 0-line diff, looking like a
    // legitimate empty edit rather than "input never captured".
    const summary = summarizeToolCall(entry({ name: 'Edit', inputPreview: undefined, outputPreview: 'ok' }));
    expect(summary.headline).toBe('Edit');
    expect(summary.detail).toEqual({ kind: 'raw', output: 'ok' });
  });
});
