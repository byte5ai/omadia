import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkTemplateManifest } from '@omadia/conductor-core';

import { loadPatternCatalog } from '../src/conductor/patternCatalog.js';

// #330 — the shipped patterns/ dir is the curated allowlist behind
// createEphemeralRun. This test is the CI gate that the bundle is complete and
// valid (same contract as conductorTemplateCatalog.test.ts for templates/).

describe('bundled pattern catalog', () => {
  it('ships a valid facilitation pattern (id, slots, checkTemplateManifest)', () => {
    const catalog = loadPatternCatalog({ log: (m) => assert.fail(`unexpected loader warning: ${m}`) });
    const facilitation = catalog.get('facilitation');

    assert.ok(facilitation, 'patterns/facilitation.json must load');
    const result = checkTemplateManifest(facilitation);
    assert.deepEqual(result.errors, []);
    // The Facilitator (Workstream C) fills exactly these slots.
    assert.deepEqual(
      {
        agents: facilitation.slots.agents?.map((s) => s.key),
        roles: facilitation.slots.roles?.map((s) => s.key),
        channels: facilitation.slots.channels?.map((s) => s.key),
      },
      { agents: ['facilitator'], roles: ['initiator'], channels: ['report'] },
    );
  });

  it('every bundled pattern passes the manifest gate', () => {
    const catalog = loadPatternCatalog({ log: () => undefined });
    const patterns = catalog.list();
    assert.ok(patterns.length >= 1);
    for (const pattern of patterns) {
      const result = checkTemplateManifest(pattern);
      assert.deepEqual(result.errors, [], `pattern '${pattern.id}' must be valid`);
    }
  });
});

describe('loadPatternCatalog resilience', () => {
  it('skips an invalid file with a log line instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patterns-'));
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ id: 'empty' }));

    const logs: string[] = [];
    const catalog = loadPatternCatalog({ dir, log: (m) => logs.push(m) });

    assert.deepEqual(catalog.list(), []);
    assert.equal(logs.filter((l) => l.includes('invalid')).length, 2);
  });

  it('keeps the first file on a duplicate id and logs the collision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patterns-'));
    const manifest = {
      id: 'dup',
      name: { en: 'Dup' },
      description: { en: 'Dup' },
      defaultSlug: 'dup',
      graph: { entryStepId: 's', steps: [{ id: 's', kind: 'agent', agentId: 'slot:agent:a', prompt: 'p' }], transitions: [] },
      slots: { agents: [{ key: 'a', label: { en: 'A' } }] },
    };
    writeFileSync(join(dir, 'a-first.json'), JSON.stringify({ ...manifest, defaultSlug: 'first' }));
    writeFileSync(join(dir, 'b-second.json'), JSON.stringify({ ...manifest, defaultSlug: 'second' }));

    const logs: string[] = [];
    const catalog = loadPatternCatalog({ dir, log: (m) => logs.push(m) });

    assert.equal(catalog.get('dup')?.defaultSlug, 'first');
    assert.ok(logs.some((l) => l.includes("duplicates id 'dup'")));
  });
});
