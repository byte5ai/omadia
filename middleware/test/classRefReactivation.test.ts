/**
 * #1083 — `createClassRefReactivator` wired into `createModelCatalogSync`: a
 * discovery run that moves what a class ref resolves to reactivates exactly
 * the active LLM plugins whose class ref now points at another model, so the
 * model they run (resolved once, at activation) matches the providers page.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  clearExternalModels,
  LlmAdapterRegistryImpl,
  LlmProviderCatalog,
  type DiscoveredModel,
  type LlmProviderDescriptor,
} from '@omadia/llm-provider';

import type { InstalledAgent } from '../src/plugins/installedRegistry.js';
import { createClassRefReactivator } from '../src/platform/classRefReactivation.js';
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
    },
  ],
  discovery: {
    include: ['^claude-'],
    classify: [
      { match: '^claude-opus-', class: 'frontier' },
      { match: '^claude-haiku-', class: 'fast' },
    ],
  },
};

const SAME_AS_SEED: DiscoveredModel[] = [
  { modelId: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];
/** A newer frontier generation: `class:frontier` moves, `class:fast` does not. */
const NEW_FRONTIER: DiscoveredModel[] = [
  { modelId: 'claude-opus-4-8', label: 'Claude Opus 4.8', createdAt: '2026-05-01T00:00:00Z' },
  { modelId: 'claude-opus-5', label: 'Claude Opus 5', createdAt: '2026-08-01T00:00:00Z' },
  { modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

type Entry = Pick<InstalledAgent, 'status' | 'config'>;

let catalog: LlmProviderCatalog;
let adapters: LlmAdapterRegistryImpl;
let listing: DiscoveredModel[];
let installed: Map<string, Entry>;
let reactivated: string[];
const warns: string[] = [];

beforeEach(() => {
  clearExternalModels();
  catalog = new LlmProviderCatalog();
  catalog.register(SEED);
  adapters = new LlmAdapterRegistryImpl();
  adapters.register({
    wireFormat: 'anthropic',
    build: () => {
      throw new Error('not used');
    },
    listModels: async () => listing,
  });
  listing = NEW_FRONTIER;
  reactivated = [];
  warns.length = 0;
  installed = new Map<string, Entry>([
    ['@omadia/orchestrator', { status: 'active', config: { orchestrator_model: 'class:frontier' } }],
    // a concrete id never moves with the catalog
    ['@omadia/verifier', { status: 'active', config: { verifier_model: 'claude-opus-4-8' } }],
    // follows `class:fast`, which this discovery does not move
    [
      '@omadia/orchestrator-extras',
      {
        status: 'active',
        config: { fact_extractor_model: 'class:fast', topic_classifier_model: 'class:fast' },
      },
    ],
  ]);
});

afterEach(() => {
  catalog.clear();
  clearExternalModels();
});

function setup(reactivate: (id: string) => Promise<void> = async (id) => {
  reactivated.push(id);
}) {
  const reactivator = createClassRefReactivator({
    installedRegistry: { get: (id) => installed.get(id) },
    reactivate,
    log: () => {},
    warn: (m) => warns.push(m),
  });
  const sync = createModelCatalogSync({
    catalog,
    adapters,
    getSecret: async (k) => (k === 'provider:anthropic/api_key' ? 'sk-ant-test' : undefined),
    log: () => {},
    warn: (m) => warns.push(m),
    beforeModelsSwap: (id) => reactivator.beforeModelsSwap(id),
  });
  return { reactivator, sync };
}

async function live() {
  const s = setup();
  s.reactivator.activationStarting();
  await s.reactivator.activationFinished();
  return s;
}

test('a discovery run that moves class:frontier reactivates only the plugin following it', async () => {
  const { sync } = await live();
  const result = await sync.refresh('anthropic');
  assert.equal(result.status, 'discovered');
  assert.deepEqual(reactivated, ['@omadia/orchestrator']);
});

test('a discovery run that resolves every class ref to the same model reactivates nothing', async () => {
  listing = SAME_AS_SEED;
  const { sync } = await live();
  assert.equal((await sync.refresh('anthropic')).status, 'discovered');
  assert.deepEqual(reactivated, []);
});

test('plugins on another provider and inactive plugins are left alone', async () => {
  installed.set('@omadia/verifier', {
    status: 'active',
    config: { llm_provider: 'openai', verifier_model: 'class:frontier' },
  });
  installed.set('@omadia/orchestrator', {
    status: 'inactive',
    config: { orchestrator_model: 'class:frontier' },
  });
  const { sync } = await live();
  await sync.refresh('anthropic');
  assert.deepEqual(reactivated, []);
});

test('boot: a run before activation starts changes nothing running; one during activation is replayed after it', async () => {
  const { reactivator, sync } = setup();
  await sync.refresh('anthropic');
  assert.deepEqual(reactivated, [], 'plugins activate against the discovered catalog');

  catalog.register(SEED);
  reactivator.activationStarting();
  await sync.refresh('anthropic');
  assert.deepEqual(reactivated, [], 'never reactivates concurrently with the boot loop');
  await reactivator.activationFinished();
  assert.deepEqual(reactivated, ['@omadia/orchestrator']);
});

test('a failing reactivation is logged and never fails the sync', async () => {
  const { reactivator, sync } = setup(async () => {
    throw new Error('boom');
  });
  reactivator.activationStarting();
  await reactivator.activationFinished();
  const result = await sync.refresh('anthropic');
  assert.equal(result.status, 'discovered');
  assert.ok(warns.some((w) => w.includes('@omadia/orchestrator') && w.includes('boom')), warns.join('\n'));
});
