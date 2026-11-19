/**
 * #2091 — 'conversationSend@2': every post, direct message, card update and
 * readiness check is drawn from an execution scope, and the scope (not a
 * message subscription) names the targets.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  AuthorizeActionRequest,
  ExecutionAuthorizationService,
  ExecutionRefusalCode,
  ExecutionScope,
  SendAuthorization,
} from '@omadia/plugin-api';

import { createConversationSendService } from '../src/channels/conversationSendService.js';
import { createScopedSendService } from '../src/channels/scopedSendService.js';

const ENGINE = '@omadia/agent-facilitator';
const HOME = { channelType: 'teams', conversationId: '19:offsite@thread.v2' };
const AUTH: SendAuthorization = { scopeId: 'scope-1', processId: 'fac-7', phase: 'active', purpose: 'moderation', emission: 'template' };
const SCOPE = { id: 'scope-1', agentSlug: 'mara', processId: 'fac-7' } as ExecutionScope;

function harness(options: { refuse?: ExecutionRefusalCode; channelFails?: boolean; directConversationId?: unknown; noDatabase?: boolean; scopes?: ExecutionScope[] } = {}) {
  const order: string[] = [];
  const authorized: AuthorizeActionRequest[] = [];
  const bound: unknown[] = [];
  const grounds: unknown[] = [];
  const execution = {
    listScopes: () => Promise.resolve(options.scopes ?? [SCOPE]),
    authorize: (request: AuthorizeActionRequest) => {
      order.push(`authorize(${request.action})`);
      authorized.push(request);
      return Promise.resolve(
        options.refuse
          ? { outcome: 'refused' as const, code: options.refuse, message: `refused: ${options.refuse}` }
          : { outcome: 'authorized' as const, authorizationId: 'auth-1', scopeId: request.scopeId, remaining: { actions: 1, modelCalls: 0 } },
      );
    },
  } as unknown as ExecutionAuthorizationService;
  const subscriptions = [{ id: 's1', processId: 'fac-7' }];
  const service = createScopedSendService({
    callerPluginId: ENGINE,
    execution: () => (options.noDatabase ? undefined : execution),
    conversation: {
      capabilities: () => ({ asOwnIdentity: true, mentions: true, poll: false }),
      sendToConversation: (_input: unknown, _plugin: unknown, ground: unknown) => {
        order.push('send');
        grounds.push(ground);
        return Promise.resolve(
          options.channelFails
            ? { outcome: 'unreachable', code: 'channel_error', message: 'Teams said 502' }
            : { outcome: 'delivered', messageId: 'bot-msg-1', cardMessageId: 'card-msg-1' },
        );
      },
      updateCard: (_input: unknown, _plugin: unknown, ground: unknown) => {
        order.push('updateCard');
        grounds.push(ground);
        return Promise.resolve({ outcome: 'updated' });
      },
    } as never,
    direct: (input, subs) => {
      order.push(`direct(${input.principal})`);
      grounds.push({ subscriptions: subs });
      return Promise.resolve(
        options.channelFails
          ? { outcome: 'unreachable', code: 'not_permitted', message: 'not a person of a conversation it moderates' }
          : ({ outcome: 'delivered', messageId: 'dm-1', ...(options.directConversationId !== undefined ? { conversationId: options.directConversationId } : {}) } as never),
      );
    },
    messages: {
      subscriptionsOfProcess: () => subscriptions as never,
      bindProcessMessage: (scope: unknown, plugin: string, ref: unknown) => {
        bound.push({ scope, plugin, ref });
        return Promise.resolve(true);
      },
    },
    readiness: () => {
      order.push('readiness');
      return Promise.resolve({ ready: false, installed: true, canReadAllMessages: false, canPost: true, missing: [{ code: 'rsc_missing', message: 'x' }] } as never);
    },
  });
  return { service, order, authorized, bound, grounds, subscriptions };
}

const post = { agentSlug: 'mara', ...HOME, message: { text: 'Three options are on the table.' }, authorization: AUTH };

describe('#2091 a post under a scope', () => {
  it('is authorized first, with the conversation as its target, then sent as the agent', async () => {
    const h = harness();
    const outcome = await h.service.sendToConversation(post);
    assert.deepEqual(outcome, { outcome: 'delivered', authorizationId: 'auth-1', messageId: 'bot-msg-1', cardMessageId: 'card-msg-1' });
    assert.deepEqual(h.order, ['authorize(post)', 'send']);
    assert.deepEqual(h.authorized, [
      { scopeId: 'scope-1', phase: 'active', purpose: 'moderation', action: 'post', target: { kind: 'conversation', ...HOME }, emission: 'template' },
    ]);
    // The permission came from the scope: the send is handed the process's
    // subscriptions (for mentions), not asked for a subscription of its own.
    assert.deepEqual(h.grounds, [{ subscriptions: h.subscriptions }]);
  });

  it('records which process the message and the card belong to', async () => {
    const h = harness();
    await h.service.sendToConversation({ ...post, message: { text: 'Vote', card: { cardId: 'vote-3' } as never } });
    const scope = { agentSlug: 'mara', ...HOME, processId: 'fac-7' };
    assert.deepEqual(h.bound, [
      { scope, plugin: ENGINE, ref: { messageId: 'bot-msg-1' } },
      { scope, plugin: ENGINE, ref: { messageId: 'card-msg-1' } },
      { scope, plugin: ENGINE, ref: { cardId: 'vote-3' } },
    ]);
  });

  for (const code of ['target_not_allowed', 'deadline_passed', 'budget_exhausted', 'kill_switch', 'scope_ended', 'phase_mismatch'] as const) {
    it(`sends nothing when the authorization refuses (${code})`, async () => {
      const h = harness({ refuse: code });
      const outcome = await h.service.sendToConversation(post);
      assert.deepEqual(outcome, { outcome: 'unreachable', code: 'not_authorized', message: `refused: ${code}`, executionCode: code });
      assert.deepEqual(h.order, ['authorize(post)']);
      assert.deepEqual(h.bound, []);
    });
  }

  it('the scope must be the named process\'s and the named agent\'s', async () => {
    for (const scopes of [[], [{ ...SCOPE, id: 'other' }], [{ ...SCOPE, agentSlug: 'finn' }]] as ExecutionScope[][]) {
      const h = harness({ scopes });
      const outcome = await h.service.sendToConversation(post);
      assert.equal(outcome.outcome === 'unreachable' && outcome.executionCode, 'unknown_scope');
      assert.deepEqual(h.order, []);
    }
  });

  it('a channel failure after the authorization says so and names the spent authorization', async () => {
    const h = harness({ channelFails: true });
    assert.deepEqual(await h.service.sendToConversation(post), {
      outcome: 'unreachable',
      code: 'channel_error',
      message: 'Teams said 502',
      authorizationId: 'auth-1',
    });
    assert.deepEqual(h.bound, []);
  });

  it('refuses without a database and with a malformed request, before anything is spent', async () => {
    const none = harness({ noDatabase: true });
    const outcome = await none.service.sendToConversation(post);
    assert.equal(outcome.outcome === 'unreachable' && outcome.executionCode, 'unavailable');
    const h = harness();
    for (const bad of [
      { ...post, authorization: { ...AUTH, emission: 'data' as never } },
      { ...post, authorization: { ...AUTH, scopeId: '' } },
      { ...post, authorization: undefined as never },
      { ...post, conversationId: '' },
      { ...post, agentSlug: '' },
    ]) {
      assert.equal((await h.service.sendToConversation(bad)).outcome, 'unreachable');
    }
    assert.deepEqual(h.order, []);
  });
});

describe('#2091 direct messages, card updates and readiness under a scope', () => {
  it('a direct message is authorized for the person and then checked against the process\'s conversations', async () => {
    const h = harness();
    const outcome = await h.service.sendToPerson({
      agentSlug: 'mara',
      channelType: 'teams',
      principal: 'user:aad-anna',
      message: { text: 'Reminder: your vote is open.' },
      authorization: { ...AUTH, purpose: 'reminder' },
    });
    assert.deepEqual(outcome, { outcome: 'delivered', authorizationId: 'auth-1', messageId: 'dm-1' });
    assert.deepEqual(h.authorized[0], {
      scopeId: 'scope-1',
      phase: 'active',
      purpose: 'reminder',
      action: 'direct_message',
      target: { kind: 'person', channelType: 'teams', principalId: 'aad-anna' },
      emission: 'template',
    });
    assert.deepEqual(h.order, ['authorize(direct_message)', 'direct(user:aad-anna)']);
    assert.deepEqual(h.grounds, [{ subscriptions: h.subscriptions }]);
  });

  it('a delivered direct message names the private conversation it went into, when the channel reports it', async () => {
    const send = { agentSlug: 'mara', channelType: 'teams', principal: 'user:aad-anna', message: { text: 'Reminder' }, authorization: AUTH };
    assert.deepEqual(await harness({ directConversationId: 'a:1on1-anna' }).service.sendToPerson(send), {
      outcome: 'delivered',
      authorizationId: 'auth-1',
      messageId: 'dm-1',
      conversationId: 'a:1on1-anna',
    });
    // A channel that reports something else than a usable id adds nothing.
    for (const junk of ['', '   ', 7, null]) {
      const outcome = await harness({ directConversationId: junk }).service.sendToPerson(send);
      assert.deepEqual(outcome, { outcome: 'delivered', authorizationId: 'auth-1', messageId: 'dm-1' });
    }
  });

  it('a person the kernel does not find in the process\'s conversations is not written to, although the scope listed them', async () => {
    const h = harness({ channelFails: true });
    const outcome = await h.service.sendToPerson({
      agentSlug: 'mara', channelType: 'teams', principal: 'user:stranger', message: { text: 'hi' }, authorization: AUTH,
    });
    assert.deepEqual(outcome, {
      outcome: 'unreachable',
      code: 'not_permitted',
      message: 'not a person of a conversation it moderates',
      authorizationId: 'auth-1',
    });
  });

  it('refuses a recipient that is not a user principal, and a refused authorization', async () => {
    const h = harness();
    const bad = await h.service.sendToPerson({ agentSlug: 'mara', channelType: 'teams', principal: 'role:hr', message: { text: 'x' }, authorization: AUTH });
    assert.equal(bad.outcome === 'unreachable' && bad.code, 'not_permitted');
    assert.deepEqual(h.order, []);
    const refused = harness({ refuse: 'target_not_allowed' });
    const outcome = await refused.service.sendToPerson({ agentSlug: 'mara', channelType: 'teams', principal: 'user:x', message: { text: 'x' }, authorization: AUTH });
    assert.equal(outcome.outcome === 'unreachable' && outcome.executionCode, 'target_not_allowed');
    assert.deepEqual(refused.order, ['authorize(direct_message)']);
  });

  it('a card update is an authorized action on the conversation', async () => {
    const h = harness();
    const outcome = await h.service.updateCard({ agentSlug: 'mara', ...HOME, cardMessageId: 'card-msg-1', update: { state: 'closed' } as never, authorization: AUTH });
    assert.deepEqual(outcome, { outcome: 'updated' });
    assert.equal(h.authorized[0]?.action, 'card_update');
    assert.deepEqual(h.order, ['authorize(card_update)', 'updateCard']);
  });

  it('readiness of one conversation is a check with its own purpose and no target', async () => {
    const h = harness();
    const outcome = await h.service.checkReadiness({
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: '19:meeting_about-to-be-linked@thread.v2',
      authorization: { scopeId: 'scope-1', processId: 'fac-7', phase: 'active' },
    });
    assert.equal(outcome.outcome, 'checked');
    assert.equal(outcome.outcome === 'checked' && outcome.report.canReadAllMessages, false);
    assert.deepEqual(h.authorized, [{ scopeId: 'scope-1', phase: 'active', purpose: 'readiness_check', action: 'check' }]);
    const refused = harness({ refuse: 'kill_switch' });
    const stopped = await refused.service.checkReadiness({ agentSlug: 'mara', ...HOME, authorization: { scopeId: 'scope-1', processId: 'fac-7', phase: 'active' } });
    assert.equal(stopped.outcome === 'unreachable' && stopped.executionCode, 'kill_switch');
    assert.deepEqual(refused.order, ['authorize(check)']);
  });
});

describe('#2091 the own-identity path under an established permission', () => {
  function sendService(identity: boolean) {
    const sent: { conversationId: string; asChannelKey?: string }[] = [];
    const service = createConversationSendService({
      providers: {
        get: () => ({
          supports: { asChannelKey: true, mentions: true },
          sendToConversation: (conversationId: string, _message: unknown, options: { asChannelKey?: string }) => {
            sent.push({ conversationId, ...options });
            return Promise.resolve({ outcome: 'delivered', messageId: 'm-9' });
          },
        }),
      } as never,
      ownIdentity: {
        identityFor: () => (identity ? { channelKey: '28:aaaa-mara' } : undefined),
        // No subscription at all: the first major would refuse.
        subscriptions: { subscriptionFor: () => undefined, subscriptionsOf: () => [], findAuthor: () => Promise.resolve(undefined) },
        archetypeAddsOwnIdentitySend: () => true,
      } as never,
    });
    return { service, sent };
  }
  const input = { agentSlug: 'mara', ...HOME, message: { text: 'The protocol.' }, asOwnIdentity: true };

  it('posts where the scope allows it although no message subscription exists (a closing scope after the release)', async () => {
    const { service, sent } = sendService(true);
    const without = await service.sendToConversation(input, ENGINE);
    assert.equal(without.outcome === 'unreachable' && without.code, 'not_permitted', 'the first major still asks for a subscription');
    const withGround = await service.sendToConversation(input, ENGINE, { subscriptions: [] });
    assert.equal(withGround.outcome, 'delivered');
    assert.deepEqual(sent, [{ conversationId: HOME.conversationId, asChannelKey: '28:aaaa-mara' }]);
  });

  it('still never posts through another bot: no identity is no_identity', async () => {
    const { service, sent } = sendService(false);
    const outcome = await service.sendToConversation(input, ENGINE, { subscriptions: [] });
    assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'no_identity');
    assert.deepEqual(sent, []);
  });
});
