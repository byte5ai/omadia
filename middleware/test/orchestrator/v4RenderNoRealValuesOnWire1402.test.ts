/**
 * Issue #1402 — `v4_render_answer` must never hand the real table rows back to
 * the model as its `tool_result`.
 *
 * Drives the REAL `Orchestrator` with the REAL privacy-guard service: a domain
 * tool returns HR rows (interned to a digest), the model renders them as a
 * table and is then asked once more (the request that carried the leak — the
 * loop always calls the model again after a tool round). Asserts that no
 * request to the provider carries a real cell value, that the canvas still
 * receives the full snapshot through the sentinel sink, and that the
 * user-facing answer still shows the real rows.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import type { PrivacyGuardService } from '@omadia/plugin-api';
import { NativeToolRegistry, Orchestrator, today, turnContext } from '@omadia/orchestrator';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const HR_ROWS = [
  { employee: 'Paul Williams', job_title: 'Experienced Developer', work_email: 'paul.williams59@example.com' },
  { employee: 'Erika Mustermann', job_title: 'Consultant', work_email: 'erika.mustermann@example.com' },
];
const REAL_VALUES = ['Paul Williams', 'Williams', 'paul.williams59@example.com', 'Erika Mustermann', 'Mustermann'];

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function toolCall(id: string, name: string, input: unknown): LlmResponse {
  return {
    content: [{ type: 'tool_call', id, name, input }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function text(t: string): LlmResponse {
  return {
    content: [{ type: 'text', text: t }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** Every string the model was sent, flattened — the LLM wire. */
function wireOf(requests: readonly unknown[]): string {
  return JSON.stringify(requests);
}

/** Model script: call the HR tool → render its dataset as a table → stop. The
 *  render step reads the datasetId out of the digest the model was handed. */
function scriptedProvider(): { provider: LlmProvider; requests: unknown[] } {
  const requests: unknown[] = [];
  let step = 0;
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (request: { messages?: unknown[] }) => {
      requests.push(request.messages ?? []);
      step += 1;
      if (step === 1) return Promise.resolve(toolCall('use-1', 'hr_employees', {}));
      if (step === 2) {
        const datasetId = /ds_[0-9a-f-]+/.exec(JSON.stringify(request.messages))?.[0];
        assert.ok(datasetId, 'the model was handed a datasetId');
        return Promise.resolve(
          toolCall('use-2', 'v4_render_answer', {
            datasetId,
            columns: [{ field: 'employee', label: 'Name' }, 'job_title', 'work_email'],
            format: 'table',
          }),
        );
      }
      return Promise.resolve(text('Done.'));
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, requests };
}

function registry(): NativeToolRegistry {
  const r = new NativeToolRegistry();
  r.register('hr_employees', {
    handler: () => Promise.resolve(JSON.stringify(HR_ROWS)),
    spec: {
      name: 'hr_employees',
      description: 'HR employees',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    domain: 'odoo.hr',
  });
  return r;
}

describe('#1402 — v4_render_answer keeps real values off the LLM wire', () => {
  it('sends no real cell value to the model, still feeds the canvas and the user answer', async () => {
    const tapped: { tool: string; raw: string }[] = [];
    const service: PrivacyGuardService = createPrivacyGuardService();
    const { provider, requests } = scriptedProvider();
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 4,
      domainTools: [],
      nativeToolRegistry: registry(),
      privacyGuard: () => service,
    } as ConstructorParameters<typeof Orchestrator>[0]);

    const answer = await turnContext.run(
      {
        turnId: '',
        turnDate: today(),
        canvasSentinelSink: (tool, raw) => tapped.push({ tool, raw }),
      },
      () => orchestrator.runTurn({ userMessage: 'Who works in Long Term Projects?' }),
    );

    assert.equal(requests.length, 3, 'the model was asked again after the render');
    const wire = wireOf(requests);
    for (const value of REAL_VALUES) {
      assert.ok(!wire.includes(value), `real value "${value}" reached the LLM wire`);
    }
    assert.ok(!wire.includes('_pendingCanvasTree'), 'the canvas snapshot reached the LLM wire');
    assert.ok(wire.includes('Rendered a table with 2 rows'), 'the model got the shape-only ack');

    const render = tapped.find((t) => t.tool === 'v4_render_answer');
    assert.ok(render, 'the canvas sink received the render snapshot');
    assert.ok(render.raw.includes('_pendingCanvasTree'));
    assert.ok(render.raw.includes('Paul Williams'), 'the canvas still gets the real rows');

    assert.ok(answer.answer.includes('Paul Williams'), `user answer lost the rows: ${answer.answer}`);
  });
});
