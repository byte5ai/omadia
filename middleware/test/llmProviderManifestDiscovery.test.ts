/**
 * `parseLlmProviderManifestBlock` — the optional `discovery` block a provider
 * plugin declares (live model discovery rules). Shape errors must fail at
 * manifest load, not on the first sync.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLlmProviderManifestBlock } from '../src/platform/llmProviderManifest.js';

const base = {
  id: 'acme',
  label: 'Acme',
  wire_format: 'openai-compatible',
  default_base_url: 'https://api.acme.test/v1',
  models: [
    {
      id: 'acme:acme-1',
      model_id: 'acme-1',
      label: 'Acme 1',
      class: 'frontier',
      max_tokens: 1000,
      context_window: 2000,
      vision: false,
    },
  ],
};

test('no discovery block → descriptor without rules (static catalog)', () => {
  const d = parseLlmProviderManifestBlock(base);
  assert.equal(d.discovery, undefined);
});

test('a full discovery block maps snake_case to the contract', () => {
  const d = parseLlmProviderManifestBlock({
    ...base,
    discovery: {
      include: ['^acme-'],
      exclude: ['-preview$'],
      select: 'first',
      collapse_dated_snapshots: false,
      classify: [
        {
          match: '^acme-\\d+$',
          class: 'frontier',
          rest_class: 'balanced',
          aliases: ['acme'],
          max_tokens: 4096,
          context_window: 65536,
          vision: true,
          effort_levels: ['low', 'high'],
          effort_default: 'high',
          label: 'Acme {id}',
        },
        { match: '-mini$', class: 'fast' },
      ],
    },
  });
  assert.deepEqual(d.discovery, {
    include: ['^acme-'],
    exclude: ['-preview$'],
    select: 'first',
    collapseDatedSnapshots: false,
    classify: [
      {
        match: '^acme-\\d+$',
        class: 'frontier',
        restClass: 'balanced',
        aliases: ['acme'],
        maxTokens: 4096,
        contextWindow: 65536,
        vision: true,
        label: 'Acme {id}',
        effortLevels: ['low', 'high'],
        effortDefault: 'high',
      },
      { match: '-mini$', class: 'fast' },
    ],
  });
});

test('rejects malformed rules at load: bad regex, bad class, empty classify, bad select', () => {
  const withDiscovery = (discovery: unknown) => () =>
    parseLlmProviderManifestBlock({ ...base, discovery });
  assert.throws(withDiscovery({ classify: [] }), /classify.*non-empty/);
  assert.throws(withDiscovery({ classify: [{ match: '(', class: 'fast' }] }), /not a valid regular expression/);
  assert.throws(withDiscovery({ classify: [{ match: 'x', class: 'huge' }] }), /must be fast\|balanced\|frontier/);
  assert.throws(withDiscovery({ classify: [{ match: 'x', class: 'fast', rest_class: 'nope' }] }), /rest_class/);
  assert.throws(withDiscovery({ include: ['['], classify: [{ match: 'x', class: 'fast' }] }), /discovery\.include/);
  assert.throws(withDiscovery({ select: 'random', classify: [{ match: 'x', class: 'fast' }] }), /select/);
  assert.throws(
    withDiscovery({ classify: [{ match: 'x', class: 'fast', effort_levels: ['low'], effort_default: 'max' }] }),
    /effort_default/,
  );
});
