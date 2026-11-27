/**
 * ADR-0195 (#2239) — `Orchestrator.cliTurnPrivacy`, the shield a CLI turn
 * gets: the v4 tools are served by the handle, a data tool runs on the user's
 * values and its echo is masked again, the render swaps in the server answer,
 * and no guard means no shield (the CLI agent then refuses a guarded turn).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PrivacyGuardService } from '@omadia/plugin-api';

import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator, type OrchestratorOptions } from '../../packages/harness-orchestrator/src/orchestrator.js';
import type { ToolDispatchResult } from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import { scriptedModel, text } from '../_helpers/replayTurnFixture.js';

const REAL = 'Projekt Falkenstein';
const PLACEHOLDER = 'PLATZHALTER-CUSTOM-1';

function service(log: string[]): PrivacyGuardService {
  return {
    v4ToolSpecs: () => [
      { name: 'v4_render_answer', description: 'render', input_schema: { type: 'object', properties: {} } },
    ],
    runV4Tool: async (input: { toolName: string }) => {
      log.push(`v4:${input.toolName}`);
      return { resultText: 'rendered ack' };
    },
    takeRenderedAnswerV4: async () => ({ text: `Tabelle zu ${REAL}`, maskedValues: [REAL] }),
    restoreToolInputValues: (_turnId: string, value: string) => value.split(PLACEHOLDER).join(REAL),
    remaskPromptValues: (_turnId: string, value: string) => value.split(REAL).join(PLACEHOLDER),
    restorePromptPseudonyms: async (_turnId: string, value: string) => value.split(PLACEHOLDER).join(REAL),
    finalizeTurn: async () => {
      log.push('finalize');
      return undefined;
    },
  } as unknown as PrivacyGuardService;
}

function orchestrator(guard: PrivacyGuardService | undefined): Orchestrator {
  return new Orchestrator({
    provider: scriptedModel([text('ok')]).provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 4,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: 'mira',
    privacyGuard: () => guard,
  } as unknown as OrchestratorOptions);
}

describe('Orchestrator.cliTurnPrivacy (ADR-0195)', () => {
  it('is undefined without a privacy guard', () => {
    assert.equal(orchestrator(undefined).cliTurnPrivacy({ userMessage: 'x' }, 't0', 'sonnet'), undefined);
  });

  it('serves v4 tools from the handle and offers them with the directive', async () => {
    const log: string[] = [];
    const privacy = orchestrator(service(log)).cliTurnPrivacy({ userMessage: 'x' }, 't1', 'sonnet')!;
    assert.deepEqual(privacy.tools.map((t) => t.name), ['v4_render_answer']);
    assert.match(privacy.directive, /v4_render_answer/);
    const base = { dispatch: async (): Promise<ToolDispatchResult> => ({ content: 'never' }) };
    const result = await privacy.wrapDispatch(base).dispatch('v4_render_answer', {}, undefined);
    assert.equal(result.content, 'rendered ack');
    assert.deepEqual(log, ['v4:v4_render_answer']);
  });

  it('runs a data tool on the user value and masks its echo again', async () => {
    const privacy = orchestrator(service([])).cliTurnPrivacy({ userMessage: 'x' }, 't2', 'sonnet')!;
    const inputs: unknown[] = [];
    const base = {
      dispatch: async (_name: string, input: unknown): Promise<ToolDispatchResult> => {
        inputs.push(input);
        return { content: `found ${(input as { q: string }).q}` };
      },
    };
    const result = await privacy.wrapDispatch(base).dispatch('search_docs', { q: PLACEHOLDER }, undefined);
    assert.deepEqual(inputs, [{ q: REAL }]);
    assert.equal(result.content, `found ${PLACEHOLDER}`);
  });

  it('keeps the placeholder in an intern-exempt self tool input', async () => {
    const privacy = orchestrator(service([])).cliTurnPrivacy({ userMessage: 'x' }, 't3', 'sonnet')!;
    const inputs: unknown[] = [];
    const base = {
      dispatch: async (_name: string, input: unknown): Promise<ToolDispatchResult> => {
        inputs.push(input);
        return { content: 'ok' };
      },
    };
    await privacy.wrapDispatch(base).dispatch('memory', { path: PLACEHOLDER }, undefined);
    assert.deepEqual(inputs, [{ path: PLACEHOLDER }]);
  });

  it('releases the server-rendered answer and finalizes once', async () => {
    const log: string[] = [];
    const privacy = orchestrator(service(log)).cliTurnPrivacy({ userMessage: 'x' }, 't4', 'sonnet')!;
    const released = await privacy.releaseAnswer(`Model prose ${PLACEHOLDER}`);
    assert.equal(released.answer, `Tabelle zu ${REAL}`);
    assert.equal(released.answerSource, 'privacy-render');
    assert.deepEqual(released.maskedValues, [REAL]);
    assert.deepEqual(await privacy.finalize('x'), {});
    assert.deepEqual(log, ['finalize']);
  });
});
