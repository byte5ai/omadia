import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';
import type {
  ChannelBindingResolver,
  ChatAgent,
} from '@omadia/channel-sdk';
import {
  CHANNEL_RESOLVER_SERVICE,
  CHAT_AGENT_SERVICE,
  resolveChatAgentForChannel,
} from '@omadia/channel-sdk';

/**
 * US7 — `resolveChatAgentForChannel` is the per-turn seam direct-agent channels
 * (Teams, Telegram) call so each conversation reaches the Agent the operator
 * bound to its (channelType, channelKey) instead of the shared singleton.
 */

function agent(tag: string): ChatAgent {
  return {
    chat: () => Promise.resolve({ text: tag }),
    async *chatStream() {
      await Promise.resolve();
    },
  } as unknown as ChatAgent;
}

/** Minimal PluginContext whose service registry is a plain key→value map. */
function ctxWith(services: Record<string, unknown>): PluginContext {
  return {
    services: { get: (key: string) => services[key] },
  } as unknown as PluginContext;
}

function resolver(
  result: ReturnType<ChannelBindingResolver['resolve']>,
  seen?: Array<[string, string]>,
): ChannelBindingResolver {
  return {
    resolve(channelType, channelKey) {
      seen?.push([channelType, channelKey]);
      return result;
    },
  };
}

describe('resolveChatAgentForChannel', () => {
  it('returns the bound Agent when the resolver matches a binding', () => {
    const bound = agent('bound');
    const ctx = ctxWith({
      [CHANNEL_RESOLVER_SERVICE]: resolver({ decision: 'bound', chatAgent: bound }),
      [CHAT_AGENT_SERVICE]: { agent: agent('singleton') },
    });
    assert.equal(resolveChatAgentForChannel(ctx, 'teams', 'c1'), bound);
  });

  it('returns the platform fallback Agent on a fallback decision', () => {
    const fallback = agent('fallback');
    const ctx = ctxWith({
      [CHANNEL_RESOLVER_SERVICE]: resolver({
        decision: 'fallback',
        chatAgent: fallback,
      }),
      [CHAT_AGENT_SERVICE]: { agent: agent('singleton') },
    });
    assert.equal(resolveChatAgentForChannel(ctx, 'teams', 'c1'), fallback);
  });

  it('degrades to the shared singleton when the resolver rejects', () => {
    const singleton = agent('singleton');
    const ctx = ctxWith({
      [CHANNEL_RESOLVER_SERVICE]: resolver({ decision: 'reject' }),
      [CHAT_AGENT_SERVICE]: { agent: singleton },
    });
    assert.equal(resolveChatAgentForChannel(ctx, 'teams', 'c1'), singleton);
  });

  it('degrades to the shared singleton when no resolver is published', () => {
    const singleton = agent('singleton');
    const ctx = ctxWith({ [CHAT_AGENT_SERVICE]: { agent: singleton } });
    assert.equal(resolveChatAgentForChannel(ctx, 'teams', 'c1'), singleton);
  });

  it('passes the exact (channelType, channelKey) through to the resolver', () => {
    const seen: Array<[string, string]> = [];
    const ctx = ctxWith({
      [CHANNEL_RESOLVER_SERVICE]: resolver(
        { decision: 'bound', chatAgent: agent('b') },
        seen,
      ),
    });
    resolveChatAgentForChannel(ctx, 'telegram', '@my_bot');
    assert.deepEqual(seen, [['telegram', '@my_bot']]);
  });

  it('returns undefined when neither a binding nor the singleton is available', () => {
    const ctx = ctxWith({});
    assert.equal(resolveChatAgentForChannel(ctx, 'teams', 'c1'), undefined);
  });
});
