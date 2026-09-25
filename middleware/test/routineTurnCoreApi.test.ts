import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ChatStreamEvent, IncomingTurn } from '@omadia/channel-sdk';
import type { RoutineTurnInput, RoutinesIntegration } from '@omadia/plugin-api';

import { createCoreApi } from '../src/channels/coreApi.js';
import type { CreateCoreApiOptions, RoutineTurnInfo } from '../src/channels/coreApi.js';
import { createCoreRoutineTurnScope } from '../src/plugins/routines/coreRoutineTurnScope.js';
import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';
import {
  ROUTINE_NO_CONTEXT_ERROR,
  type ManageRoutineContext,
} from '../src/plugins/routines/manageRoutineTool.js';

/**
 * #1086 — `manage_routine` worked only in Teams because the Teams adapter was
 * the only producer of the routines per-turn principal. These tests pin the
 * channel-agnostic producer in `CoreApi.handleTurnStream`:
 *
 *   - every channel gets a principal (the bug),
 *   - an adapter-installed context is never overwritten (the regression risk:
 *     Teams' `conversationRef` IS the delivery handle),
 *   - the scope exits when the stream ends (`run`, not `enterWith`),
 *   - `canTargetOthers` stays closed for every channel.
 */

const TENANT = 'acme';

/**
 * Production wiring shape: the scope reads/writes the real ALS, and `begin`
 * stands in for the once-per-turn work the kernel does there (the Conductor
 * channel binding). `seenInfos` therefore counts TURNS, not pulls.
 */
function realScope(seenInfos: RoutineTurnInfo[]): NonNullable<CreateCoreApiOptions['routineTurn']> {
  return {
    hasContextFor: (userId) => routineTurnContext.current()?.userId === userId,
    begin: (info) => {
      seenInfos.push(info);
      const ctx = {
        tenant: info.tenant ?? TENANT,
        userId: info.userId,
        channel: info.channel,
        conversationRef: info.conversationRef,
        canTargetOthers: false,
      };
      return (fn) => routineTurnContext.run(ctx, fn);
    },
  };
}

/**
 * A dispatcher that records what `manage_routine` would see — once when the
 * generator body starts, and once after it resumes from a yield. The second
 * sample is the one that matters: `run()` around the *call* would only cover
 * the synchronous construction of the iterator, not the resumption.
 */
function recordingDispatcher(seen: (ManageRoutineContext | undefined)[]): CreateCoreApiOptions['dispatcher'] {
  return {
    streamTurn(): AsyncIterable<ChatStreamEvent> {
      return (async function* () {
        seen.push(routineTurnContext.current());
        await Promise.resolve();
        yield { type: 'text_delta', text: 'a' } as ChatStreamEvent;
        seen.push(routineTurnContext.current());
        yield { type: 'text_delta', text: 'b' } as ChatStreamEvent;
      })();
    },
  };
}

function baseOptions(dispatcher: CreateCoreApiOptions['dispatcher']): CreateCoreApiOptions {
  return {
    dispatcher,
    routes: {
      register: () => undefined,
      registerRouter: () => undefined,
    } as unknown as CreateCoreApiOptions['routes'],
    log: () => undefined,
  };
}

// A fixture shape only: the shipped Telegram adapter calls the `chatAgent`
// capability directly and does not come through `handleTurnStream` at all.
function telegramTurn(overrides: Partial<IncomingTurn> = {}): IncomingTurn {
  return {
    channelId: 'de.byte5.channel.telegram',
    conversationId: 'chat-77',
    userRef: { kind: 'telegram-chat', id: 'tg-42', email: 'user@example.com' },
    text: 'welche Routinen habe ich?',
    ...overrides,
  };
}

async function drain(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe('CoreApi.handleTurnStream — #1086 channel-agnostic routine principal', () => {
  it('without the hook the stream is unchanged and no context is installed', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const api = createCoreApi(baseOptions(recordingDispatcher(seen)));

    const events = await drain(api.handleTurnStream(telegramTurn()));

    assert.equal(events.length, 2);
    assert.deepEqual(seen, [undefined, undefined]);
  });

  it('installs a principal for a non-Teams turn, for the whole turn', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const infos: RoutineTurnInfo[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope(infos),
    });

    await drain(api.handleTurnStream(telegramTurn()));

    assert.equal(seen.length, 2);
    // Both samples — body start AND post-yield resumption — see the context.
    for (const ctx of seen) {
      assert.ok(ctx, 'manage_routine would have refused this turn');
      assert.equal(ctx.tenant, TENANT);
      assert.equal(ctx.userId, 'tg-42');
      assert.equal(ctx.canTargetOthers, false);
    }
    // `channel` is the short binding type, so it matches what a channel plugin
    // registers its ProactiveSender under ('telegram', not the catalog id).
    assert.equal(seen[0]?.channel, 'telegram');
    assert.deepEqual(seen[0]?.conversationRef, {
      kind: 'channel',
      channelId: 'de.byte5.channel.telegram',
      conversationId: 'chat-77',
    });
    // The operator-addressable id rides along for the Conductor binding.
    assert.equal(infos[0]?.principalRef, 'user@example.com');
  });

  it('opens the turn ONCE, however many events the stream yields', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const infos: RoutineTurnInfo[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope(infos),
    });

    const events = await drain(api.handleTurnStream(telegramTurn()));

    // Two events, two pulls plus the terminating one — but one turn. The
    // once-per-turn work (a Postgres upsert for the Conductor binding) must
    // not ride along on every streamed delta.
    assert.equal(events.length, 2);
    assert.equal(infos.length, 1);
  });

  it('does not open a turn for a stream nobody reads', async () => {
    const infos: RoutineTurnInfo[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher([])),
      routineTurn: realScope(infos),
    });

    const stream = api.handleTurnStream(telegramTurn());
    await stream[Symbol.asyncIterator]().return?.(undefined);

    assert.equal(infos.length, 0);
  });

  it('resolves the channel through the kernel resolver, not the id alone', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope([]),
      // Mirrors the manifest-aware resolver the dispatcher uses: a plugin may
      // declare a channel_type that is NOT the last dotted segment of its id.
      channelTypeFor: (channelId) => (channelId.endsWith('.telegram') ? 'tg' : 'other'),
    });

    await drain(api.handleTurnStream(telegramTurn()));

    assert.equal(seen[0]?.channel, 'tg');
  });

  it('treats a blank tenantId as no tenant at all', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const infos: RoutineTurnInfo[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope(infos),
    });

    await drain(api.handleTurnStream(telegramTurn({ tenantId: '  ' })));

    assert.equal(infos[0]?.tenant, undefined); // the wiring's default applies
    assert.equal(seen[0]?.tenant, TENANT);
  });

  it('prefers the adapter-declared channelType and tenantId over the derived ones', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope([]),
    });

    await drain(
      api.handleTurnStream(telegramTurn({ channelType: 'tg-bot', tenantId: 'other-tenant' })),
    );

    assert.equal(seen[0]?.channel, 'tg-bot');
    assert.equal(seen[0]?.tenant, 'other-tenant');
  });

  it('does NOT overwrite a context the adapter installed for this same user', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope([]),
    });
    // What the Teams adapter installs before calling handleTurnStream. Its
    // conversationRef is the Bot Framework handle the proactive sender needs —
    // replacing it would create undeliverable routines.
    const teamsCtx: ManageRoutineContext = {
      tenant: 'aad-tenant',
      userId: 'tg-42',
      channel: 'teams',
      conversationRef: { serviceUrl: 'https://smba.trafficmanager.net/', conversation: { id: 'c1' } },
      canTargetOthers: true,
    };

    await routineTurnContext.run(teamsCtx, async () => {
      await drain(api.handleTurnStream(telegramTurn()));
    });

    for (const ctx of seen) assert.deepEqual(ctx, teamsCtx);
  });

  it('replaces a context that belongs to a DIFFERENT user (stale enterWith chain)', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope([]),
    });
    const staleCtx: ManageRoutineContext = {
      tenant: 'aad-tenant',
      userId: 'someone-else',
      channel: 'teams',
      conversationRef: { conversation: { id: 'previous-turn' } },
      canTargetOthers: true,
    };

    await routineTurnContext.run(staleCtx, async () => {
      await drain(api.handleTurnStream(telegramTurn()));
    });

    assert.equal(seen[0]?.userId, 'tg-42');
    assert.equal(seen[0]?.canTargetOthers, false);
  });

  it('installs nothing for a turn with no principal (the owner guard must keep passing)', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const infos: RoutineTurnInfo[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope(infos),
    });

    await drain(
      api.handleTurnStream(telegramTurn({ userRef: { kind: 'custom', id: '  ' } })),
    );

    // A context with a blank userId is worse than none: #1016's guard refuses
    // whenever a context is present whose (normalised) userId is not the
    // turn's, so it would throw on every loopback dispatch of that turn.
    assert.equal(infos.length, 0);
    assert.deepEqual(seen, [undefined, undefined]);
  });

  it('normalises the adapter-declared channelType and ignores a blank one', async () => {
    const upper: (ManageRoutineContext | undefined)[] = [];
    const blank: (ManageRoutineContext | undefined)[] = [];
    const apiUpper = createCoreApi({
      ...baseOptions(recordingDispatcher(upper)),
      routineTurn: realScope([]),
    });
    const apiBlank = createCoreApi({
      ...baseOptions(recordingDispatcher(blank)),
      routineTurn: realScope([]),
    });

    await drain(apiUpper.handleTurnStream(telegramTurn({ channelType: ' Teams ' })));
    await drain(apiBlank.handleTurnStream(telegramTurn({ channelType: '' })));

    // The sender registry is an exact-match Map, so ' Teams ' must not become
    // a key nothing is registered under, and '' must fall through.
    assert.equal(upper[0]?.channel, 'teams');
    assert.equal(blank[0]?.channel, 'telegram');
  });

  it('does not open a turn when the consumer throws into an unread stream', async () => {
    const infos: RoutineTurnInfo[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher([])),
      routineTurn: realScope(infos),
    });

    const it = api.handleTurnStream(telegramTurn())[Symbol.asyncIterator]();
    await assert.rejects(() => it.throw?.(new Error('client gone')) ?? Promise.resolve(), /client gone/);

    assert.equal(infos.length, 0);
  });

  it('hands out ONE iterator, so a second loop does not start a second turn', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const infos: RoutineTurnInfo[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope(infos),
    });

    const stream = api.handleTurnStream(telegramTurn());
    const first = await drain(stream);
    const second = await drain(stream);

    assert.equal(first.length, 2);
    assert.equal(second.length, 0); // exhausted, like the dispatcher's own generator
    assert.equal(infos.length, 1); // and no second orchestrator turn was opened
  });

  it('exits the scope when the turn ends — no leak onto the async chain', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope([]),
    });

    await drain(api.handleTurnStream(telegramTurn()));

    assert.equal(routineTurnContext.current(), undefined);
  });

  it('exits the scope when the consumer breaks out early', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope([]),
    });

    for await (const _event of api.handleTurnStream(telegramTurn())) break;

    assert.equal(routineTurnContext.current(), undefined);
    assert.equal(seen.length, 1);
  });

  it('stays closed after a close before the first pull — no late turn', async () => {
    const seen: (ManageRoutineContext | undefined)[] = [];
    const infos: RoutineTurnInfo[] = [];
    const api = createCoreApi({
      ...baseOptions(recordingDispatcher(seen)),
      routineTurn: realScope(infos),
    });

    const it = api.handleTurnStream(telegramTurn())[Symbol.asyncIterator]();
    await it.return?.(undefined);
    const after = await it.next();

    // An async generator closed before it started reports `done` from then on.
    // A late pull must not open the turn or start the model run it cancelled.
    assert.equal(after.done, true);
    assert.equal(infos.length, 0);
    assert.equal(seen.length, 0);
  });
});

describe('createCoreRoutineTurnScope — the kernel wiring of the #1086 producer', () => {
  function captureBegin(): { inputs: RoutineTurnInput[]; routines: Pick<RoutinesIntegration, 'beginRoutineTurn'> } {
    const inputs: RoutineTurnInput[] = [];
    return {
      inputs,
      routines: {
        beginRoutineTurn: (info) => {
          inputs.push(info);
          return (fn) => fn();
        },
      },
    };
  }

  const info: RoutineTurnInfo = {
    userId: 'key:abc',
    channel: 'api',
    conversationRef: { kind: 'channel', channelId: 'x', conversationId: 'y' },
  };

  it('falls back to the deployment tenant and keeps cold-start outreach closed', () => {
    const { inputs, routines } = captureBegin();
    createCoreRoutineTurnScope(routines, 'deploy-tenant').begin(info);

    assert.equal(inputs[0]?.tenant, 'deploy-tenant');
    assert.equal(inputs[0]?.userId, 'key:abc');
    assert.equal(inputs[0]?.canTargetOthers, false);
    assert.equal('principalRef' in (inputs[0] ?? {}), false);
  });

  it('keeps a channel-declared tenant and forwards principalRef', () => {
    const { inputs, routines } = captureBegin();
    createCoreRoutineTurnScope(routines, 'deploy-tenant').begin({
      ...info,
      tenant: 'canvas-tenant',
      principalRef: 'user@example.com',
    });

    assert.equal(inputs[0]?.tenant, 'canvas-tenant');
    assert.equal(inputs[0]?.principalRef, 'user@example.com');
    assert.equal(inputs[0]?.canTargetOthers, false);
  });

  it('treats only a context naming THIS user as the adapter-installed one', async () => {
    const scope = createCoreRoutineTurnScope(captureBegin().routines, 'deploy-tenant');
    const ctx = (userId: string): ManageRoutineContext => ({
      tenant: 'deploy-tenant',
      userId,
      channel: 'teams',
      conversationRef: {},
      canTargetOthers: false,
    });

    assert.equal(scope.hasContextFor('u-1'), false); // nothing installed
    await routineTurnContext.run(ctx(' u-1 '), async () => {
      assert.equal(scope.hasContextFor('u-1'), true); // trimmed on both sides
      assert.equal(scope.hasContextFor('u-2'), false); // stale, someone else's
    });
    await routineTurnContext.run(ctx('  '), async () => {
      assert.equal(scope.hasContextFor('  '), false); // a blank id is no principal
    });
  });
});

describe('ROUTINE_NO_CONTEXT_ERROR (#1086)', () => {
  it('is an honest tool error, not a call to an operator who has no lever', () => {
    // Channels that call the `chatAgent` capability directly still reach the
    // tool without a context. Nothing is misconfigured for them.
    assert.ok(ROUTINE_NO_CONTEXT_ERROR.startsWith('Error:'));
    assert.doesNotMatch(ROUTINE_NO_CONTEXT_ERROR, /wiring|operator/i);
    assert.match(ROUTINE_NO_CONTEXT_ERROR, /not available/);
    assert.match(ROUTINE_NO_CONTEXT_ERROR, /Routines page/);
    // The page lists, pauses, resumes and deletes — it cannot create. Sending
    // a user there to create a routine would be the next dishonest pointer.
    assert.match(ROUTINE_NO_CONTEXT_ERROR, /view, pause or delete/);
    assert.doesNotMatch(ROUTINE_NO_CONTEXT_ERROR, /Routines page instead/);
  });
});
