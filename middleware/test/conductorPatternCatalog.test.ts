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

  it('facilitation v5 hands the conversationId to every tool-calling step', () => {
    const catalog = loadPatternCatalog({ log: () => undefined });
    const facilitation = catalog.get('facilitation');
    assert.ok(facilitation);
    assert.equal((facilitation as { version?: number }).version, 5);
    // A restarted plugin resolves the facilitation by conversationId; without it
    // in the prompt the tick falls back to "latest" and can hit the wrong one.
    const prompts = new Map(
      facilitation.graph.steps.map((s) => [s.id, (s as { prompt?: string }).prompt ?? '']),
    );
    for (const id of ['moderate', 'report', 'abort-report']) {
      assert.ok(prompts.get(id)?.includes('{{ctx.conversationId}}'), `step '${id}' must carry {{ctx.conversationId}}`);
    }
    assert.ok(prompts.get('moderate')?.includes('{{ctx.deadline}}'));
    // Step ids are load-bearing for running runs' snapshotted graphs.
    assert.deepEqual([...prompts.keys()], ['moderate', 'wait', 'confirm', 'report', 'abort-report']);
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
