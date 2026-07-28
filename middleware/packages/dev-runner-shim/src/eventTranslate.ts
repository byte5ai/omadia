/**
 * Epic #470 W0 — CLI stream-json → runner event translation (spec §5 step 5).
 *
 * The `claude` CLI, run with `--output-format stream-json
 * --include-partial-messages --verbose`, emits NDJSON. This translator maps the
 * empirically stable shapes to the documented runner event table and drops the
 * rest as noise. It mirrors the middleware's own `StreamJsonParser`
 * (harness-orchestrator) but emits runner events, not chat events, and lives
 * here because the shim may not import middleware code.
 *
 * | CLI line                                   | runner event                              |
 * |--------------------------------------------|-------------------------------------------|
 * | `system` / `init`                          | `status {state:'agent_started', model}`   |
 * | assistant text deltas (coalesced per block)| `log {stream:'agent', text}`              |
 * | `tool_use` block                           | `tool {name, inputPreview}` (≤2 KB)       |
 * | `tool_result` block                        | `tool {name, ok, outputPreview}` (≤2 KB)  |
 * | `result`                                   | `status {state:'agent_done', usage}`      |
 *
 * stderr lines are translated separately (`log {stream:'stderr', text}`) by the
 * agent runner; they never pass through here.
 */

import type { RunnerEvent } from './protocol.js';

const PREVIEW_LIMIT = 2048; // 2 KB, per the event table.

type JsonRecord = Record<string, unknown>;

function isRecord(x: unknown): x is JsonRecord {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function asString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}
function truncate(s: string): string {
  return s.length > PREVIEW_LIMIT ? `${s.slice(0, PREVIEW_LIMIT)}…` : s;
}

export class CliEventTranslator {
  private readonly now: () => string;
  /** Coalesced assistant text for the block currently streaming. */
  private textBuffer = '';
  /** tool_use id → tool name, so a later tool_result can name its tool. */
  private readonly toolNames = new Map<string, string>();

  public constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  /** Translate one NDJSON line into zero or more runner events. */
  public push(line: string): RunnerEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isRecord(parsed)) return [];

    switch (asString(parsed['type'])) {
      case 'system':
        return this.handleSystem(parsed);
      case 'stream_event':
        return this.handleStreamEvent(parsed);
      case 'assistant':
        return this.handleAssistant(parsed);
      case 'user':
        return this.handleUser(parsed);
      case 'result':
        return [...this.flushText(), this.handleResult(parsed)];
      default:
        return [];
    }
  }

  /** Flush any pending coalesced text as a final `log` event (call at EOF). */
  public finish(): RunnerEvent[] {
    return this.flushText();
  }

  private handleSystem(payload: JsonRecord): RunnerEvent[] {
    if (asString(payload['subtype']) !== 'init') return [];
    const model = asString(payload['model']);
    return [this.event('status', { state: 'agent_started', ...(model ? { model } : {}) })];
  }

  private handleStreamEvent(payload: JsonRecord): RunnerEvent[] {
    const event = payload['event'];
    if (!isRecord(event)) return [];
    const eventType = asString(event['type']);
    // A block ends → flush its coalesced text as one log event.
    if (eventType === 'content_block_stop' || eventType === 'message_stop') {
      return this.flushText();
    }
    if (eventType !== 'content_block_delta') return [];
    const delta = event['delta'];
    if (!isRecord(delta) || asString(delta['type']) !== 'text_delta') return [];
    const text = asString(delta['text']);
    if (text === undefined) return [];
    this.textBuffer += text;
    return [];
  }

  private handleAssistant(payload: JsonRecord): RunnerEvent[] {
    const message = payload['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) return [];
    const events: RunnerEvent[] = [];
    for (const block of message['content']) {
      if (!isRecord(block) || asString(block['type']) !== 'tool_use') continue;
      const id = asString(block['id']);
      const name = asString(block['name']);
      if (id === undefined || name === undefined) continue;
      this.toolNames.set(id, name);
      const inputPreview = truncate(safeStringify(block['input']));
      events.push(this.event('tool', { name, inputPreview }));
    }
    return events;
  }

  private handleUser(payload: JsonRecord): RunnerEvent[] {
    const message = payload['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) return [];
    const events: RunnerEvent[] = [];
    for (const block of message['content']) {
      if (!isRecord(block) || asString(block['type']) !== 'tool_result') continue;
      const id = asString(block['tool_use_id']);
      const name = (id !== undefined ? this.toolNames.get(id) : undefined) ?? 'unknown';
      const ok = block['is_error'] !== true;
      const outputPreview = truncate(flattenToolResult(block['content']));
      events.push(this.event('tool', { name, ok, outputPreview }));
    }
    return events;
  }

  private handleResult(payload: JsonRecord): RunnerEvent {
    const usageRaw = isRecord(payload['usage']) ? payload['usage'] : {};
    const usage = {
      tokensIn: numberOr(usageRaw['input_tokens'], 0),
      tokensOut: numberOr(usageRaw['output_tokens'], 0),
      ...(typeof payload['total_cost_usd'] === 'number'
        ? { costUsd: payload['total_cost_usd'] as number }
        : {}),
    };
    return this.event('status', { state: 'agent_done', usage });
  }

  private flushText(): RunnerEvent[] {
    if (this.textBuffer.length === 0) return [];
    const text = this.textBuffer;
    this.textBuffer = '';
    return [this.event('log', { stream: 'agent', text })];
  }

  private event(type: RunnerEvent['type'], payload: Record<string, unknown>): RunnerEvent {
    return { type, ts: this.now(), payload };
  }
}

function safeStringify(x: unknown): string {
  try {
    return typeof x === 'string' ? x : JSON.stringify(x ?? null);
  } catch {
    return '';
  }
}

function numberOr(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

/** A tool_result `content` is a string or an array of `{type:'text',text}` blocks. */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (isRecord(c) && asString(c['type']) === 'text' ? (asString(c['text']) ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}
