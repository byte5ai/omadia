import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { listCatalogToolsTool } from '../../../src/plugins/builder/tools/listCatalogTools.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

describe('listCatalogToolsTool', () => {
  let harness: BuilderToolHarness;

  afterEach(async () => {
    if (harness) await harness.dispose();
  });

  it('returns the injected catalog names sorted', async () => {
    harness = await createBuilderToolHarness({
      catalogToolNames: ['query_memory', 'chat_agent', 'verifier'],
    });
    const result = await listCatalogToolsTool.run({}, harness.context());
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools, ['chat_agent', 'query_memory', 'verifier']);
  });

  it('returns empty array when no catalog names are registered', async () => {
    harness = await createBuilderToolHarness();
    const result = await listCatalogToolsTool.run({}, harness.context());
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools, []);
  });
});
