/**
 * Spec 2042 §5.10 — a setup field's `options_provider` is answered by the
 * plugin's own tool registered with the kernel.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createSetupOptionsResolver, SetupOptionsResolveError } from '../src/plugins/setupOptionsResolver.js';

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
    const resolver = createSetupOptionsResolver({ tools });
    await assert.rejects(
      resolver.resolveSetupOptions('@acme/other', 'list_notion_roots', {}),
      (err: unknown) => err instanceof SetupOptionsResolveError && err.code === 'tool_not_found',
    );
  });

  it('says tool_not_found for a tool no plugin registered', async () => {
    const resolver = createSetupOptionsResolver({ tools: new Map() });
    await assert.rejects(
      resolver.resolveSetupOptions('@acme/x', 'nope', {}),
      (err: unknown) => err instanceof SetupOptionsResolveError && err.code === 'tool_not_found',
    );
  });
});
