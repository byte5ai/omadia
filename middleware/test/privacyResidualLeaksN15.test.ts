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
import { PRIVACY_FORCE_GUARDED_ENV_VAR } from '@omadia/plugin-api';

import {
  CliChatAgent,
  CLI_PRIVACY_SHIELD_REQUIRED_ANSWER,
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

function orchestrator(calls: { n: number }): Orchestrator {
  return new Orchestrator({
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
    const result = await orchestrator(calls).runTurn({
      userMessage: 'Wer ist Marc Demo?',
      sessionScope: 's-1',
    });
    assert.equal(calls.n, 0, 'no model call');
    assert.equal(result.answer, PRIVACY_SHIELD_REQUIRED_ANSWER);
    assert.ok(isPromptMaskBlockedNotice(result.answer), 'the verifier treats it as a refusal');
  });

  it('refuses a streamed turn the same way', async () => {
    process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = 'true';
    const calls = { n: 0 };
    const events = [];
    for await (const event of orchestrator(calls).chatStream({
      userMessage: 'Wer ist Marc Demo?',
      sessionScope: 's-2',
    })) {
      events.push(event);
    }
    assert.equal(calls.n, 0, 'no model call');
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    // Delivered in the turn's language, with the AI disclosure folded in.
    assert.match(done.answer, /Datenschutz-Schild, er läuft aber gerade nicht/);
  });

  it('runs the turn as before without the policy', async () => {
    delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
    const calls = { n: 0 };
    const result = await orchestrator(calls).runTurn({
      userMessage: 'Hallo',
      sessionScope: 's-3',
    });
    assert.equal(calls.n, 1);
    assert.match(result.answer, /Marc Demo/);
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
    assert.equal(answer.text, CLI_PRIVACY_SHIELD_REQUIRED_ANSWER);
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
});
