/**
 * S2-N15 — Privacy Shield residual leak paths.
 *
 * #1534 — under a shield the `memory` tool may not read the session
 *         transcripts under `/memories/sessions/`: `SessionLogger` writes
 *         them with every turn's real values restored, and `memory` is
 *         intern-exempt, so a `view` handed those values to the model.
 * #1535 — with `OMADIA_PRIVACY_FORCE_GUARDED=true` a turn that would run
 *         unmasked is refused: no provider running on the in-process path,
 *         and every turn on the subscription-CLI path.
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { InMemoryMemoryStore } from '@omadia/memory';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import {
  isPromptMaskBlockedNotice,
  PRIVACY_SHIELD_REQUIRED_ANSWER,
} from '@omadia/orchestrator/dist/orchestrator.js';
import { createJobPrivacy } from '@omadia/orchestrator-extras/dist/jobPrivacy.js';
import { PRIVACY_FORCE_GUARDED_ENV_VAR } from '@omadia/plugin-api';

import { composeSkeleton } from '../packages/omadia-ui-orchestrator/src/composition.js';

import {
  CliChatAgent,
  CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_DE,
  CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_EN,
  CLI_PRIVACY_SHIELD_REQUIRED_LOG,
} from '../packages/harness-orchestrator/src/cliChatAgent.js';
import { MemoryBinder } from '../packages/harness-orchestrator/src/memoryBinder.js';
import {
  ContextMemoryNamespacer,
  MemoryPathDenied,
  OrchestratorMemoryNamespacer,
} from '../packages/harness-orchestrator/src/orchestratorMemoryNamespacer.js';
import type { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';

const TRANSCRIPT = '/memories/sessions/chat-1/2026-10-28.md';

async function seededStore(): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  await store.writeFile(TRANSCRIPT, '**User:** Wer ist Marc Demo?\n**Assistant:** marc@demo.de');
  return store;
}

describe('#1534 memory tool and session transcripts under a shield', () => {
  it('refuses /memories/sessions while a shield is active, for every command', async () => {
    const nsr = new OrchestratorMemoryNamespacer('main', await seededStore(), () => true);
    await assert.rejects(nsr.readFile(TRANSCRIPT), MemoryPathDenied);
    await assert.rejects(nsr.list('/memories/sessions'), MemoryPathDenied);
    await assert.rejects(nsr.fileExists(TRANSCRIPT), MemoryPathDenied);
    await assert.rejects(nsr.directoryExists('/memories/sessions'), MemoryPathDenied);
    await assert.rejects(nsr.writeFile('/memories/sessions/x.md', 'y'), MemoryPathDenied);
    // Renaming a transcript out of the tree is a read in disguise.
    await assert.rejects(nsr.rename(TRANSCRIPT, '/memories/notes.md'), MemoryPathDenied);
    await assert.rejects(nsr.readFile(TRANSCRIPT), /Privacy Shield/);
  });

  it('keeps the transcripts readable without a shield', async () => {
    const off = new OrchestratorMemoryNamespacer('main', await seededStore(), () => false);
    assert.match(await off.readFile(TRANSCRIPT), /Marc Demo/);
    const unwired = new OrchestratorMemoryNamespacer('main', await seededStore());
    assert.match(await unwired.readFile(TRANSCRIPT), /Marc Demo/);
  });

  it('reads the predicate per call, so a cached binding follows the provider', async () => {
    let active = false;
    const nsr = new OrchestratorMemoryNamespacer('main', await seededStore(), () => active);
    assert.match(await nsr.readFile(TRANSCRIPT), /Marc Demo/);
    active = true;
    await assert.rejects(nsr.readFile(TRANSCRIPT), MemoryPathDenied);
  });

  it('leaves the rest of the shared tree alone under a shield', async () => {
    const store = await seededStore();
    await store.writeFile('/memories/core/rules.md', 'rule');
    const nsr = new OrchestratorMemoryNamespacer('main', store, () => true);
    assert.equal(await nsr.readFile('/memories/core/rules.md'), 'rule');
    await nsr.writeFile('/memories/notes.md', 'mine');
    assert.equal(await nsr.readFile('/memories/notes.md'), 'mine');
  });

  it('the context namespacer refuses the transcripts too', async () => {
    const nsr = new ContextMemoryNamespacer(
      {
        privateRoot: '/memories/contexts/main/channel/abc',
        agentRoot: '/memories/orchestrators/main',
        shieldActive: () => true,
      },
      await seededStore(),
    );
    await assert.rejects(nsr.readFile(TRANSCRIPT), MemoryPathDenied);
  });

  it('every binding the MemoryBinder hands out carries the predicate', async () => {
    for (const mode of ['off', 'enforce'] as const) {
      const binder = new MemoryBinder({
        agentSlug: 'main',
        root: await seededStore(),
        mode,
        shieldActive: () => true,
      });
      const bound = binder.forOrigin(undefined);
      await assert.rejects(bound.store.readFile(TRANSCRIPT), MemoryPathDenied, mode);
    }
  });
});

// --- #1535 --------------------------------------------------------------

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function countingProvider(calls: { n: number }): LlmProvider {
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: async (_req: LlmRequest): Promise<LlmResponse> => {
      calls.n += 1;
      return textResponse('Marc Demo arbeitet in R&D.');
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      calls.n += 1;
      return (async function* () {
        yield { type: 'text_delta', text: 'raw' } as unknown as LlmStreamEvent;
      })();
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function orchestrator(calls: { n: number }, hooks: string[] = []): Orchestrator {
  return new Orchestrator({
    turnHookRegistry: {
      run: async (point: string) => {
        hooks.push(point);
        return [];
      },
    },
    provider: countingProvider(calls),
    model: 'test',
    maxTokens: 256,
    maxToolIterations: 2,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    privacyGuard: () => undefined,
  });
}

describe('#1535 OMADIA_PRIVACY_FORCE_GUARDED fails closed', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
    else process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = saved;
  });

  it('refuses a turn without a running provider; the model never runs', async () => {
    process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = 'true';
    const calls = { n: 0 };
    const hooks: string[] = [];
    const result = await orchestrator(calls, hooks).runTurn({
      userMessage: 'Wer ist Marc Demo?',
      sessionScope: 's-1',
    });
    assert.equal(calls.n, 0, 'no model call');
    assert.deepEqual(hooks, [], 'no turn hook on a refused turn');
    assert.equal(result.answer, PRIVACY_SHIELD_REQUIRED_ANSWER);
    assert.ok(isPromptMaskBlockedNotice(result.answer), 'the verifier treats it as a refusal');
  });

  it('refuses a streamed turn the same way', async () => {
    process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = 'true';
    const calls = { n: 0 };
    const hooks: string[] = [];
    const events = [];
    for await (const event of orchestrator(calls, hooks).chatStream({
      userMessage: 'Wer ist Marc Demo?',
      sessionScope: 's-2',
    })) {
      events.push(event);
    }
    assert.equal(calls.n, 0, 'no model call');
    // The plan-runner's gate is an LLM call on the raw message: no hook runs.
    assert.deepEqual(hooks, [], 'no turn hook on a refused turn');
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    // Delivered in the turn's language, with the AI disclosure folded in.
    assert.match(done.answer, /Datenschutz-Schild, er läuft aber gerade nicht/);
  });

  it('runs the turn as before without the policy', async () => {
    delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
    const calls = { n: 0 };
    const hooks: string[] = [];
    const result = await orchestrator(calls, hooks).runTurn({
      userMessage: 'Hallo',
      sessionScope: 's-3',
    });
    assert.equal(calls.n, 1);
    assert.match(result.answer, /Marc Demo/);
    assert.ok(hooks.includes('onBeforeTurn'), `hooks run without the policy: ${hooks.join()}`);
  });

  it('refuses every subscription-CLI turn under the policy, before any spawn', async () => {
    let spawned = 0;
    const agent = new CliChatAgent({
      dispatch: {} as unknown as ToolDispatchService,
      policyEnv: { [PRIVACY_FORCE_GUARDED_ENV_VAR]: 'true' },
      spawnFn: (() => {
        spawned += 1;
        throw new Error('must not spawn');
      }) as never,
    });
    const answer = await agent.chat({ userMessage: 'Wer ist Marc Demo?', sessionScope: 's-4' });
    // No locale wired → German, the default of every notice.
    assert.equal(answer.text, CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_DE);
    const events = [];
    for await (const event of agent.chatStream({ userMessage: 'x', sessionScope: 's-4' })) {
      events.push(event);
    }
    assert.deepEqual(
      events.map((e) => e.type),
      ['done'],
    );
    assert.equal(spawned, 0);
  });

  it('words the refusal in the turn language and tells the operator why', async () => {
    const warned: Array<{ message: string; meta?: Readonly<Record<string, unknown>> }> = [];
    const agent = new CliChatAgent({
      dispatch: {} as unknown as ToolDispatchService,
      policyEnv: { [PRIVACY_FORCE_GUARDED_ENV_VAR]: 'true' },
      noticeLocale: () => 'en-GB',
      logger: { info: () => {}, warn: (message, meta) => warned.push({ message, ...(meta ? { meta } : {}) }) },
      spawnFn: (() => {
        throw new Error('must not spawn');
      }) as never,
    });
    const answer = await agent.chat({ userMessage: 'Who is Marc Demo?', sessionScope: 's-5' });
    assert.equal(answer.text, CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_EN);
    // The user learns why (shield required, CLI has none) and whom to ask.
    assert.match(answer.text, /Privacy Shield/);
    assert.match(answer.text, /subscription CLI/);
    assert.match(answer.text, /operator/);
    // The operator learns which switch did it and both ways out.
    assert.equal(warned.length, 1);
    assert.equal(warned[0]?.message, CLI_PRIVACY_SHIELD_REQUIRED_LOG);
    assert.match(CLI_PRIVACY_SHIELD_REQUIRED_LOG, /OMADIA_PRIVACY_FORCE_GUARDED/);
    assert.match(CLI_PRIVACY_SHIELD_REQUIRED_LOG, /API key/);
    assert.deepEqual(warned[0]?.meta, { sessionScope: 's-5' });
  });
});

describe('#1535 the policy reaches the model calls around the turn', () => {
  it('memory jobs refuse outside a turn without a guard under the policy', async () => {
    const forced = createJobPrivacy(() => undefined, { [PRIVACY_FORCE_GUARDED_ENV_VAR]: 'true' });
    const refused = await forced('inconsistency-detector' as never).mask('Marc Demo');
    assert.equal(refused.send, false);
    const open = createJobPrivacy(() => undefined, {});
    const sent = await open('inconsistency-detector' as never).mask('Marc Demo');
    assert.deepEqual(sent, { send: true, text: 'Marc Demo' }, 'unchanged without the policy');
  });

  it('the canvas skeleton is not composed by a model', async () => {
    let llmCalls = 0;
    const skeleton = await composeSkeleton({
      llm: {
        complete: async () => {
          llmCalls += 1;
          return { text: '{}' };
        },
      } as never,
      model: 'm',
      userText: 'Zeig mir Marc Demo',
      skipModel: true,
    });
    assert.equal(llmCalls, 0);
    assert.equal(skeleton.source, 'fallback');
  });
});
