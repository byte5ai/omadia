import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';
import type { ChannelBindingResolver, ChannelResolveResult } from '@omadia/channel-sdk';
import { CHANNEL_RESOLVER_SERVICE, resolveChannelRoute } from '@omadia/channel-sdk';

const ctxWith = (services: Record<string, unknown>): PluginContext =>
  ({ services: { get: (k: string) => services[k] } }) as unknown as PluginContext;

describe('resolveChannelRoute (#2055)', () => {
  it('hands back the whole result: decision, notice and speaker, with the route context', () => {
    const seen: unknown[] = [];
    const result = {
      decision: 'reject',
      notice: { code: 'agent_disabled', text: 'Mira is disabled.', locale: 'en' },
    } as unknown as ChannelResolveResult;
    const resolver: ChannelBindingResolver = {
      resolve: (type, key, context) => {
        seen.push([type, key, context]);
        return result;
      },
    };
    const got = resolveChannelRoute(ctxWith({ [CHANNEL_RESOLVER_SERVICE]: resolver }), 'slack', 'C1', {
      principal: 'user:slack-user:u1',
      locale: 'en',
    });
    assert.equal(got, result);
    assert.deepEqual(seen, [['slack', 'C1', { principal: 'user:slack-user:u1', locale: 'en' }]]);
  });

  it('is undefined without a resolver service', () => {
    assert.equal(resolveChannelRoute(ctxWith({}), 'slack', 'C1'), undefined);
  });
});
