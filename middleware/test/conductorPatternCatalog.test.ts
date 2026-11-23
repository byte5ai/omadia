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
  it('ships a valid discussion pattern and no facilitation pattern (#2043)', () => {
    const catalog = loadPatternCatalog({ log: (m) => assert.fail(`unexpected loader warning: ${m}`) });
    const discussion = catalog.get('discussion');
    assert.ok(discussion, 'patterns/discussion.json must load');
    assert.deepEqual(checkTemplateManifest(discussion).errors, []);
    // Facilitation is no workflow pattern any more: the engine plugin runs it
    // through the kernel's facilitator services. A plugin of the earlier
    // generation asking for the pattern gets "unknown pattern", not a run.
    assert.equal(catalog.get('facilitation'), undefined);
    assert.deepEqual(catalog.list().map((p) => p.id), ['discussion']);
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
