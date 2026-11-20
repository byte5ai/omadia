/**
 * Spec 2042 §5.10 — agent templates: inactive presets of identity,
 * personality and suggested capabilities, carried by a plugin and turned
 * into an agent only by the operator (Agent Builder).
 *
 *   - the `agent_templates:` block is read strictly: a template the kernel
 *     cannot read in full rejects the manifest;
 *   - only capability, archetype and agent-template packages carry them;
 *     a package of kind `agent-template` needs at least one;
 *   - the admin API lists the templates of INSTALLED plugins and serves one
 *     as the create and identity bodies; it creates and grants nothing.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import type { Plugin, PluginKind } from '../src/api/admin-v1.js';
import { readAgentTemplates } from '../src/plugins/agentTemplateManifest.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import { createAgentTemplatesRouter } from '../src/routes/agentTemplates.js';

const HANNA = {
  id: 'hr-assistant',
  name: 'Hanna',
  short_description: 'HR colleague',
  long_description: 'Answers questions about leave and payroll.',
  instructions: 'You are the HR colleague of the team.',
  language: 'de',
  persona: { axes: { warmth: 80, formality: 40 } },
  capabilities: ['@omadia/integration-odoo', '@omadia/integration-odoo', '@omadia/unknown'],
};

function manifest(kind: PluginKind, templates?: unknown): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: { id: '@acme/hr', name: 'HR', version: '1.0.0', kind },
    ...(templates !== undefined ? { agent_templates: templates } : {}),
  };
}

describe('agent_templates: manifest block', () => {
  it('reads a template with the standard archetype as default, capabilities deduplicated', () => {
    const plugin = adaptManifestV1(manifest('agent-template', [HANNA]), () => undefined);
    assert.ok(plugin);
    const [t] = plugin.agent_templates ?? [];
    assert.equal(t?.id, 'hr-assistant');
    assert.equal(t?.archetype, 'standard');
    assert.equal(t?.name, 'Hanna');
    assert.deepEqual(t?.capabilities, ['@omadia/integration-odoo', '@omadia/unknown']);
    assert.deepEqual(t?.persona, { axes: { warmth: 80, formality: 40 } });
  });

  it('lets a capability plugin and an archetype plugin carry templates', () => {
    for (const kind of ['integration', 'tool', 'skill', 'archetype'] as const) {
      const read = readAgentTemplates([{ id: 'x', name: 'X', archetype: 'facilitator' }], kind);
      assert.ok('templates' in read, kind);
      assert.equal(read.templates[0]?.archetype, 'facilitator');
    }
  });

  it('rejects templates on channel, model and system-module plugins', () => {
    for (const kind of ['channel', 'model', 'system-module', 'extension'] as const) {
      assert.equal(adaptManifestV1(manifest(kind, [HANNA]), () => undefined), null, kind);
    }
  });

  it('rejects a template package without templates', () => {
    assert.equal(adaptManifestV1(manifest('agent-template'), () => undefined), null);
    assert.equal(adaptManifestV1(manifest('agent-template', []), () => undefined), null);
  });

  it('rejects a template it cannot read in full', () => {
    const cases: unknown[] = [
      'not a list',
      [{ ...HANNA, mood: 'grumpy' }],
      [{ ...HANNA, id: 'Has Spaces' }],
      [{ ...HANNA, name: '' }],
      [{ ...HANNA, persona: { axes: { warmth: 300 } } }],
      [{ ...HANNA, language: 'not a tag!' }],
      [HANNA, HANNA],
    ];
    for (const templates of cases) {
      const read = readAgentTemplates(templates, 'tool');
      assert.ok('error' in read, JSON.stringify(templates));
    }
    assert.match(
      (readAgentTemplates([HANNA, HANNA], 'tool') as { error: string }).error,
      /declared twice/,
    );
  });

  it('reads no block as no templates on a capability plugin', () => {
    const plugin = adaptManifestV1(manifest('tool'), () => undefined);
    assert.ok(plugin);
    assert.equal(plugin.agent_templates, undefined);
  });
});

describe('GET /api/v1/admin/agent-templates', () => {
  const hr = adaptManifestV1(manifest('agent-template', [HANNA, { id: 'moderator', name: 'Mo', archetype: 'facilitator' }]), () => undefined);
  const odoo = adaptManifestV1(
    { schema_version: '1', identity: { id: '@omadia/integration-odoo', name: 'Odoo', version: '1.0.0', kind: 'integration' } },
    () => undefined,
  );
  const notInstalled = adaptManifestV1(
    { ...manifest('tool', [{ id: 'other', name: 'Other' }]), identity: { id: '@acme/other', name: 'Other', version: '1.0.0', kind: 'tool' } },
    () => undefined,
  );
  const plugins = [hr, odoo, notInstalled].filter((p): p is Plugin => p !== null);
  const installed = new Set(['@acme/hr', '@omadia/integration-odoo']);
  let server: Server;
  let base = '';

  before(async () => {
    const app = express();
    app.use(
      '/api/v1/admin/agent-templates',
      createAgentTemplatesRouter({
        listPlugins: () => plugins,
        isInstalled: (id) => installed.has(id),
        isArchetypeRegistered: (id) => id === 'standard',
      }),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/admin/agent-templates`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('lists the templates of installed plugins only, with archetype and capability status', async () => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { templates: Array<Record<string, unknown>> };
    assert.deepEqual(
      body.templates.map((t) => `${String(t['plugin_id'])}/${String(t['template_id'])}`),
      ['@acme/hr/hr-assistant', '@acme/hr/moderator'],
    );
    const [hanna, mo] = body.templates;
    assert.equal(hanna?.['archetype_available'], true);
    assert.equal(mo?.['archetype_available'], false);
    assert.deepEqual(hanna?.['suggested_capabilities'], [
      { plugin_id: '@omadia/integration-odoo', installed: true, grantable: true },
      { plugin_id: '@omadia/unknown', installed: false, grantable: false },
    ]);
  });

  it('serves one template as the create and identity bodies', async () => {
    const res = await fetch(`${base}/prefill?plugin=${encodeURIComponent('@acme/hr')}&template=hr-assistant`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    assert.deepEqual(body['agent'], { name: 'Hanna', description: 'HR colleague', archetype: 'standard' });
    assert.deepEqual(body['identity'], {
      display_name: 'Hanna',
      short_description: 'HR colleague',
      long_description: 'Answers questions about leave and payroll.',
      instructions: 'You are the HR colleague of the team.',
      language: 'de',
      persona: { axes: { warmth: 80, formality: 40 } },
      quality: null,
    });
    // The status and the slug are the Agent Builder's; nothing is granted.
    assert.equal(body['agent']?.['status'], undefined);
    assert.equal(body['agent']?.['slug'], undefined);
  });

  it('answers 404 for a template of a plugin that is not installed, 400 without a reference', async () => {
    const missing = await fetch(`${base}/prefill?plugin=${encodeURIComponent('@acme/other')}&template=other`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code: string }).code, 'agent_template.not_found');
    const bad = await fetch(`${base}/prefill?plugin=x`);
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { code: string }).code, 'agent_template.ref_missing');
  });
});
