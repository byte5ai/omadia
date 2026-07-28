/**
 * Epic #470 W0 — CLI stream-json → runner event table (spec §5 step 5).
 * Proves each documented mapping and that noise is dropped.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { CliEventTranslator } from '../src/eventTranslate.js';
import type { RunnerEvent } from '../src/protocol.js';

const fixedNow = (): string => '2026-07-09T00:00:00.000Z';

function drain(lines: string[]): RunnerEvent[] {
  const t = new CliEventTranslator(fixedNow);
  const out: RunnerEvent[] = [];
  for (const l of lines) out.push(...t.push(l));
  out.push(...t.finish());
  return out;
}

describe('CliEventTranslator — event table', () => {
  it('system/init → status agent_started with model', () => {
    const [e] = drain([JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus' })]);
    assert.equal(e?.type, 'status');
    assert.deepEqual(e?.payload, { state: 'agent_started', model: 'claude-opus' });
  });

  it('coalesces assistant text deltas into one log per block', () => {
    const events = drain([
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop' } }),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'log');
    assert.deepEqual(events[0]?.payload, { stream: 'agent', text: 'Hello' });
  });

  it('tool_use → tool {name, inputPreview}', () => {
    const [e] = drain([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    ]);
    assert.equal(e?.type, 'tool');
    assert.equal(e?.payload['name'], 'Bash');
    assert.equal(e?.payload['inputPreview'], '{"command":"ls"}');
  });

  it('tool_result → tool {name, ok, outputPreview} resolving the name from the tool_use', () => {
    const events = drain([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } }),
    ]);
    const result = events.find((e) => e.payload['outputPreview'] !== undefined);
    assert.equal(result?.type, 'tool');
    assert.equal(result?.payload['name'], 'Bash');
    assert.equal(result?.payload['ok'], true);
    assert.equal(result?.payload['outputPreview'], 'done');
  });

  it('tool_result with is_error → ok:false', () => {
    const events = drain([
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'boom' }] } }),
    ]);
    assert.equal(events[0]?.payload['ok'], false);
    assert.equal(events[0]?.payload['name'], 'unknown');
  });

  it('result → status agent_done with usage', () => {
    const events = drain([
      JSON.stringify({ type: 'result', usage: { input_tokens: 12, output_tokens: 34 }, total_cost_usd: 0.05 }),
    ]);
    const done = events.find((e) => e.type === 'status');
    assert.deepEqual(done?.payload, { state: 'agent_done', usage: { tokensIn: 12, tokensOut: 34, costUsd: 0.05 } });
  });

  it('truncates a large input preview to the 2 KB cap', () => {
    const big = 'x'.repeat(5000);
    const [e] = drain([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Write', input: big }] } }),
    ]);
    const preview = e?.payload['inputPreview'] as string;
    assert.ok(preview.length <= 2049, 'preview capped near 2 KB');
    assert.ok(preview.endsWith('…'), 'truncation marker present');
  });

  it('drops malformed and unknown lines', () => {
    assert.deepEqual(drain(['not json', '', JSON.stringify({ type: 'mystery' })]), []);
  });
});
