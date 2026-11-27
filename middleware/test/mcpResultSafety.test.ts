import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { mcpObservationDigest } from '../packages/harness-orchestrator/src/orchestrator.js';
import {
  MAX_TOOL_RESULT_CHARS,
  capToolResultText,
} from '../packages/harness-orchestrator/src/toolResultCap.js';

/** W09-10 result safety — #1920 result cap, #1934 value-free KG digest. */

describe('capToolResultText (#1920)', () => {
  it('passes a result within the limit unchanged', () => {
    assert.equal(capToolResultText('short'), 'short');
    const exact = 'x'.repeat(MAX_TOOL_RESULT_CHARS);
    assert.equal(capToolResultText(exact), exact);
  });

  it('leaves a kernel directive whole, which the kernel parses after the call', () => {
    const directive = JSON.stringify({ _pendingCanvas: true, rows: 'z'.repeat(MAX_TOOL_RESULT_CHARS) });
    assert.equal(capToolResultText(directive, { keepDirectives: true }), directive);
    assert.notEqual(capToolResultText(directive), directive, 'an MCP result is never exempt');
  });

  it('cuts a larger result and tells the model', () => {
    const out = capToolResultText('y'.repeat(MAX_TOOL_RESULT_CHARS + 50));
    assert.ok(out.startsWith('y'.repeat(MAX_TOOL_RESULT_CHARS)));
    assert.match(out, /\[result truncated: the tool returned 200050 characters/);
    assert.ok(out.length < MAX_TOOL_RESULT_CHARS + 300);
  });
});

describe('mcpObservationDigest (#1934)', () => {
  it('names no keys of an object, only how many there are', () => {
    const digest = mcpObservationDigest(
      JSON.stringify({ 'alice@example.com': 1, 'bob@example.com': 2, 'carol@example.com': 3 }),
    );
    assert.equal(digest, '3 fields (names and values masked)');
    assert.doesNotMatch(digest, /@/);
  });

  it('counts records and sizes text', () => {
    assert.equal(mcpObservationDigest('[1,2]'), '2 records (values masked)');
    assert.equal(mcpObservationDigest('plain'), '(5 bytes, values masked)');
  });
});
