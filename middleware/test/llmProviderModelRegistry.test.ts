/**
 * Tests for the global provider-qualified model registry
 * (docs/plans/llm-provider-interface-plan.md, phase 3): reference resolution
 * (class / provider-qualified id / legacy alias / bare vendor id), role→class
 * resolution, and the alias-uniqueness + builder-slug invariants the builder
 * registry depends on.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getModel,
  isClassRef,
  listModels,
  listModelsByClass,
  listModelsByProvider,
  modelForClass,
  resolveModelRef,
  resolveRole,
  ROLE_DEFAULT_CLASS,
} from '@omadia/llm-provider';

test('getModel resolves an exact provider-qualified id', () => {
  const m = getModel('anthropic:claude-opus-4-8');
  assert.equal(m?.modelId, 'claude-opus-4-8');
  assert.equal(m?.provider, 'anthropic');
  assert.equal(m?.class, 'frontier');
  assert.equal(m?.vision, true);
  assert.equal(getModel('anthropic:does-not-exist'), undefined);
});

test('resolveModelRef: class refs resolve per provider (default anthropic)', () => {
  assert.equal(resolveModelRef('class:frontier')?.id, 'anthropic:claude-opus-4-8');
  assert.equal(resolveModelRef('class:balanced')?.id, 'anthropic:claude-sonnet-4-6');
  assert.equal(
    resolveModelRef('class:fast')?.id,
    'anthropic:claude-haiku-4-5-20251001',
  );
  // explicit provider pin — OpenAI has >1 model per class, so these must come
  // from the classDefault marker, NOT array order.
  assert.equal(
    resolveModelRef('class:frontier', { defaultProvider: 'openai' })?.id,
    'openai:gpt-4.1',
  );
  assert.equal(
    resolveModelRef('class:balanced', { defaultProvider: 'openai' })?.id,
    'openai:gpt-4.1-mini',
  );
  assert.equal(
    resolveModelRef('class:fast', { defaultProvider: 'openai' })?.id,
    'openai:gpt-4.1-nano',
  );
  // unknown class → undefined (and does NOT swallow a would-be concrete ref)
  assert.equal(resolveModelRef('class:genius'), undefined);
  assert.equal(resolveModelRef('class:'), undefined);
  // a provider with no model of that class
  assert.equal(resolveModelRef('class:frontier', { defaultProvider: 'mistral' }), undefined);
});

test('resolveModelRef: provider-qualified id, legacy alias, and bare vendor id', () => {
  assert.equal(resolveModelRef('openai:gpt-4.1')?.modelId, 'gpt-4.1');
  // legacy builder slugs
  assert.equal(resolveModelRef('opus')?.modelId, 'claude-opus-4-8');
  assert.equal(resolveModelRef('sonnet')?.modelId, 'claude-sonnet-4-6');
  assert.equal(resolveModelRef('haiku')?.modelId, 'claude-haiku-4-5-20251001');
  // bare vendor ids
  assert.equal(resolveModelRef('claude-opus-4-8')?.id, 'anthropic:claude-opus-4-8');
  assert.equal(resolveModelRef('gpt-4o-mini')?.id, 'openai:gpt-4o-mini');
  // unknown
  assert.equal(resolveModelRef('totally-unknown-model'), undefined);
});

test('modelForClass returns the canonical model per provider', () => {
  assert.equal(modelForClass('fast', 'anthropic')?.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(modelForClass('frontier', 'openai')?.modelId, 'gpt-4.1');
  assert.equal(modelForClass('frontier', 'nonexistent-provider'), undefined);
});

test('resolveRole maps role → default class → model', () => {
  // orchestrator/subagent default to frontier (== historical Opus default)
  assert.equal(resolveRole('orchestrator', 'anthropic')?.modelId, 'claude-opus-4-8');
  assert.equal(resolveRole('subagent', 'anthropic')?.modelId, 'claude-opus-4-8');
  // classifier/verifier default to fast (== historical Haiku default)
  assert.equal(resolveRole('classifier', 'anthropic')?.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(resolveRole('verifier', 'anthropic')?.modelId, 'claude-haiku-4-5-20251001');
  // preview is balanced
  assert.equal(resolveRole('preview', 'anthropic')?.modelId, 'claude-sonnet-4-6');
  // same roles resolve to OpenAI models when pinned to openai
  assert.equal(resolveRole('orchestrator', 'openai')?.modelId, 'gpt-4.1');
  assert.equal(resolveRole('classifier', 'openai')?.modelId, 'gpt-4.1-nano');
});

test('ROLE_DEFAULT_CLASS preserves the historical Anthropic defaults', () => {
  // The orchestrator/subagent historical default model was claude-opus-4-8
  // (frontier) and classifier/verifier claude-haiku (fast) — encode that so
  // role→class→model is a no-op for the Anthropic default path.
  assert.equal(ROLE_DEFAULT_CLASS.orchestrator, 'frontier');
  assert.equal(ROLE_DEFAULT_CLASS.subagent, 'frontier');
  assert.equal(ROLE_DEFAULT_CLASS.classifier, 'fast');
  assert.equal(ROLE_DEFAULT_CLASS.verifier, 'fast');
});

test('listModelsByProvider / listModelsByClass filter correctly', () => {
  const anthropic = listModelsByProvider('anthropic');
  assert.ok(anthropic.length >= 3);
  assert.ok(anthropic.every((m) => m.provider === 'anthropic'));
  const frontier = listModelsByClass('frontier');
  assert.ok(frontier.some((m) => m.id === 'anthropic:claude-opus-4-8'));
  assert.ok(frontier.some((m) => m.id === 'openai:gpt-4.1'));
});

test('isClassRef distinguishes class refs from concrete refs', () => {
  assert.equal(isClassRef('class:frontier'), true);
  assert.equal(isClassRef('anthropic:claude-opus-4-8'), false);
  assert.equal(isClassRef('opus'), false);
});

test('INVARIANT: aliases are globally unique', () => {
  const seen = new Set<string>();
  for (const m of listModels()) {
    for (const a of m.aliases ?? []) {
      assert.ok(!seen.has(a), `duplicate alias '${a}'`);
      seen.add(a);
    }
  }
});

test('INVARIANT: builder slugs all resolve (builder registry depends on this)', () => {
  for (const slug of ['haiku', 'sonnet', 'opus']) {
    const m = resolveModelRef(slug);
    assert.ok(m !== undefined, `builder slug '${slug}' must resolve`);
    assert.equal(m?.provider, 'anthropic');
  }
});

test('INVARIANT: every model has a positive contextWindow and maxTokens', () => {
  for (const m of listModels()) {
    assert.ok(m.contextWindow > 0, `${m.id} contextWindow`);
    assert.ok(m.maxTokens > 0, `${m.id} maxTokens`);
    assert.ok(m.id === `${m.provider}:${m.modelId}`, `${m.id} id format`);
  }
});
