/**
 * #1402 — `splitV4ToolResult` keeps a render's canvas snapshot off the LLM
 * wire, also for a guard that predates `canvasSentinel` and still embeds the
 * snapshot in `resultText`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  V4_RENDER_KERNEL_NOTE,
  splitV4ToolResult,
} from '@omadia/orchestrator/dist/v4RenderSideChannel.js';

const SNAPSHOT = JSON.stringify({
  _pendingCanvasTree: { tree: { type: 'table', rows: [{ cells: { name: 'Paul Williams' } }] } },
  _note: 'done',
});

describe('splitV4ToolResult', () => {
  it('passes a verb digest through unchanged', () => {
    const r = splitV4ToolResult('v4_sort', {
      resultText: '[privacy-shield-v4] digest {"datasetId":"ds_1"}',
    });
    assert.deepEqual(r, { llmText: '[privacy-shield-v4] digest {"datasetId":"ds_1"}' });
  });

  it('routes a current guard\'s canvasSentinel to the side channel', () => {
    const r = splitV4ToolResult('v4_render_answer', { resultText: 'ack', canvasSentinel: SNAPSHOT });
    assert.equal(r.llmText, 'ack');
    assert.equal(r.canvasSentinel, SNAPSHOT);
  });

  it('moves a legacy guard\'s embedded snapshot off the wire', () => {
    const r = splitV4ToolResult('v4_render_answer', { resultText: SNAPSHOT });
    assert.equal(r.llmText, V4_RENDER_KERNEL_NOTE);
    assert.equal(r.canvasSentinel, SNAPSHOT);
    assert.ok(!r.llmText.includes('Paul Williams'));
  });

  it('leaves a verb digest that merely contains "_pending alone', () => {
    const digest = '[privacy-shield-v4] digest {"fields":["_pending_since"]}';
    assert.deepEqual(splitV4ToolResult('v4_filter', { resultText: digest }), { llmText: digest });
  });
});
