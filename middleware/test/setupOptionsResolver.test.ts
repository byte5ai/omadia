/**
 * Spec 2042 §5.10 — a setup field's `options_provider` is answered by the
 * plugin's own tool registered with the kernel (capability plugin), and by
 * the retired agent runtime only for a plugin still running there.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { SetupOptionsResolveError } from '../src/plugins/dynamicAgentRuntime.js';
import { createSetupOptionsResolver } from '../src/plugins/setupOptionsResolver.js';

const options = [{ value: 'root-1', label: 'Wiki' }];
const tools = new Map([
  ['list_notion_roots', { agentId: '@omadia/integration-notion', handler: async () => JSON.stringify(options) }],
]);

describe('setup options resolver', () => {
  it('answers from the plugin’s registered tool, parsing its JSON text', async () => {
    const resolver = createSetupOptionsResolver({ tools });
    assert.deepEqual(await resolver.resolveSetupOptions('@omadia/integration-notion', 'list_notion_roots', {}), options);
  });

  it('never asks another plugin’s tool of the same name', async () => {
    const asked: string[] = [];
    const resolver = createSetupOptionsResolver({
      tools,
      agentRuntime: {
        resolveSetupOptions: async (pluginId) => {
          asked.push(pluginId);
          throw new SetupOptionsResolveError('agent_inactive', 'not active');
        },
      },
    });
    await assert.rejects(resolver.resolveSetupOptions('@acme/other', 'list_notion_roots', {}), SetupOptionsResolveError);
    assert.deepEqual(asked, ['@acme/other']);
  });

  it('falls back to the agent runtime for a plugin still running there', async () => {
    const resolver = createSetupOptionsResolver({
      tools: new Map(),
      agentRuntime: { resolveSetupOptions: async () => options },
    });
    assert.deepEqual(await resolver.resolveSetupOptions('@legacy/agent', 'list_things', {}), options);
  });

  it('says tool_not_found without either', async () => {
    const resolver = createSetupOptionsResolver({ tools: new Map() });
    await assert.rejects(
      resolver.resolveSetupOptions('@acme/x', 'nope', {}),
      (err: unknown) => err instanceof SetupOptionsResolveError && err.code === 'tool_not_found',
    );
  });
});
