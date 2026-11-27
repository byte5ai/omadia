/**
 * #2301 / ADR-0268 — a CLI sub-agent asked inside a guarded turn works under
 * the calling turn's handle like the main turn: it gets the v4 verb tools
 * (served by that handle, never the render tool), its tool inputs have the
 * prompt surrogates restored and its results are re-masked.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CALLER_PRIVACY_SUB_AGENT_DIRECTIVE,
  callerPrivacyTools,
  withCallerPrivacyDispatch,
} from '../../packages/harness-orchestrator/src/cliCallerPrivacy.js';
import type { LoopbackDispatch } from '../../packages/harness-orchestrator/src/cliMemoryTool.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';

const REAL = 'Marc Demo';
const SURROGATE = 'PLATZHALTER-NAME-1';

function callerHandle(v4Calls: string[]): PrivacyTurnHandle {
  return {
    v4ToolSpecs: () => [
      { name: 'v4_filter', description: 'filter', input_schema: { type: 'object' } },
      { name: 'v4_count', description: 'count', input_schema: { type: 'object' } },
      { name: 'v4_render_answer', description: 'render', input_schema: { type: 'object' } },
    ],
    runV4Tool: async ({ toolName }: { toolName: string }) => {
      v4Calls.push(toolName);
      return { resultText: `${toolName}: 3 rows` };
    },
    restoreToolInputValues: (text: string) => text.split(SURROGATE).join(REAL),
    remaskPromptValues: (text: string) => text.split(REAL).join(SURROGATE),
  } as unknown as PrivacyTurnHandle;
}

describe('CLI sub-agent under the caller handle (#2301)', () => {
  it('offers the v4 verb tools without the render tool', () => {
    const names = callerPrivacyTools(callerHandle([])).map((t) => t.name);
    assert.deepEqual(names, ['v4_filter', 'v4_count']);
  });

  it('offers nothing when the provider has no v4 data plane', () => {
    assert.deepEqual(callerPrivacyTools({} as PrivacyTurnHandle), []);
  });

  it('serves v4 verbs through the caller handle and refuses the render', async () => {
    const v4Calls: string[] = [];
    const base: LoopbackDispatch = {
      dispatch: () => Promise.reject(new Error('base must not run for v4 tools')),
    };
    const dispatch = withCallerPrivacyDispatch(callerHandle(v4Calls), base);
    const counted = await dispatch.dispatch('v4_count', { datasetId: 'ds-1' });
    assert.equal(counted.content, 'v4_count: 3 rows');
    const render = await dispatch.dispatch('v4_render_answer', {});
    assert.equal(render.isError, true);
    assert.deepEqual(v4Calls, ['v4_count']);
  });

  it('restores surrogates in tool inputs and re-masks the result', async () => {
    const seen: unknown[] = [];
    const base: LoopbackDispatch = {
      dispatch: async (_name, input) => {
        seen.push(input);
        return { content: `Kontakt: ${REAL}` };
      },
    };
    const dispatch = withCallerPrivacyDispatch(callerHandle([]), base);
    const out = await dispatch.dispatch('hr_lookup', { name: SURROGATE });
    assert.deepEqual(seen, [{ name: REAL }]);
    assert.equal(out.content, `Kontakt: ${SURROGATE}`);
  });

  it('keeps the surrogates for a tool that runs on model input', async () => {
    const seen: unknown[] = [];
    const base: LoopbackDispatch = {
      dispatch: async (_name, input) => {
        seen.push(input);
        return { content: 'ok' };
      },
    };
    const dispatch = withCallerPrivacyDispatch(callerHandle([]), base);
    await dispatch.dispatch('write_process', { title: SURROGATE });
    assert.deepEqual(seen, [{ title: SURROGATE }]);
  });

  it('tells the sub-agent model how to work with digests', () => {
    assert.match(CALLER_PRIVACY_SUB_AGENT_DIRECTIVE, /v4_\*/);
  });
});
