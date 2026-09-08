/**
 * `createModelCatalogSync`: the live vendor list replaces a provider's seed
 * models in the catalog (and thus the registry overlay), and every failure
 * mode keeps the previous working set instead of emptying it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  clearExternalModels,
  LlmAdapterRegistryImpl,
  LlmProviderCatalog,
  resolveModelRef,
  type DiscoveredModel,
  type LlmAdapter,
  type LlmProviderDescriptor,
} from '@omadia/llm-provider';

import { createModelCatalogSync } from '../src/platform/modelCatalogSync.js';

const SEED: LlmProviderDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  wireFormat: 'anthropic',
  baseURL: 'https://api.anthropic.com',
  models: [
    {
      id: 'anthropic:claude-opus-4-8',
      provider: 'anthropic',
      modelId: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      class: 'frontier',
      maxTokens: 32_000,
      contextWindow: 200_000,
      vision: true,
      aliases: ['opus'],
    },
    {
      id: 'anthropic:claude-haiku-4-5-20251001',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      class: 'fast',
      maxTokens: 8_192,
      contextWindow: 200_000,
      vision: true,
      aliases: ['haiku'],
    },
  ],
  discovery: {
    include: ['^claude-'],
    classify: [
      { match: '^claude-opus-', class: 'frontier', aliases: ['opus'] },
      { match: '^claude-sonnet-', class: 'balanced', aliases: ['sonnet'] },
      { match: '^claude-haiku-', class: 'fast', aliases: ['haiku'] },
    ],
  },
};

function adapterListing(
  impl: () => Promise<ReadonlyArray<DiscoveredModel>>,
  calls: { count: number; lastApiKey?: string },
): LlmAdapter {
  return {
    wireFormat: 'anthropic',
    build: () => {
      throw new Error('not used');
    },
    listModels: async (opts) => {
      calls.count += 1;
      calls.lastApiKey = opts.apiKey;
      return impl();
    },
  };
}

let catalog: LlmProviderCatalog;
let adapters: LlmAdapterRegistryImpl;
const calls = { count: 0, lastApiKey: undefined as string | undefined };
const logs: string[] = [];
const warns: string[] = [];

beforeEach(() => {
  clearExternalModels();
  catalog = new LlmProviderCatalog();
  catalog.register(SEED);
  adapters = new LlmAdapterRegistryImpl();
  calls.count = 0;
  calls.lastApiKey = undefined;
  logs.length = 0;
  warns.length = 0;
});

afterEach(() => {
  catalog.clear();
  clearExternalModels();
});

function sync(getSecret: (k: string) => Promise<string | undefined> = async (k) =>
  k === 'provider:anthropic/api_key' ? 'sk-ant-test' : undefined) {
  return createModelCatalogSync({
    catalog,
    adapters,
    getSecret,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    now: () => new Date('2026-09-08T12:00:00Z'),
  });
}

test('a discovered generation replaces the seed: alias + class default move to the newest', async () => {
  adapters.register(
    adapterListing(
      async () => [
        { modelId: 'claude-opus-4-8', label: 'Claude Opus 4.8', createdAt: '2026-05-01T00:00:00Z' },
        { modelId: 'claude-opus-5', label: 'Claude Opus 5', createdAt: '2026-08-01T00:00:00Z', contextWindow: 1_000_000, maxTokens: 128_000, vision: true },
        { modelId: 'claude-sonnet-5', label: 'Claude Sonnet 5', vision: true },
        { modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', vision: true },
        { modelId: 'claude-embed-1' },
      ],
      calls,
    ),
  );
  assert.equal(resolveModelRef('opus')?.modelId, 'claude-opus-4-8', 'seed alias before sync');

  const result = await sync().refresh('anthropic');

  assert.equal(result.status, 'discovered');
  assert.equal(result.models, 4);
  assert.equal(calls.lastApiKey, 'sk-ant-test');
  assert.equal(resolveModelRef('opus')?.modelId, 'claude-opus-5');
  assert.equal(resolveModelRef('class:frontier')?.modelId, 'claude-opus-5');
  assert.equal(resolveModelRef('class:balanced')?.modelId, 'claude-sonnet-5');
  assert.equal(resolveModelRef('anthropic:claude-opus-4-8')?.class, 'frontier');
  const desc = catalog.get('anthropic');
  assert.equal(desc?.modelsSource, 'discovered');
  assert.equal(desc?.modelsDiscoveredAt, '2026-09-08T12:00:00.000Z');
  // seed caps survive for a model the vendor listed without caps
  assert.equal(resolveModelRef('haiku')?.maxTokens, 8_192);
  assert.deepEqual(result.dropped, [{ modelId: 'claude-embed-1', reason: 'unclassified' }]);
  assert.match(logs.join('\n'), /anthropic: 4 model\(s\) from 5 listed/);
});

test('no credentials → the seed stays and the vendor is never called', async () => {
  adapters.register(adapterListing(async () => [], calls));
  const result = await sync(async () => undefined).refresh('anthropic');
  assert.equal(result.status, 'no-credentials');
  assert.equal(calls.count, 0);
  assert.equal(resolveModelRef('opus')?.modelId, 'claude-opus-4-8');
  assert.equal(catalog.get('anthropic')?.modelsSource, undefined);
});

test('a failing vendor call keeps the previous set and reports the error', async () => {
  adapters.register(
    adapterListing(async () => {
      throw new Error('401 authentication_error');
    }, calls),
  );
  const result = await sync().refresh('anthropic');
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /401/);
  assert.equal(result.models, 2);
  assert.equal(resolveModelRef('opus')?.modelId, 'claude-opus-4-8');
  assert.match(warns.join('\n'), /keeping the current 2 model\(s\)/);
});

test('a list the rules reject entirely keeps the previous set (never an empty provider)', async () => {
  adapters.register(adapterListing(async () => [{ modelId: 'text-embedding-3' }], calls));
  const result = await sync().refresh('anthropic');
  assert.equal(result.status, 'empty');
  assert.equal(result.models, 2);
  assert.equal(resolveModelRef('haiku')?.modelId, 'claude-haiku-4-5-20251001');
});

test('a provider without discovery rules is left alone; unknown ids are reported', async () => {
  catalog.register({ ...SEED, id: 'static', models: SEED.models.map((m) => ({ ...m, id: `static:${m.modelId}`, provider: 'static', aliases: undefined })), discovery: undefined });
  adapters.register(adapterListing(async () => [{ modelId: 'claude-opus-5' }], calls));
  const s = sync();
  assert.equal((await s.refresh('static')).status, 'no-discovery-rules');
  assert.equal((await s.refresh('nope')).status, 'unknown-provider');
  assert.equal(calls.count, 0);
});

test('refreshAll covers every provider with rules and lastResult remembers the outcome', async () => {
  adapters.register(adapterListing(async () => [{ modelId: 'claude-opus-5', vision: true }, { modelId: 'claude-haiku-4-5-20251001' }], calls));
  const s = sync();
  const results = await s.refreshAll();
  assert.deepEqual(results.map((r) => [r.providerId, r.status]), [['anthropic', 'discovered']]);
  assert.equal(s.lastResult('anthropic')?.status, 'discovered');
  assert.equal(s.lastResult('openai'), undefined);
});

test('a registry-invalid discovered set (alias collision) is rejected and the seed restored', async () => {
  // A second provider already owns the `opus` alias → the anthropic discovery
  // result would collide; the catalog must roll back to the seed set.
  catalog.register({
    ...SEED,
    id: 'other',
    discovery: undefined,
    models: [{ ...SEED.models[0]!, id: 'other:claude-opus-4-8', provider: 'other', aliases: ['opus-other'] }],
  });
  // Make the seed alias unique first so the initial state is valid, then let
  // discovery hand `opus-other` to anthropic via a rule → collision.
  const colliding: LlmProviderDescriptor = {
    ...SEED,
    discovery: { classify: [{ match: '^claude-opus-', class: 'frontier', aliases: ['opus-other'] }] },
  };
  catalog.register(colliding);
  adapters.register(adapterListing(async () => [{ modelId: 'claude-opus-5' }], calls));
  const result = await sync().refresh('anthropic');
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /alias/);
  // previous (seed) set is back
  assert.equal(resolveModelRef('anthropic:claude-opus-4-8')?.modelId, 'claude-opus-4-8');
  assert.equal(catalog.get('anthropic')?.modelsSource, undefined);
});
