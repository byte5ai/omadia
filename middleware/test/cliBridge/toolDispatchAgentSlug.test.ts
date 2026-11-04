/**
 * The CLI runtime opens no orchestrator turn scope, so the dispatcher is what
 * tells a tool (`manage_routine` on a channel turn) which Agent it serves.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';

import { currentDispatchCaller } from '../../packages/harness-orchestrator/src/toolCallerContext.js';
import { ToolDispatchService } from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import type { ToolDispatchCallerContext } from '../../packages/harness-orchestrator/src/toolDispatchService.js';

function probe(agentSlug?: string) {
  const nativeTools = new NativeToolRegistry();
  const seen: { caller?: ToolDispatchCallerContext } = {};
  nativeTools.register('whoami', {
    handler: async () => {
      seen.caller = currentDispatchCaller();
      return 'ok';
    },
    spec: { name: 'whoami', description: 'd', input_schema: { type: 'object', properties: {} } },
    domain: 'test.x',
  });
  const service = new ToolDispatchService({
    nativeTools,
    domainTools: [],
    ...(agentSlug !== undefined ? { agentSlug } : {}),
  });
  return { service, seen };
}

describe('ToolDispatchService — the Agent a dispatcher serves', () => {
  it('publishes its slug to the handler', async () => {
    const { service, seen } = probe('sales');
    await service.dispatch('whoami', {});
    assert.equal(seen.caller?.agentSlug, 'sales');
  });

  it('keeps the identity the entry point supplied', async () => {
    const { service, seen } = probe('sales');
    await service.dispatch('whoami', {}, { caller: { principal: 'apikey_1' } });
    assert.deepEqual(seen.caller, { principal: 'apikey_1', agentSlug: 'sales' });
  });

  it('leaves the store empty for a dispatcher with no Agent', async () => {
    const { service, seen } = probe();
    await service.dispatch('whoami', {});
    assert.equal(seen.caller, undefined);
  });
});
