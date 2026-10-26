/**
 * #1451 — a provider plugin that reuses a BUILT-IN provider id (the Hub's
 * `@omadia/plugin-llm-anthropic` registers under `anthropic`, the same id the
 * bundled descriptor uses) replaces the bundled entry. Uninstalling it used to
 * leave the catalog with NO `anthropic` entry at all until the next restart:
 * the model registry then knew no Anthropic model, `resolveConfiguredModel`
 * returned undefined for every class ref, and the orchestrator published
 * `class:balanced` as its model — a vendor 404 on every turn.
 *
 * The catalog therefore keeps the bundled descriptors as a BASE LAYER:
 * unregistering a plugin provider that shadowed a built-in restores the
 * bundled one (and its models), so the class ref resolves again.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  clearExternalModels,
  listModelsByProvider,
  resolveConfiguredModel,
  LlmProviderCatalog,
} from '@omadia/llm-provider';

import { registerBuiltinLlmProviders } from '../src/platform/builtinLlmProviders.js';
import {
  registerPluginLlmProvider,
  unregisterPluginLlmProvider,
} from '../src/platform/llmProviderManifest.js';

/** A plugin manifest shaped like `@omadia/plugin-llm-anthropic`: it declares
 *  the provider under the id the bundled descriptor already owns. */
const SHADOWING_MANIFEST = {
  kind: 'extension',
  llm_provider: {
    id: 'anthropic',
    label: 'Anthropic (plugin)',
    wire_format: 'anthropic',
    default_base_url: 'https://plugin.example/anthropic',
    models: [
      {
        id: 'anthropic:plugin-model-1',
        model_id: 'plugin-model-1',
        label: 'Plugin Model 1',
        class: 'frontier',
        class_default: true,
        max_tokens: 8192,
        context_window: 200_000,
        vision: false,
      },
    ],
  },
};

let catalog: LlmProviderCatalog;

beforeEach(() => {
  clearExternalModels();
  catalog = new LlmProviderCatalog();
  registerBuiltinLlmProviders(catalog);
});

afterEach(() => {
  catalog.clear();
  clearExternalModels();
});

test('uninstalling a plugin that shadowed a built-in restores the bundled provider', () => {
  const bundled = catalog.get('anthropic');
  assert.ok(bundled, 'bundled anthropic provider registered');
  const bundledBaseUrl = bundled.baseURL;

  const shadow = registerPluginLlmProvider(SHADOWING_MANIFEST, undefined, catalog);
  assert.equal(shadow?.id, 'anthropic');
  assert.equal(catalog.get('anthropic')?.baseURL, 'https://plugin.example/anthropic');

  assert.equal(unregisterPluginLlmProvider(SHADOWING_MANIFEST, catalog), 'anthropic');

  // The regression: the catalog kept nothing under `anthropic`, so the admin
  // Providers page, the verify endpoint and every class ref lost the provider.
  const restored = catalog.get('anthropic');
  assert.ok(restored, 'bundled anthropic provider is back in the catalog');
  assert.equal(restored.baseURL, bundledBaseUrl);
  assert.ok(
    listModelsByProvider('anthropic').length > 0,
    'bundled anthropic models are back in the model registry',
  );
  // The exact failure from the issue: `class:balanced` reached the vendor raw.
  // Checked for every class, because each LLM plugin follows its own: the
  // orchestrator `class:frontier`/`class:balanced`, the verifier `class:fast`.
  // A rebuild of any of them (the uninstall path triggers one) must resolve.
  for (const cls of ['class:fast', 'class:balanced', 'class:frontier']) {
    const model = resolveConfiguredModel(cls, 'anthropic');
    assert.ok(model, `${cls} resolves again`);
    assert.ok(!model.startsWith('class:'), `expected a concrete model id, got ${model}`);
  }
});

test('a plugin provider on its OWN id still disappears completely on uninstall', () => {
  const own = {
    kind: 'extension',
    llm_provider: {
      ...SHADOWING_MANIFEST.llm_provider,
      id: 'shadow-test-own',
      models: [
        {
          ...SHADOWING_MANIFEST.llm_provider.models[0],
          id: 'shadow-test-own:plugin-model-1',
        },
      ],
    },
  };
  registerPluginLlmProvider(own, undefined, catalog);
  assert.equal(catalog.has('shadow-test-own'), true);

  assert.equal(unregisterPluginLlmProvider(own, catalog), 'shadow-test-own');
  // The base layer must never resurrect a provider that was never bundled.
  assert.equal(catalog.has('shadow-test-own'), false);
  assert.equal(listModelsByProvider('shadow-test-own').length, 0);
});

test('the catalog knows which ids are bundled, so the kernel can warn on shadowing', () => {
  assert.equal(catalog.isBundled('anthropic'), true);
  assert.equal(catalog.isBundled('minimax-test'), false);
});
