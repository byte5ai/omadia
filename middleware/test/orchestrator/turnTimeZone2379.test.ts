/**
 * #2379 / ADR-0350 — a chat turn reads its date and clock time in the
 * speaker's zone when the channel reported a valid one, else in
 * `TURN_TIME_ZONE`.
 *
 *  - `turnClock(at, zone)` freezes date, start instant AND zone from one
 *    reading; the date is the date in that zone.
 *  - An unknown, malformed or absent zone falls back to `TURN_TIME_ZONE`.
 *  - The header names the zone; every model call of one turn sees the same
 *    header (also in sub-scopes), and no cached block carries it (ADR-0077).
 *
 * Orchestrator code is imported from SOURCE, not the built barrel.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import {
  buildOrchestratorForAgent,
  type OrchestratorDeps,
} from '../../packages/harness-orchestrator/src/buildOrchestrator.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  TURN_TIME_ZONE,
  buildDateHeader,
  isTurnTimeZone,
  resolveTurnTimeZone,
  today,
  turnClock,
  turnContext,
} from '../../packages/harness-orchestrator/src/turnContext.js';

describe('#2379 · resolveTurnTimeZone falls back safely', () => {
  it('keeps a valid IANA zone', () => {
    assert.equal(resolveTurnTimeZone('America/New_York'), 'America/New_York');
    assert.equal(resolveTurnTimeZone('UTC'), 'UTC');
  });

  for (const bad of [undefined, null, '', 'Mars/Olympus_Mons', 'Europe/Berlin\n', '../../etc/passwd', 'x'.repeat(65)]) {
    it(`falls back to TURN_TIME_ZONE for ${JSON.stringify(bad)?.slice(0, 30)}`, () => {
      assert.equal(resolveTurnTimeZone(bad), TURN_TIME_ZONE);
      assert.equal(isTurnTimeZone(bad), false);
    });
  }

  it('a non-string never counts as a zone', () => {
    assert.equal(isTurnTimeZone(42), false);
    assert.equal(isTurnTimeZone({}), false);
  });
});

describe('#2379 · turnClock reads the date in the frozen zone', () => {
  it('New York evening is still the previous day', () => {
    const clock = turnClock(new Date('2026-11-28T03:30:00Z'), 'America/New_York');
    assert.deepEqual(clock, {
      turnDate: '2026-11-27',
      turnStartedAt: '2026-11-28T03:30:00.000Z',
      turnTimeZone: 'America/New_York',
    });
    assert.match(
      buildDateHeader(clock.turnDate, new Date(clock.turnStartedAt), clock.turnTimeZone),
      /^Current date and time: Friday, 2026-11-27, 22:30 \(America\/New_York, GMT-05:00\), taken at the start of this turn\./,
    );
  });

  it('an invalid zone freezes TURN_TIME_ZONE, not the bad value', () => {
    const clock = turnClock(new Date('2026-11-28T03:30:00Z'), 'Not/AZone');
    assert.equal(clock.turnTimeZone, TURN_TIME_ZONE);
    assert.equal(clock.turnDate, '2026-11-28');
  });

  it('no zone keeps the instance default (ADR-0340 behaviour)', () => {
    assert.equal(turnClock(new Date('2026-11-27T12:00:00Z')).turnTimeZone, 'Europe/Berlin');
  });

  it('a zone east of UTC+12 names the right weekday', () => {
    const clock = turnClock(new Date('2026-11-27T11:00:00Z'), 'Pacific/Kiritimati');
    assert.equal(clock.turnDate, '2026-11-28');
    assert.match(
      buildDateHeader(clock.turnDate, new Date(clock.turnStartedAt), clock.turnTimeZone),
      /Saturday, 2026-11-28, 01:00 \(Pacific\/Kiritimati, GMT\+14:00\)/,
    );
  });

  it('today() at Berlin midnight is the Berlin date, not the UTC date', () => {
    // 00:30 Berlin on 28 Nov = 23:30 UTC on 27 Nov.
    assert.equal(today(new Date('2026-11-27T23:30:00Z')), '2026-11-28');
    assert.equal(today(new Date('2026-11-27T23:30:00Z'), 'UTC'), '2026-11-27');
  });
});

describe('#2379 · one turn, one zone', () => {
  it('every read of one turn names the frozen zone, also in sub-scopes', async () => {
    const clock = turnClock(new Date('2026-11-27T08:15:00Z'), 'Asia/Tokyo');
    const seen = await turnContext.run({ turnId: 't-2379', ...clock }, async () => {
      const first = turnContext.currentDateHeader();
      const nested = await turnContext.runWithChatParticipants(
        { list: async () => [] } as never,
        async () => [turnContext.currentDateHeader(), turnContext.currentTurnTimeZone()],
      );
      return [first, ...nested];
    });
    assert.equal(seen[0], seen[1]);
    assert.equal(seen[2], 'Asia/Tokyo');
    assert.match(seen[0]!, /2026-11-27, 17:15 \(Asia\/Tokyo, GMT\+09:00\)/);
  });

  it('a scope that stored an invalid zone reads TURN_TIME_ZONE', async () => {
    const zone = await turnContext.run(
      { turnId: 't-bad', turnDate: '2026-11-27', turnTimeZone: 'Bogus/Zone' },
      async () => [turnContext.currentTurnTimeZone(), turnContext.currentDateHeader()],
    );
    assert.equal(zone[0], TURN_TIME_ZONE);
    assert.match(zone[1]!, /\(Europe\/Berlin\)/);
  });
});

describe('#2379 · the orchestrator freezes the speaker\'s zone', () => {
  function capturingProvider(captured: LlmRequest[]): LlmProvider {
    const response = {
      content: [{ type: 'text', text: 'Answer.' }],
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
          yield { type: 'text_delta', text: 'Answer.' };
          yield { type: 'final', response };
        },
      }),
      classifyError: () => ({ retryable: false, kind: 'other' as const }),
    } as unknown as LlmProvider;
  }

  function build(captured: LlmRequest[]) {
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
    return buildOrchestratorForAgent(
      { agentId: 'solo', model: 'test', maxTokens: 256, maxToolIterations: 2 },
      deps,
    ).orchestrator;
  }

  function headersOf(captured: LlmRequest[]): string[] {
    const out: string[] = [];
    for (const req of captured) {
      const blocks = req.system as ReadonlyArray<{ text?: string; cache?: boolean }>;
      for (const b of blocks) {
        if (b.cache === true) assert.doesNotMatch(b.text ?? '', /Current date and time|America\/New_York/);
        if (/Current date and time/.test(b.text ?? '')) out.push(b.text!);
      }
    }
    return out;
  }

  it('chat(): the uncached header names the speaker\'s zone', async () => {
    const captured: LlmRequest[] = [];
    await build(captured).chat({ userMessage: 'What time is it?', userTimeZone: 'America/New_York' });
    const headers = headersOf(captured);
    assert.ok(headers.length > 0);
    assert.equal(new Set(headers).size, 1, 'every model call of the turn saw the same header');
    assert.match(headers[0]!, /\(America\/New_York, GMT-0[45]:00\)/);
  });

  it('chatStream(): the same, and an invalid zone falls back to Europe/Berlin', async () => {
    const captured: LlmRequest[] = [];
    const orchestrator = build(captured);
    for await (const _ of orchestrator.chatStream({ userMessage: 'Time?', userTimeZone: 'America/New_York' })) {
      /* drain */
    }
    assert.match(headersOf(captured)[0]!, /\(America\/New_York, GMT-0[45]:00\)/);

    const bad: LlmRequest[] = [];
    await build(bad).chat({ userMessage: 'Time?', userTimeZone: 'Nowhere/Land' });
    assert.match(headersOf(bad)[0]!, /\(Europe\/Berlin, GMT\+0[12]:00\)/);
  });
});
