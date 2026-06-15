/**
 * Regression for the runtime provider-plugin registration gap: a provider
 * plugin installed AFTER boot must land in the catalog AND the global model
 * registry — the data the admin Providers page derives its list from
 * (`adminProviders` builds providers from `listModels()`) — without a restart,
 * and must disappear again on uninstall.
 *
 * Before the fix, `llm_provider` blocks were only registered by a boot-time
 * loop; a plugin installed at runtime (e.g. MiniMax) activated as a tool
 * extension but never contributed its provider, so it was missing from the
 * admin page until the next middleware restart.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { LlmProviderCatalog, listModelsByProvider } from '@omadia/llm-provider';

import {
  registerPluginLlmProvider,
  unregisterPluginLlmProvider,
} from '../src/platform/llmProviderManifest.js';

// A minimal MiniMax-shaped manifest with an `llm_provider` block in the exact
// snake_case shape a plugin ships — and `kind: extension`, mirroring how the
// real MiniMax plugin is published. A unique provider id keeps the global model
// overlay clean across the suite.
const MINIMAX_MANIFEST = {
  kind: 'extension',
  llm_provider: {
    id: 'minimax-test',
    label: 'MiniMax (test)',
    wire_format: 'openai-compatible',
    default_base_url: 'https://api.minimax.io/v1',
    base_url_config_key: 'minimax_base_url',
    quirks: {
      max_tokens_field: 'max_completion_tokens',
      drop_tool_choice: true,
    },
    models: [
      {
        id: 'minimax-test:MiniMax-Text-01',
        model_id: 'MiniMax-Text-01',
        label: 'MiniMax Text 01',
        class: 'frontier',
        class_default: true,
        max_tokens: 8192,
        context_window: 1_000_000,
        vision: false,
      },
    ],
  },
};

const catalog = new LlmProviderCatalog();
afterEach(() => catalog.clear());

test('registers a runtime-installed provider + its models (admin-page path)', () => {
  const desc = registerPluginLlmProvider(MINIMAX_MANIFEST, undefined, catalog);
  assert.equal(desc?.id, 'minimax-test');
  assert.equal(desc?.baseURL, 'https://api.minimax.io/v1');
  assert.equal(catalog.has('minimax-test'), true);
  // The regression: these stayed empty for a post-boot install, so the admin
  // Providers page (built from listModels) never showed the provider.
  const models = listModelsByProvider('minimax-test');
  assert.equal(models.length, 1);
  assert.equal(models[0]?.modelId, 'MiniMax-Text-01');
});

test('applies a per-install baseURL override from plugin config', () => {
  const desc = registerPluginLlmProvider(
    MINIMAX_MANIFEST,
    { minimax_base_url: 'https://api.minimaxi.chat/v1' },
    catalog,
  );
  assert.equal(desc?.baseURL, 'https://api.minimaxi.chat/v1');
  assert.equal(
    catalog.get('minimax-test')?.baseURL,
    'https://api.minimaxi.chat/v1',
  );
});

test('unregister drops the provider + its models (uninstall path)', () => {
  registerPluginLlmProvider(MINIMAX_MANIFEST, undefined, catalog);
  assert.equal(listModelsByProvider('minimax-test').length, 1);

  const id = unregisterPluginLlmProvider(MINIMAX_MANIFEST, catalog);
  assert.equal(id, 'minimax-test');
  assert.equal(catalog.has('minimax-test'), false);
  assert.equal(listModelsByProvider('minimax-test').length, 0);
});

test('a manifest with no llm_provider block is a safe no-op', () => {
  assert.equal(
    registerPluginLlmProvider({ kind: 'tool' }, undefined, catalog),
    undefined,
  );
  assert.equal(unregisterPluginLlmProvider({ kind: 'tool' }, catalog), undefined);
  assert.equal(registerPluginLlmProvider(undefined, undefined, catalog), undefined);
  assert.equal(unregisterPluginLlmProvider(null, catalog), undefined);
});
