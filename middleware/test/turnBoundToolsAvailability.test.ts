/**
 * #1346 / #1086 — tools that need something only some channels put on the
 * turn are offered only where they can work.
 *
 *   - `discussion_start` / `discussion_partners` need a conversation the turn
 *     can name plus the bot that received it (today: a Teams chat). The web
 *     chat installs `{ kind: 'http-chat', … }` and `CoreApi.handleTurnStream`
 *     installs `{ kind: 'channel', … }`; neither can host a discussion, and the
 *     tools used to fail there with "this call did not come from one".
 *   - `manage_routine` needs a routines principal, which the web chat, every
 *     `CoreApi` channel and Teams install; a direct `chatAgent` caller does not.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ambientTurnFrom,
  createDiscussionsCapability,
  DiscussionNoConversationError,
} from '../src/conductor/discussionHere.js';
import {
  activate,
  discussionToolsAvailable,
  DISCUSSION_PARTNERS_TOOL_NAME,
  DISCUSSION_START_TOOL_NAME,
} from '@omadia/plugin-discussion';
import type { DiscussionsCapability } from '@omadia/plugin-discussion';
import type { ManageRoutineContext } from '../src/plugins/routines/manageRoutineTool.js';
import { isManageRoutineOffered } from '../src/plugins/routines/initRoutines.js';
import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';

const HR_BOT = '28:aaaaaaaa-1111-2222-3333-444444444444';

/** The three context shapes the kernel's producers install today. */
const teamsContext = {
  channel: 'teams',
  conversationRef: { conversation: { id: '19:chat@thread.v2' }, bot: { id: HR_BOT } },
};
const webChatContext = {
  channel: 'web',
  conversationRef: { kind: 'http-chat', sessionScope: 'chat-tab-1', sessionId: 's-1' },
};
const coreApiContext = {
  channel: 'api',
  conversationRef: { kind: 'channel', channelId: '@omadia/channel-api', conversationId: 'c-1' },
};

function capabilityFor(context: unknown) {
  return createDiscussionsCapability({
    discussions: { start: async () => Promise.reject(new Error('not reached')) } as never,
    resolveTurn: () => ambientTurnFrom(context as never),
    resolveOpener: (_channel, bot) => (bot === HR_BOT ? 'hr' : undefined),
    listPartners: async () => [],
  });
}

describe('#1346 — conductorDiscussions.availableHere', () => {
  it('is true on a Teams turn addressed to a provisioned bot', () => {
    assert.equal(capabilityFor(teamsContext).availableHere(), true);
  });

  it('is false in the web chat', () => {
    assert.equal(capabilityFor(webChatContext).availableHere(), false);
  });

  it('is false on a CoreApi channel turn (public API, canvas, …)', () => {
    assert.equal(capabilityFor(coreApiContext).availableHere(), false);
  });

  it('is false outside any turn', () => {
    assert.equal(capabilityFor(undefined).availableHere(), false);
  });

  it('is false when the receiving bot belongs to no agent', () => {
    const foreignBot = {
      ...teamsContext,
      conversationRef: { ...teamsContext.conversationRef, bot: { id: '28:someone-else' } },
    };
    assert.equal(capabilityFor(foreignBot).availableHere(), false);
  });

  it('a call that still arrives gets a truthful refusal, not "this call did not come from one"', async () => {
    await assert.rejects(
      () => capabilityFor(webChatContext).partnersHere(),
      (err: unknown) => {
        assert.ok(err instanceof DiscussionNoConversationError);
        assert.match(err.message, /not available in this chat/);
        assert.match(err.message, /Microsoft Teams/);
        assert.doesNotMatch(err.message, /did not come from one/);
        return true;
      },
    );
  });
});

describe('#1346 — the discussion plugin offers its tools only where they work', () => {
  const capability = (availableHere?: () => boolean): DiscussionsCapability => ({
    startHere: async () => Promise.reject(new Error('unused')),
    partnersHere: async () => [],
    ...(availableHere ? { availableHere } : {}),
  });

  it('follows the kernel capability', () => {
    assert.equal(discussionToolsAvailable(() => capability(() => true)), true);
    assert.equal(discussionToolsAvailable(() => capability(() => false)), false);
  });

  it('stays offered without the capability, so the handler can say "not on this deployment"', () => {
    assert.equal(discussionToolsAvailable(() => undefined), true);
  });

  it('stays offered on a kernel that predates availableHere', () => {
    assert.equal(discussionToolsAvailable(() => capability()), true);
  });

  it('registers BOTH tools with the per-turn predicate', async () => {
    const registered = new Map<string, { isAvailable?: () => boolean }>();
    let available = false;
    const ctx = {
      log: () => undefined,
      services: {
        getOptional: () => capability(() => available),
      },
      tools: {
        register: (spec: { name: string }, _handler: unknown, options?: { isAvailable?: () => boolean }) => {
          registered.set(spec.name, options ?? {});
          return () => undefined;
        },
      },
    };
    const handle = await activate(ctx as never);
    for (const name of [DISCUSSION_START_TOOL_NAME, DISCUSSION_PARTNERS_TOOL_NAME]) {
      const isAvailable = registered.get(name)?.isAvailable;
      assert.ok(isAvailable, `${name} must be registered with isAvailable`);
      available = false;
      assert.equal(isAvailable(), false, `${name} hidden where the turn cannot host a discussion`);
      available = true;
      assert.equal(isAvailable(), true, `${name} offered on a Teams turn`);
    }
    await handle.close();
  });
});

describe('#1086 — manage_routine is offered only on a turn with a routines principal', () => {
  const principal: ManageRoutineContext = {
    tenant: 'default',
    userId: 'u-1',
    channel: 'web',
    conversationRef: webChatContext.conversationRef,
    canTargetOthers: false,
  };

  it('is offered inside a turn that carries one (web chat, CoreApi channels, Teams)', async () => {
    const offered = await routineTurnContext.run(principal, async () => isManageRoutineOffered());
    assert.equal(offered, true);
  });

  it('is hidden on a turn without one (a direct chatAgent caller)', () => {
    assert.equal(isManageRoutineOffered(), false);
  });
});
