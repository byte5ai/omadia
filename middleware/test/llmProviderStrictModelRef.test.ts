/**
 * #1079 — `resolveModelRefStrict`: the one resolver every call site shares.
 * A class ref is resolved through the orchestrator's `resolveConfiguredModel`,
 * falls back to a pinned class default when the registry knows nothing, and
 * otherwise fails fast naming the config key — it is NEVER returned raw. Non-
 * class refs keep `coerceModelToProvider` behaviour byte-for-byte.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  clearExternalModels,
  coerceModelToProvider,
  isClassRef,
  LlmProviderCatalog,
  resolveConfiguredModel,
  resolveModelRefStrict,
  UnresolvedModelRefError,
  type LlmProviderDescriptor,
} from '@omadia/llm-provider';
import { resolveConfiguredModel as orchestratorResolveConfiguredModel } from '@omadia/orchestrator';

const fixture: LlmProviderDescriptor[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    wireFormat: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    models: [
      { id: 'anthropic:claude-opus-9', provider: 'anthropic', modelId: 'claude-opus-9', label: 'Opus 9', class: 'frontier', maxTokens: 1, contextWindow: 2, vision: true, aliases: ['opus'] },
      { id: 'anthropic:claude-sonnet-9', provider: 'anthropic', modelId: 'claude-sonnet-9', label: 'Sonnet 9', class: 'balanced', maxTokens: 1, contextWindow: 2, vision: true, aliases: ['sonnet'] },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    wireFormat: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    models: [
      { id: 'openai:gpt-9', provider: 'openai', modelId: 'gpt-9', label: 'GPT 9', class: 'frontier', maxTokens: 1, contextWindow: 2, vision: true },
    ],
  },
  {
    // A provider that serves ONLY a fast model — class:frontier must degrade.
    id: 'tiny',
    label: 'Tiny',
    wireFormat: 'openai-compatible',
    baseURL: 'http://tiny.local/v1',
    models: [
      { id: 'tiny:small-1', provider: 'tiny', modelId: 'small-1', label: 'Small', class: 'fast', maxTokens: 1, contextWindow: 2, vision: false },
    ],
  },
];

let catalog: LlmProviderCatalog;
beforeEach(() => {
  clearExternalModels();
  catalog = new LlmProviderCatalog();
  for (const d of fixture) catalog.register(d);
});
afterEach(() => {
  catalog.clear();
  clearExternalModels();
});

const opts = { configKey: 'SUB_AGENT_MODEL' };

test('the orchestrator re-exports the identical resolver', () => {
  assert.equal(orchestratorResolveConfiguredModel, resolveConfiguredModel);
});

test('class:frontier on anthropic → the frontier model', () => {
  assert.equal(resolveModelRefStrict('class:frontier', 'anthropic', opts), 'claude-opus-9');
  assert.equal(resolveModelRefStrict(' class:balanced ', 'anthropic', opts), 'claude-sonnet-9');
});

test('class:frontier on a fast-only provider → the nearest class', () => {
  assert.equal(resolveModelRefStrict('class:frontier', 'tiny', opts), 'small-1');
});

test('empty overlay: a class ref falls back to the pinned class default', () => {
  clearExternalModels();
  const seen: string[] = [];
  const resolved = resolveModelRefStrict('class:frontier', 'anthropic', {
    configKey: 'SUB_AGENT_MODEL',
    pinnedClassDefault: (providerId, cls) => {
      seen.push(`${providerId}/${cls}`);
      return 'claude-opus-pinned';
    },
  });
  assert.equal(resolved, 'claude-opus-pinned');
  assert.deepEqual(seen, ['anthropic/frontier']);
});

test('the pinned default is NOT consulted while the registry can serve the class', () => {
  const resolved = resolveModelRefStrict('class:frontier', 'anthropic', {
    configKey: 'SUB_AGENT_MODEL',
    pinnedClassDefault: () => 'claude-opus-pinned',
  });
  assert.equal(resolved, 'claude-opus-9');
});

test('empty overlay without a pinned default → UnresolvedModelRefError naming the key', () => {
  clearExternalModels();
  assert.throws(
    () => resolveModelRefStrict('class:frontier', 'anthropic', opts),
    (err: unknown) => {
      assert.ok(err instanceof UnresolvedModelRefError);
      assert.equal(err.ref, 'class:frontier');
      assert.equal(err.providerId, 'anthropic');
      assert.equal(err.configKey, 'SUB_AGENT_MODEL');
      assert.match(err.message, /SUB_AGENT_MODEL/);
      assert.match(err.message, /anthropic/);
      return true;
    },
  );
});

test('a pinned default that returns undefined still fails fast', () => {
  clearExternalModels();
  assert.throws(
    () =>
      resolveModelRefStrict('class:fast', 'ghost', {
        configKey: 'verifier_model',
        pinnedClassDefault: () => undefined,
      }),
    /verifier_model/,
  );
});

test('non-class refs keep coerceModelToProvider behaviour', () => {
  // alias → concrete id
  assert.equal(resolveModelRefStrict('opus', 'anthropic', opts), 'claude-opus-9');
  // provider-qualified → bare id
  assert.equal(resolveModelRefStrict('anthropic:claude-sonnet-9', 'anthropic', opts), 'claude-sonnet-9');
  // registry-unknown → unchanged
  assert.equal(resolveModelRefStrict('my-custom-model', 'anthropic', opts), 'my-custom-model');
  // cross-provider concrete id → the provider's same-class model
  assert.equal(resolveModelRefStrict('claude-opus-9', 'openai', opts), 'gpt-9');
  for (const [ref, provider] of [
    ['opus', 'anthropic'],
    ['my-custom-model', 'anthropic'],
    ['claude-opus-9', 'openai'],
    ['claude-sonnet-9', 'tiny'],
  ] as const) {
    assert.equal(
      resolveModelRefStrict(ref, provider, opts),
      coerceModelToProvider(ref, provider),
      `${ref} on ${provider}`,
    );
  }
});

test('the result is never a class ref', () => {
  const refs = ['class:frontier', 'class:balanced', 'class:fast', 'opus', 'claude-opus-9', 'x'];
  const providers = ['anthropic', 'openai', 'tiny'];
  for (const ref of refs) {
    for (const provider of providers) {
      const out = resolveModelRefStrict(ref, provider, opts);
      assert.equal(isClassRef(out), false, `${ref} on ${provider} → ${out}`);
    }
  }
});
