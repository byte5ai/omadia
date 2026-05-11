import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  loadBoilerplate,
  discoverTemplates,
  bootstrapTemplates,
  _resetCacheForTests,
} from '../../src/plugins/builder/boilerplateSource.js';
import { getKnownAgentTemplates } from '../../src/plugins/builder/agentSpec.js';

describe('boilerplateSource', () => {
  beforeEach(() => {
    _resetCacheForTests();
  });

  describe('loadBoilerplate(agent-integration)', () => {
    it('loads the expected boilerplate files', async () => {
      const bundle = await loadBoilerplate('agent-integration');
      const expected = [
        'client.ts',
        'index.ts',
        'manifest.yaml',
        'package.json',
        'plugin.ts',
        'scripts/build-zip.mjs',
        'skills/{{AGENT_SLUG}}-expert.md',
        'toolkit.ts',
        'tsconfig.json',
        'types.ts',
      ];
      for (const rel of expected) {
        assert.ok(bundle.files.has(rel), `missing file in bundle: ${rel}`);
      }
    });

    it('skips CLAUDE.md, template.yaml, README.md and git-state markers from the output map', async () => {
      // README.md skip added in B.6-9.1: README has literal {{PLACEHOLDER}}
      // examples in code-block bodies that the post-codegen no-residue
      // check would trip over.
      // .gitkeep / .gitignore added 2026-05-01 (live-test fix): zipExtractor's
      // allowlist rejects extension-less names; git-state markers must not
      // ship in the built zip.
      const bundle = await loadBoilerplate('agent-integration');
      assert.equal(bundle.files.has('CLAUDE.md'), false);
      assert.equal(bundle.files.has('template.yaml'), false);
      assert.equal(bundle.files.has('README.md'), false);
      assert.equal(bundle.files.has('assets/.gitkeep'), false);
    });

    it('parses the template manifest with declared slots and placeholders', async () => {
      const bundle = await loadBoilerplate('agent-integration');
      assert.equal(bundle.manifest.id, 'agent-integration');
      assert.ok(bundle.manifest.slots.length >= 4, 'at least 4 slots declared');
      const slotKeys = bundle.manifest.slots.map((s) => s.key);
      assert.ok(slotKeys.includes('client-impl'));
      assert.ok(slotKeys.includes('toolkit-impl'));
      assert.ok(slotKeys.includes('skill-prompt'));
      assert.ok(Object.keys(bundle.manifest.placeholders).length >= 5);
      assert.equal(bundle.manifest.placeholders['AGENT_ID'], 'id');
    });

    it('memoizes per template id (second call returns identical bundle reference)', async () => {
      const a = await loadBoilerplate('agent-integration');
      const b = await loadBoilerplate('agent-integration');
      assert.equal(a, b);
      assert.equal(a.files, b.files);
      assert.equal(a.manifest, b.manifest);
    });

    it('returns Buffer values for file content', async () => {
      const bundle = await loadBoilerplate('agent-integration');
      const manifest = bundle.files.get('manifest.yaml');
      assert.ok(Buffer.isBuffer(manifest));
      assert.ok(manifest.length > 0);
    });

    it('rejects unknown template id with a descriptive error', async () => {
      await assert.rejects(
        () => loadBoilerplate('nonexistent-template'),
        /not found/,
      );
    });
  });

  describe('discoverTemplates', () => {
    it('returns at least agent-integration', async () => {
      const ids = await discoverTemplates();
      assert.ok(ids.includes('agent-integration'));
    });

    it('returns agent-pure-llm (B.6-8)', async () => {
      const ids = await discoverTemplates();
      assert.ok(ids.includes('agent-pure-llm'), `expected agent-pure-llm in ${JSON.stringify(ids)}`);
    });

    it('returns ids sorted', async () => {
      const ids = await discoverTemplates();
      assert.deepEqual([...ids], [...ids].sort());
    });
  });

  describe('bootstrapTemplates', () => {
    it('registers all discovered templates with the AgentSpec registry', async () => {
      await bootstrapTemplates();
      const known = getKnownAgentTemplates();
      assert.ok(known.includes('agent-integration'));
      assert.ok(known.includes('agent-pure-llm'));
    });
  });

  describe('loadBoilerplate(agent-pure-llm)', () => {
    it('loads with the expected manifest shape', async () => {
      const bundle = await loadBoilerplate('agent-pure-llm');
      assert.equal(bundle.manifest.id, 'agent-pure-llm');
      // Pure-LLM only has the skill-prompt slot — no client/toolkit slots
      // and no INTEGRATION_ID/OUTBOUND_HOST placeholders.
      assert.deepEqual(
        bundle.manifest.slots.map((s) => s.key).sort(),
        ['skill-prompt'],
      );
      assert.ok(!('INTEGRATION_ID' in bundle.manifest.placeholders));
      assert.ok(!('OUTBOUND_HOST' in bundle.manifest.placeholders));
    });

    it('ships only runtime files (no client.ts, no toolkit.ts)', async () => {
      const bundle = await loadBoilerplate('agent-pure-llm');
      assert.ok(bundle.files.has('manifest.yaml'));
      assert.ok(bundle.files.has('plugin.ts'));
      assert.ok(bundle.files.has('package.json'));
      assert.ok(!bundle.files.has('client.ts'));
      assert.ok(!bundle.files.has('toolkit.ts'));
    });
  });
});
