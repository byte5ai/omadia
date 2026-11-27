import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PrivacyTurnHandle } from '../packages/harness-orchestrator/src/index.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { mcpObservationDigest } from '../packages/harness-orchestrator/src/orchestrator.js';
import { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';
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

describe('ToolDispatchService result cap (#2309)', () => {
  const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS * 2);

  function dispatcher(
    name: string,
    result: string,
    privacy?: PrivacyTurnHandle,
  ): ToolDispatchService {
    const registry = new NativeToolRegistry();
    registry.register(name, {
      spec: { name, description: 'probe', input_schema: { type: 'object', properties: {} } },
      handler: async () => result,
    });
    return new ToolDispatchService({
      nativeTools: registry,
      ...(privacy !== undefined ? { privacy: () => privacy } : {}),
    });
  }

  it('caps a result when no privacy guard is installed', async () => {
    const out = await dispatcher('probe_tool', big).dispatch('probe_tool', {});
    assert.ok(out.content.length < big.length);
    assert.match(out.content, /\[result truncated/);
  });

  it('caps an intern-exempt tool under a guard', async () => {
    const privacy = {} as PrivacyTurnHandle;
    const out = await dispatcher('query_processes', big, privacy).dispatch('query_processes', {});
    assert.match(out.content, /\[result truncated/);
  });

  it('caps an operator-bypassed result', async () => {
    const privacy = {
      checkBypass: () => ({ pluginId: 'probe' }),
      recordBypassedTool: async () => undefined,
    } as unknown as PrivacyTurnHandle;
    const out = await dispatcher('probe_tool', big, privacy).dispatch('probe_tool', {});
    assert.match(out.content, /\[result truncated/);
  });

  it("leaves a kernel tool's directive whole", async () => {
    const directive = `{"_pendingCanvas":"${big}"}`;
    const out = await dispatcher('probe_tool', directive).dispatch('probe_tool', {});
    assert.equal(out.content, directive);
  });
});
