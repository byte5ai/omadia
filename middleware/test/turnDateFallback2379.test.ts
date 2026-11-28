/**
 * #2379 — kernel sites that open a scope outside a turn date it in the turn
 * zone (`today()`), not in UTC, and carry the turn's frozen zone along.
 *
 *  - `ctx.mcp.callTool` inside a turn keeps the turn's clock and zone.
 *  - A consultation hands the asker's user zone to the colleague's turn.
 *  - The web chat reads the browser's zone from the `omadia-tz` cookie, valid
 *    IANA zones only.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Request } from 'express';
import type { ChatTurnInput, SemanticAnswer } from '@omadia/channel-sdk';
import {
  currentConsultation,
  readersOf,
  turnClock,
  turnContext,
  unionLabels,
  type TurnContextValue,
} from '@omadia/orchestrator';

import { createPluginMcpAccessor } from '../src/platform/pluginContext.js';
import {
  createConsultationBroker,
  type ConsultRegistryEntry,
} from '../src/consultation/consultationBroker.js';
import { webTurnTimeZone } from '../src/routes/chat.js';

const SERVER_ID = '00000000-0000-4000-8000-0000000000aa';

function mcpRegistry(seen: Array<TurnContextValue | undefined>) {
  const service = {
    listServers: async () => [
      { id: SERVER_ID, name: 'billing', transport: 'http', endpoint: 'http://x/mcp', headers: {}, status: 'enabled' },
    ],
    listGrantedServerIds: async () => [SERVER_ID],
    listTools: async () => [],
    callTool: async (): Promise<string> => {
      seen.push(turnContext.current());
      return 'ok';
    },
  };
  return { get: <T>(name: string) => (name === 'mcp' ? (service as T) : undefined) };
}

describe('#2379 · ctx.mcp carries the turn clock and zone', () => {
  it('inside a turn it keeps the turn\'s frozen clock and zone', async () => {
    const seen: Array<TurnContextValue | undefined> = [];
    const clock = turnClock(new Date('2026-11-28T03:30:00Z'), 'America/New_York');
    await turnContext.run({ turnId: 't-1', ...clock }, () =>
      createPluginMcpAccessor('@x/p', mcpRegistry(seen)).callTool(SERVER_ID, 'sum', {}),
    );
    assert.equal(seen[0]?.turnDate, '2026-11-27');
    assert.equal(seen[0]?.turnStartedAt, clock.turnStartedAt);
    assert.equal(seen[0]?.turnTimeZone, 'America/New_York');
  });
});

describe('#2379 · a consultation runs in the asker\'s user zone', () => {
  it('the colleague\'s turn input carries the user zone and the parent date', async () => {
    const inputs: ChatTurnInput[] = [];
    const dates: string[] = [];
    const entry = (id: string, slug: string): ConsultRegistryEntry => ({
      agent: { id, slug, name: slug, identityLanguage: 'en' },
      plugins: [],
      built: {
        bundle: {
          agent: {
            async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
              inputs.push(input);
              dates.push(turnContext.currentTurnDate());
              const scope = currentConsultation();
              if (scope) {
                scope.result.labels = unionLabels([]);
                scope.result.wireAnswer = 'ok';
                scope.result.shielded = true;
              }
              return { text: 'ok' } as SemanticAnswer;
            },
          },
        },
      },
    } as unknown as ConsultRegistryEntry);
    const registry = new Map([
      ['anna', entry('a', 'anna')],
      ['ben', entry('b', 'ben')],
    ]);
    const broker = createConsultationBroker({
      store: {
        getSwitches: async () => ({ consultable: true, mayConsult: true }),
        getGrant: async () =>
          ({
            fromAgentId: 'a',
            toAgentId: 'b',
            channelScope: null,
            allowedCapabilities: [],
            memoryAccess: 'none',
            disclosure: {},
            maxCallsPerTurn: 2,
            maxCallsPerDay: 50,
            createdBy: 'op',
            createdAt: new Date(),
            updatedBy: null,
            updatedAt: new Date(),
          }) as never,
        startCall: async () => true,
        finishCall: async () => undefined,
        listActivePairs: async () => [{ fromSlug: 'anna', toSlug: 'ben' }],
      },
      getRegistry: () => registry,
    });
    const readers = readersOf(['u-1']);
    const outcome = await turnContext.run(
      {
        turnId: 'turn-1',
        ...turnClock(new Date('2026-11-28T03:30:00Z'), 'America/New_York'),
        userTimeZone: 'America/New_York',
        audienceFloor: async () => ({ capabilities: new Set<string>() }) as never,
      },
      () =>
        broker.consult({
          fromAgentSlug: 'anna',
          fromTurnId: 'turn-1',
          toAgentSlug: 'ben',
          request: 'Thoughts?',
          callsThisTurn: 0,
          sequence: 1,
          labels: unionLabels([]),
          contextKey: 'web:x',
          readers,
        }),
    );
    assert.equal(outcome.kind, 'answered');
    assert.equal(inputs[0]?.userTimeZone, 'America/New_York');
    assert.equal(dates[0], '2026-11-27');
  });
});

describe('#2379 · the web chat reads the browser zone from its cookie', () => {
  const req = (cookies: Record<string, unknown> | undefined) => ({ cookies }) as unknown as Request;

  it('a valid zone becomes userTimeZone', () => {
    assert.deepEqual(webTurnTimeZone(req({ 'omadia-tz': 'America/New_York' })), {
      userTimeZone: 'America/New_York',
    });
  });

  it('a missing, invalid or non-string cookie yields nothing', () => {
    assert.deepEqual(webTurnTimeZone(req(undefined)), {});
    assert.deepEqual(webTurnTimeZone(req({})), {});
    assert.deepEqual(webTurnTimeZone(req({ 'omadia-tz': 'Nowhere/Land' })), {});
    assert.deepEqual(webTurnTimeZone(req({ 'omadia-tz': 'Europe/Berlin; x=1' })), {});
    assert.deepEqual(webTurnTimeZone(req({ 'omadia-tz': ['Europe/Berlin'] })), {});
  });
});
