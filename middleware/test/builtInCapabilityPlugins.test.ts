/**
 * Spec 2042 §5.10, ADR-0014 (#2049) — the two built-in packages that used to
 * be agent plugins are capability plugins: no persona, no `AGENT.md`, no
 * `prompt_partial` skill, tools through the tool runtime, and their former
 * persona as inactive agent templates (one per language).
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';
import { pluginRuntimeOf } from '../src/plugins/pluginRuntimeOf.js';
import { checkPluginBoundary } from '../src/plugins/pluginBoundary.js';
import { PersonaConfigSchema, QualityConfigSchema } from '../src/plugins/builder/agentSpec.js';

const BUILT_INS = [
  { dir: 'agent-seo-analyst', id: '@omadia/agent-seo-analyst', kind: 'tool', templates: ['seo-analyst', 'seo-analyst-de'] },
  {
    dir: 'agent-reference-maximum',
    id: '@omadia/agent-reference-maximum',
    kind: 'integration',
    templates: ['knowledge-companion', 'knowledge-companion-de'],
  },
] as const;

/** The flat template shape the kernel reads (`agent_templates:`). */
const TEMPLATE_KEYS = new Set([
  'id',
  'archetype',
  'name',
  'short_description',
  'long_description',
  'instructions',
  'language',
  'persona',
  'quality',
  'capabilities',
]);

for (const builtIn of BUILT_INS) {
  describe(`${builtIn.id} — capability plugin (#2049)`, () => {
    const manifestPath = fileURLToPath(new URL(`../packages/${builtIn.dir}/manifest.yaml`, import.meta.url));
    const packageRoot = dirname(manifestPath);

    it(`declares kind '${builtIn.kind}' and runs in the tool runtime`, async () => {
      const entry = await loadManifestFromPath(manifestPath);
      assert.ok(entry, 'manifest loads as a valid schema-v1 document');
      assert.equal(entry.plugin.id, builtIn.id);
      assert.equal(entry.plugin.kind, builtIn.kind);
      assert.equal(pluginRuntimeOf(entry.plugin.kind), 'tool');
    });

    it('passes the plugin boundary at ingest: no persona, no AGENT.md, no prompt_partial skill', async () => {
      const entry = await loadManifestFromPath(manifestPath);
      assert.ok(entry);
      const hasAgentMd = existsSync(join(packageRoot, 'AGENT.md')) || existsSync(join(packageRoot, 'agent.md'));
      assert.equal(hasAgentMd, false);
      const violation = checkPluginBoundary({
        pluginId: builtIn.id,
        kind: entry.plugin.kind,
        manifest: entry.manifest,
        hasAgentMd,
      });
      assert.equal(violation, undefined);
      assert.equal((entry.manifest as Record<string, unknown>)['skills'], undefined);
    });

    it('ships its former persona as one agent template per language, suggesting itself', async () => {
      const entry = await loadManifestFromPath(manifestPath);
      assert.ok(entry);
      const templates = (entry.manifest as { agent_templates?: unknown }).agent_templates;
      assert.ok(Array.isArray(templates));
      assert.deepEqual(
        templates.map((t) => (t as { id: string }).id),
        builtIn.templates,
      );
      assert.deepEqual(
        templates.map((t) => (t as { language: string }).language),
        ['en', 'de'],
      );
      for (const raw of templates) {
        const t = raw as Record<string, unknown>;
        for (const key of Object.keys(t)) assert.ok(TEMPLATE_KEYS.has(key), `unexpected template key '${key}'`);
        assert.equal(typeof t['name'], 'string');
        assert.ok(typeof t['short_description'] === 'string' && t['short_description'].length <= 80);
        assert.ok(typeof t['instructions'] === 'string' && t['instructions'].length > 0);
        if (t['persona'] !== undefined) PersonaConfigSchema.parse(t['persona']);
        if (t['quality'] !== undefined) QualityConfigSchema.parse(t['quality']);
        assert.deepEqual(t['capabilities'], [builtIn.id]);
      }
    });
  });
}
