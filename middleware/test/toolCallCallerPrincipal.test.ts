/**
 * K1 (live E2E 2026-11-23, Discord and Telegram) — one principal per channel
 * user in a tool call.
 *
 * `NativeToolCallContext.callerPrincipalId` is documented as the lower-cased
 * channel user id (`user:<id>`), the same value as a stored message's
 * `author.principalId`. Discord, Slack and Telegram state the routing
 * principal of spec 2042 §5.3 on `TurnOrigin.principal`
 * (`user:discord-user:<id>`, `user:telegram-chat:<id>`, `user:<e-mail>`), and
 * the kernel copied it into the tool call. The facilitator then held the
 * initiator under one key and the same person's ballot under another: the
 * protocol named them twice and "everyone voted" never came.
 *
 * The caller principal is now derived from the channel user the turn names,
 * like the message author; the stated origin principal is only the fallback
 * for a turn without a channel user.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatTurnInput } from '@omadia/channel-sdk';
import { buildToolCallContext, conversationPrincipal } from '@omadia/orchestrator';

import { principalOfChannelUser } from '../src/channels/conversationMessages/wiring.js';

function turn(channelType: string, origin: Record<string, unknown>, extra: Record<string, unknown> = {}): ChatTurnInput {
  return {
    userMessage: 'start a vote',
    origin: {
      channelType,
      scope: { kind: 'conversation', conversationId: 'c-1' },
      conversationType: 'group',
      ...origin,
    },
    ...extra,
  } as ChatTurnInput;
}

describe('K1 — the caller of a tool call is the same principal as the author of a message', () => {
  const cases = [
    { channel: 'discord', kind: 'discord-user', id: '1574390000000000001', stated: 'discord-user:1574390000000000001' },
    { channel: 'telegram', kind: 'telegram-chat', id: '8123456789', stated: 'telegram-chat:8123456789' },
    { channel: 'slack', kind: 'slack-user', id: 'U07ABCDEF', stated: 'marcel@example.com' },
  ];

  for (const c of cases) {
    it(`${c.channel}: a stated routing principal does not replace the channel user id`, () => {
      const input = turn(
        c.channel,
        { principal: { kind: 'user', userId: c.stated }, speaker: { kind: c.kind, id: c.id } },
        { userId: c.id, channelIdentity: { channelKind: c.kind, channelUserId: c.id } },
      );
      const context = buildToolCallContext('nora-test', input);
      // One helper for both paths: the caller and the author of a message.
      assert.equal(principalOfChannelUser({ id: c.id }), conversationPrincipal(c.id));
      assert.equal(context.callerPrincipalId, principalOfChannelUser({ id: c.id }));
      assert.equal(context.callerPrincipalId, `user:${c.id.toLowerCase()}`);
    });
  }

  it('teams: the stated Entra object id principal and the channel user agree, as before', () => {
    const input = turn(
      'teams',
      { principal: { kind: 'user', userId: 'aad-marcel' }, speaker: { kind: 'teams-aad', id: 'AAD-Marcel' } },
      { userId: 'AAD-Marcel', channelIdentity: { channelKind: 'teams-aad', channelUserId: 'AAD-Marcel' } },
    );
    assert.equal(buildToolCallContext('mona-test', input).callerPrincipalId, 'user:aad-marcel');
    assert.equal(principalOfChannelUser({ id: 'AAD-Marcel' }), 'user:aad-marcel');
  });

  it('a turn without a channel user keeps the stated principal', () => {
    const input = turn('custom', { principal: { kind: 'user', userId: 'operator@example.com' } });
    assert.equal(buildToolCallContext('mona-test', input).callerPrincipalId, 'user:operator@example.com');
  });

  it('the speaker the channel named wins over the knowledge-graph user id of the turn', () => {
    const input = turn(
      'discord',
      { principal: { kind: 'user', userId: 'discord-user:42' }, speaker: { kind: 'discord-user', id: '42' } },
      { userId: 'kg-person-7' },
    );
    assert.equal(buildToolCallContext('nora-test', input).callerPrincipalId, 'user:42');
  });
});
