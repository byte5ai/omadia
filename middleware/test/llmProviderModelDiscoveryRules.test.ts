/**
 * Discovery rules engine (`applyDiscoveryRules`): the vendor's live model list
 * becomes catalog entries by FAMILY rules, never by version. These tests pin
 * the properties the rest of the platform relies on — newest-wins selection,
 * alias/default placement, snapshot collapsing, and capability fallbacks.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyDiscoveryRules,
  collapseDatedSnapshots,
  compareNewest,
  versionTokens,
  type DiscoveredModel,
  type LlmProviderDescriptor,
} from '@omadia/llm-provider';

const anthropic: LlmProviderDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  wireFormat: 'anthropic',
  baseURL: 'https://api.anthropic.com',
  models: [
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
    exclude: ['fable', 'mythos', '^claude-[23]-'],
    classify: [
      {
        match: '^claude-opus-',
        class: 'frontier',
        aliases: ['opus'],
        effortLevels: ['low', 'medium', 'high', 'xhigh'],
        effortDefault: 'high',
      },
      { match: '^claude-sonnet-', class: 'balanced', aliases: ['sonnet'] },
      { match: '^claude-haiku-', class: 'fast', aliases: ['haiku'] },
    ],
  },
};

function m(modelId: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return { modelId, ...extra };
}

test('versionTokens strips dated suffixes and reads every number', () => {
  assert.deepEqual(versionTokens('claude-opus-4-8'), [4, 8]);
  assert.deepEqual(versionTokens('claude-opus-5'), [5]);
  assert.deepEqual(versionTokens('claude-haiku-4-5-20251001'), [4, 5]);
  assert.deepEqual(versionTokens('gpt-5.6-terra'), [5, 6]);
  assert.deepEqual(versionTokens('MiniMax-M2.7-highspeed'), [2, 7]);
});

test('compareNewest: createdAt wins, then version tokens, then vendor order', () => {
  const byDate = [
    { model: m('a', { createdAt: '2026-01-01T00:00:00Z' }), index: 0 },
    { model: m('b', { createdAt: '2026-06-01T00:00:00Z' }), index: 1 },
  ].sort(compareNewest);
  assert.equal(byDate[0]?.model.modelId, 'b');

  const byVersion = [
    { model: m('claude-opus-4-8'), index: 0 },
    { model: m('claude-opus-5'), index: 1 },
    { model: m('claude-opus-4-7'), index: 2 },
  ].sort(compareNewest);
  assert.deepEqual(
    byVersion.map((x) => x.model.modelId),
    ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'],
  );
});

test('collapseDatedSnapshots drops a dated id only when its base id is listed', () => {
  const { kept, dropped } = collapseDatedSnapshots([
    m('claude-sonnet-5'),
    m('claude-sonnet-5-20260101'),
    m('claude-haiku-4-5-20251001'),
    m('gpt-5.5'),
    m('gpt-5.5-2026-04-23'),
  ]);
  assert.deepEqual(
    kept.map((x) => x.modelId),
    ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'gpt-5.5'],
  );
  assert.deepEqual(
    dropped.map((d) => d.modelId),
    ['claude-sonnet-5-20260101', 'gpt-5.5-2026-04-23'],
  );
});

test('a new generation becomes default + alias holder without any id in the rules', () => {
  const { models, dropped } = applyDiscoveryRules(anthropic, [
    m('claude-opus-4-8', { label: 'Claude Opus 4.8', contextWindow: 1_000_000, maxTokens: 128_000, vision: true }),
    m('claude-opus-5', { label: 'Claude Opus 5', contextWindow: 1_000_000, maxTokens: 128_000, vision: true, effortLevels: ['low', 'medium', 'high', 'xhigh'] }),
    m('claude-sonnet-4-6', { label: 'Claude Sonnet 4.6', vision: true }),
    m('claude-sonnet-5', { label: 'Claude Sonnet 5', vision: true }),
    m('claude-haiku-4-5-20251001', { label: 'Claude Haiku 4.5', vision: true }),
    m('claude-fable-5-1', { label: 'Claude Fable 5.1' }),
    m('claude-3-haiku-20240307'),
    m('claude-embed-1'),
  ]);

  const byId = new Map(models.map((x) => [x.modelId, x]));
  // opus: newest is default + carries the alias; the older one stays frontier without alias
  assert.equal(byId.get('claude-opus-5')?.classDefault, true);
  assert.deepEqual(byId.get('claude-opus-5')?.aliases, ['opus']);
  assert.equal(byId.get('claude-opus-4-8')?.class, 'frontier');
  assert.equal(byId.get('claude-opus-4-8')?.aliases, undefined);
  assert.equal(byId.get('claude-opus-4-8')?.classDefault, undefined);
  // sonnet likewise
  assert.equal(byId.get('claude-sonnet-5')?.classDefault, true);
  assert.deepEqual(byId.get('claude-sonnet-5')?.aliases, ['sonnet']);
  // haiku: sole model of its class → no classDefault flag needed, alias present
  assert.deepEqual(byId.get('claude-haiku-4-5-20251001')?.aliases, ['haiku']);
  assert.equal(byId.get('claude-haiku-4-5-20251001')?.classDefault, undefined);
  // vendor caps win over seed/rule fallbacks
  assert.equal(byId.get('claude-opus-5')?.contextWindow, 1_000_000);
  // seed caps fill what the vendor omitted
  assert.equal(byId.get('claude-haiku-4-5-20251001')?.maxTokens, 8_192);
  assert.equal(byId.get('claude-haiku-4-5-20251001')?.contextWindow, 200_000);
  // effort: vendor levels for opus-5; rule fallback for opus-4-8; none for sonnet (no rule, no vendor)
  assert.deepEqual(byId.get('claude-opus-5')?.effortLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(byId.get('claude-opus-5')?.effortDefault, 'high');
  assert.deepEqual(byId.get('claude-opus-4-8')?.effortLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(byId.get('claude-sonnet-5')?.effortLevels, undefined);
  // provider-qualified ids
  assert.equal(byId.get('claude-opus-5')?.id, 'anthropic:claude-opus-5');
  // drops carry a reason
  assert.deepEqual(
    dropped.map((d) => [d.modelId, d.reason]),
    [
      ['claude-fable-5-1', 'excluded'],
      ['claude-3-haiku-20240307', 'excluded'],
      ['claude-embed-1', 'unclassified'],
    ],
  );
});

test('restClass: the previous generation of a family lands in another class', () => {
  const openai: LlmProviderDescriptor = {
    id: 'openai',
    label: 'OpenAI',
    wireFormat: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    models: [],
    discovery: {
      include: ['^gpt-\\d'],
      exclude: ['(audio|realtime|image|embedding|search)'],
      classify: [
        { match: '^gpt-\\d+(\\.\\d+)?(-sol)?$', class: 'frontier', restClass: 'balanced', contextWindow: 400_000, maxTokens: 128_000, vision: true },
        { match: '-astra$', class: 'frontier', contextWindow: 1_000_000, maxTokens: 128_000, vision: true },
        { match: '-(mini|terra)$', class: 'balanced', vision: true },
        { match: '-(nano|luna)$', class: 'fast', vision: true },
      ],
    },
  };
  const { models } = applyDiscoveryRules(openai, [
    m('gpt-5.4', { createdAt: '2026-03-05T00:00:00Z' }),
    m('gpt-5.5', { createdAt: '2026-04-23T00:00:00Z' }),
    m('gpt-5.6-sol', { createdAt: '2026-07-01T00:00:00Z' }),
    m('gpt-6-astra', { createdAt: '2026-08-01T00:00:00Z' }),
    m('gpt-5.6-terra', { createdAt: '2026-07-01T00:00:00Z' }),
    m('gpt-5.4-mini', { createdAt: '2026-03-17T00:00:00Z' }),
    m('gpt-5.6-luna', { createdAt: '2026-07-01T00:00:00Z' }),
    m('gpt-5.4-nano', { createdAt: '2026-03-17T00:00:00Z' }),
    m('gpt-5.5-2026-04-23'),
    m('gpt-image-1'),
  ]);
  const byId = new Map(models.map((x) => [x.modelId, x]));
  // rule 1: newest plain/sol is frontier default; astra is frontier but NOT default (rule order)
  assert.equal(byId.get('gpt-5.6-sol')?.class, 'frontier');
  assert.equal(byId.get('gpt-5.6-sol')?.classDefault, true);
  assert.equal(byId.get('gpt-6-astra')?.class, 'frontier');
  assert.equal(byId.get('gpt-6-astra')?.classDefault, undefined);
  // older plain generations become balanced (restClass), newest of them is NOT the
  // balanced default because rule 3 (terra) is preferred? No — rule order decides:
  // rule 1's rest (balanced) comes before rule 3, so the newest rest member is default.
  assert.equal(byId.get('gpt-5.5')?.class, 'balanced');
  assert.equal(byId.get('gpt-5.5')?.classDefault, true);
  assert.equal(byId.get('gpt-5.4')?.class, 'balanced');
  assert.equal(byId.get('gpt-5.6-terra')?.class, 'balanced');
  assert.equal(byId.get('gpt-5.6-terra')?.classDefault, undefined);
  // fast: newest wins
  assert.equal(byId.get('gpt-5.6-luna')?.classDefault, true);
  assert.equal(byId.get('gpt-5.4-nano')?.class, 'fast');
  // dated snapshot collapsed, image model excluded
  assert.equal(byId.has('gpt-5.5-2026-04-23'), false);
  assert.equal(byId.has('gpt-image-1'), false);
  // rule caps as fallback (vendor list reports none)
  assert.equal(byId.get('gpt-6-astra')?.contextWindow, 1_000_000);
  assert.equal(byId.get('gpt-5.6-sol')?.contextWindow, 400_000);
});

test('retired ids (past shutdownAt) are dropped; future shutdown keeps them', () => {
  const { models, dropped } = applyDiscoveryRules(
    anthropic,
    [
      m('claude-opus-5', { shutdownAt: '2030-01-01' }),
      m('claude-opus-4-8', { shutdownAt: '2026-01-01' }),
    ],
    { now: new Date('2026-09-08T00:00:00Z') },
  );
  assert.deepEqual(models.map((x) => x.modelId), ['claude-opus-5']);
  assert.deepEqual(dropped, [{ modelId: 'claude-opus-4-8', reason: 'retired' }]);
});

test('select: first honours vendor order instead of newest', () => {
  const desc: LlmProviderDescriptor = {
    ...anthropic,
    discovery: { ...anthropic.discovery!, select: 'first' },
  };
  const { models } = applyDiscoveryRules(desc, [m('claude-opus-4-8'), m('claude-opus-5')]);
  const byId = new Map(models.map((x) => [x.modelId, x]));
  assert.equal(byId.get('claude-opus-4-8')?.classDefault, true);
  assert.deepEqual(byId.get('claude-opus-4-8')?.aliases, ['opus']);
});

test('label: vendor display name, else rule template, else the id', () => {
  const desc: LlmProviderDescriptor = {
    ...anthropic,
    discovery: {
      classify: [{ match: '^claude-opus-', class: 'frontier', label: 'Opus ({id})' }],
    },
  };
  const { models } = applyDiscoveryRules(desc, [m('claude-opus-5'), m('claude-opus-4-8', { label: 'Claude Opus 4.8' })]);
  const byId = new Map(models.map((x) => [x.modelId, x]));
  assert.equal(byId.get('claude-opus-5')?.label, 'Opus (claude-opus-5)');
  assert.equal(byId.get('claude-opus-4-8')?.label, 'Claude Opus 4.8');
});

test('throws when the descriptor declares no discovery rules', () => {
  assert.throws(
    () => applyDiscoveryRules({ ...anthropic, discovery: undefined }, [m('claude-opus-5')]),
    /declares no discovery rules/,
  );
});
