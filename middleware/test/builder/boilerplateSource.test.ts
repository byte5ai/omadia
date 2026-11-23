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

  describe('loadBoilerplate(integration)', () => {
    it('loads the expected boilerplate files', async () => {
      const bundle = await loadBoilerplate('integration');
      const expected = [
        'client.ts',
        'index.ts',
        'manifest.yaml',
        'package.json',
        'plugin.ts',
        'registerTools.ts',
        'scripts/build-zip.mjs',
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
      const bundle = await loadBoilerplate('integration');
      assert.equal(bundle.files.has('CLAUDE.md'), false);
      assert.equal(bundle.files.has('template.yaml'), false);
      assert.equal(bundle.files.has('README.md'), false);
      assert.equal(bundle.files.has('assets/.gitkeep'), false);
    });

    it('parses the template manifest with declared slots and placeholders', async () => {
      const bundle = await loadBoilerplate('integration');
      assert.equal(bundle.manifest.id, 'integration');
      assert.ok(bundle.manifest.slots.length >= 4, 'at least 4 slots declared');
      const slotKeys = bundle.manifest.slots.map((s) => s.key);
      assert.ok(slotKeys.includes('client-impl'));
      assert.ok(slotKeys.includes('toolkit-impl'));
      // Spec 2042 §5.10 — a capability plugin has no system prompt.
      assert.ok(!slotKeys.includes('skill-prompt'));
      assert.ok(Object.keys(bundle.manifest.placeholders).length >= 5);
      assert.equal(bundle.manifest.placeholders['AGENT_ID'], 'id');
    });

    it('memoizes per template id (second call returns identical bundle reference)', async () => {
      const a = await loadBoilerplate('integration');
      const b = await loadBoilerplate('integration');
      assert.equal(a, b);
      assert.equal(a.files, b.files);
      assert.equal(a.manifest, b.manifest);
    });

    it('returns Buffer values for file content', async () => {
      const bundle = await loadBoilerplate('integration');
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
    it('returns at least integration', async () => {
      const ids = await discoverTemplates();
      assert.ok(ids.includes('integration'));
    });

    it('returns tool', async () => {
      const ids = await discoverTemplates();
      assert.ok(ids.includes('tool'), `expected tool in ${JSON.stringify(ids)}`);
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
      assert.ok(known.includes('integration'));
      assert.ok(known.includes('tool'));
    });
  });

  describe('loadBoilerplate(tool)', () => {
    it('loads with the expected manifest shape: toolkit slots, no client slots', async () => {
      const bundle = await loadBoilerplate('tool');
      assert.equal(bundle.manifest.id, 'tool');
      const keys = bundle.manifest.slots.map((s) => s.key);
      assert.ok(keys.includes('toolkit-impl'));
      assert.ok(keys.includes('activate-body'));
      assert.ok(!keys.includes('client-impl'));
      assert.ok(!keys.includes('skill-prompt'));
      assert.ok(!('INTEGRATION_ID' in bundle.manifest.placeholders));
      assert.ok(!('OUTBOUND_HOST' in bundle.manifest.placeholders));
    });

    it('ships toolkit + tool registration, no client.ts', async () => {
      const bundle = await loadBoilerplate('tool');
      for (const f of ['manifest.yaml', 'plugin.ts', 'package.json', 'toolkit.ts', 'registerTools.ts']) {
        assert.ok(bundle.files.has(f), `missing ${f}`);
      }
      assert.ok(!bundle.files.has('client.ts'));
    });
  });

  // Spec 2042 §5.10 — both boilerplates are capability plugins: manifest
  // kind integration/tool, no persona, no prompt_partial skill, no AGENT.md,
  // tools registered through ctx.tools.register.
  for (const [id, kind] of [['integration', 'integration'], ['tool', 'tool']] as const) {
    describe(`boilerplate ${id} is a capability plugin`, () => {
      it(`declares kind ${kind} and no persona/skills`, async () => {
        const bundle = await loadBoilerplate(id);
        const manifest = bundle.files.get('manifest.yaml')!.toString('utf-8');
        assert.match(manifest, new RegExp(`^  kind: "${kind}"`, 'm'));
        assert.doesNotMatch(manifest, /prompt_partial/);
        assert.doesNotMatch(manifest, /^skills:/m);
        assert.doesNotMatch(manifest, /^(persona|speaker|personality|system_prompt):/m);
        assert.ok(![...bundle.files.keys()].some((f) => /(^|\/)agent\.md$/i.test(f) || f.startsWith('skills/')));
      });

      it('registers its toolkit through ctx.tools.register', async () => {
        const bundle = await loadBoilerplate(id);
        const plugin = bundle.files.get('plugin.ts')!.toString('utf-8');
        const register = bundle.files.get('registerTools.ts')!.toString('utf-8');
        assert.match(plugin, /registerToolkit\(ctx, toolkit\)/);
        assert.doesNotMatch(plugin, /return \{\s*toolkit/);
        assert.match(register, /ctx\.tools\.register\(/);
      });
    });
  }
});
