/**
 * #2376 / ADR-0340 — a turn knows its clock time, not only its date.
 *
 *  - `turnClock()` freezes the date and the start instant from ONE reading.
 *  - `buildDateHeader` names `HH:mm`, the zone and its UTC offset.
 *  - Every read inside one turn (also after awaits and in sub-scopes) sees the
 *    same header.
 *  - The orchestrator's date block is the only block with the time, and it is
 *    never cached (ADR-0077).
 *
 * Orchestrator code is imported from SOURCE, not the built barrel.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';

import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import {
  buildOrchestratorForAgent,
  type OrchestratorDeps,
} from '../../packages/harness-orchestrator/src/buildOrchestrator.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  buildDateHeader,
  turnClock,
  turnContext,
} from '../../packages/harness-orchestrator/src/turnContext.js';

const TIME_RE = /Current date and time: \w+, \d{4}-\d\d-\d\d, \d\d:\d\d \(Europe\/Berlin, GMT[+-]\d\d:\d\d\)/;

describe('#2376 · buildDateHeader names the clock time and zone', () => {
  it('winter time: HH:mm and GMT+01:00', () => {
    const header = buildDateHeader('2026-11-27', new Date('2026-11-27T13:05:00Z'));
    assert.match(header, /^Current date and time: Friday, 2026-11-27, 14:05 \(Europe\/Berlin, GMT\+01:00\), taken at the start of this turn\./);
    assert.match(header, /never against your training cutoff/);
  });

  it('summer time: GMT+02:00', () => {
    const header = buildDateHeader('2026-07-01', new Date('2026-07-01T06:30:00Z'));
    assert.match(header, /Wednesday, 2026-07-01, 08:30 \(Europe\/Berlin, GMT\+02:00\)/);
  });

  it('without a start instant: the date only, still naming the zone', () => {
    const header = buildDateHeader('2026-11-27');
    assert.match(header, /^Today is Friday, 2026-11-27 \(Europe\/Berlin\)\./);
    assert.doesNotMatch(header, /\d\d:\d\d/);
  });
});

describe('#2376 · turnClock freezes date and time from one reading', () => {
  it('a turn starting just before midnight keeps the old day and its time', () => {
    const clock = turnClock(new Date('2026-11-27T22:59:59.900Z'));
    assert.equal(clock.turnDate, '2026-11-27');
    assert.match(buildDateHeader(clock.turnDate, new Date(clock.turnStartedAt)), /2026-11-27, 23:59/);
  });

  it('a turn starting at midnight is on the new day at 00:00', () => {
    const clock = turnClock(new Date('2026-11-27T23:00:00.000Z'));
    assert.equal(clock.turnDate, '2026-11-28');
    assert.match(buildDateHeader(clock.turnDate, new Date(clock.turnStartedAt)), /Saturday, 2026-11-28, 00:00/);
  });

  it('every read of one turn sees the same header, also after awaits and in sub-scopes', async () => {
    const clock = turnClock(new Date('2026-11-27T08:15:00Z'));
    const seen = await turnContext.run({ turnId: 't-2376', ...clock }, async () => {
      const first = turnContext.currentDateHeader();
      await delay(5);
      const later = turnContext.currentDateHeader();
      const nested = await turnContext.runWithChatParticipants(
        { list: async () => [] } as never,
        async () => turnContext.currentDateHeader(),
      );
      return [first, later, nested];
    });
    assert.equal(new Set(seen).size, 1, seen.join('\n'));
    assert.match(seen[0]!, /2026-11-27, 09:15 \(Europe\/Berlin, GMT\+01:00\)/);
  });

  it('outside a turn the header falls back to now and still names the time', () => {
    assert.match(turnContext.currentDateHeader(), TIME_RE);
  });

  it('a scope with a frozen date but no start instant names the date only', async () => {
    const header = await turnContext.run({ turnId: 't-dateonly', turnDate: '2026-11-26' }, async () =>
      turnContext.currentDateHeader(),
    );
    assert.match(header, /^Today is Thursday, 2026-11-26 \(Europe\/Berlin\)\./);
    assert.doesNotMatch(header, /\d\d:\d\d/);
  });
});

describe('#2376 · the orchestrator sends the time only in its uncached date block', () => {
  function capturingProvider(captured: LlmRequest[]): LlmProvider {
    const response = {
      content: [{ type: 'text', text: 'Antwort.' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as unknown as LlmResponse;
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
      complete: async (req: LlmRequest): Promise<LlmResponse> => {
        captured.push(req);
        return response;
      },
      stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => ({
        async *[Symbol.asyncIterator]() {
          captured.push(req);
          yield { type: 'text_delta', text: 'Antwort.' };
          yield { type: 'final', response };
        },
      }),
      classifyError: () => ({ retryable: false, kind: 'other' as const }),
    } as unknown as LlmProvider;
  }

  it('one uncached block carries the time; no cached block does', async () => {
    const captured: LlmRequest[] = [];
    const deps: OrchestratorDeps = {
      provider: capturingProvider(captured),
      knowledgeGraph: undefined as unknown as KnowledgeGraph,
      memoryStore: undefined as unknown as MemoryStore,
      entityRefBus: undefined as unknown as EntityRefBus,
      nativeToolRegistry: new NativeToolRegistry(),
      nudgeRegistry: new InMemoryNudgeRegistry(),
      responseGuard: () => undefined,
      privacyGuard: () => undefined,
    };
    const built = buildOrchestratorForAgent(
      { agentId: 'solo', model: 'test', maxTokens: 256, maxToolIterations: 2 },
      deps,
    );
    await built.orchestrator.chat({ userMessage: 'Wie spät ist es?' });
    assert.ok(captured.length > 0, 'provider never received a request');
    for (const req of captured) {
      assert.ok(Array.isArray(req.system), 'system is a block list');
      const blocks = req.system as ReadonlyArray<{ text?: string; cache?: boolean }>;
      const withTime = blocks.filter((b) => typeof b.text === 'string' && TIME_RE.test(b.text));
      assert.equal(withTime.length, 1, 'exactly one block names the time');
      assert.notEqual(withTime[0]!.cache, true, 'the date block is not cached');
      for (const b of blocks.filter((x) => x.cache === true)) {
        assert.doesNotMatch(b.text ?? '', /Current date and time/);
      }
    }
    const headers = captured.map(
      (req) => (req.system as ReadonlyArray<{ text?: string }>).find((b) => TIME_RE.test(b.text ?? ''))!.text,
    );
    assert.equal(new Set(headers).size, 1, 'every model call of the turn saw the same header');
  });
});
