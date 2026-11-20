/**
 * #2049 — export an agent as an agent template (spec 2042 §5.2):
 *
 *  1. `GET /api/v1/operator/agents/:slug/template` returns ONE
 *     `agent_templates:` entry in exactly the format the manifest reader
 *     takes (`plugins/agentTemplateManifest.ts`): name, descriptions,
 *     instructions, language, persona, quality, archetype and the granted
 *     capability plugin ids — never plugin configuration (credentials),
 *     memory, bindings, channels or disabled grants.
 *  2. Round trip: export → the manifest reader accepts it → the prefill of
 *     the admin template API gives back the same identity.
 *  3. `?format=yaml` is a download of the same document.
 *  4. An identity the reader would reject is a loud 409, not a broken file.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { parse as parseYaml } from 'yaml';

import type { ChatSessionStore, ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import type { Plugin } from '../src/api/admin-v1.js';
import { templateIdFromSlug } from '../src/agents/agentTemplateExport.js';
import type { AgentIdentityRecord } from '../src/platform/agentIdentityStore.js';
import { readAgentTemplates } from '../src/plugins/agentTemplateManifest.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import { createAgentTemplatesRouter } from '../src/routes/agentTemplates.js';
import {
  createOperatorAgentsRouter,
  type OperatorAgentIdentityStore,
} from '../src/routes/operatorAgents.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const ODOO = '@acme/integration-odoo';
const SEARCH = '@acme/web-search';
const TEAMS = '@acme/channel-teams';
const SECRET = 'sk-live-do-not-export';

interface AgentMem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  archetype?: string;
}

class FakeStore {
  agents: AgentMem[] = [
    { id: 'agent-1', slug: 'seo', name: 'SEO Agent', description: 'Finds what ranks' },
    { id: 'agent-2', slug: 'plain', name: 'Plain Agent', description: null },
    { id: 'agent-3', slug: 'mo', name: 'Mo', description: null, archetype: 'facilitator' },
  ];
  plugins = [
    { agentId: 'agent-1', pluginId: ODOO, config: { api_key: SECRET }, enabled: true },
    { agentId: 'agent-1', pluginId: SEARCH, config: {}, enabled: false },
    { agentId: 'agent-1', pluginId: TEAMS, config: { bot_secret: SECRET }, enabled: true },
  ];
  getAgentBySlug(slug: string): Promise<AgentMem | undefined> {
    return Promise.resolve(this.agents.find((a) => a.slug === slug));
  }
  listAgentPlugins(agentId: string): Promise<typeof this.plugins> {
    return Promise.resolve(this.plugins.filter((p) => p.agentId === agentId));
  }
}

function record(agentId: string, fields: Partial<AgentIdentityRecord>): AgentIdentityRecord {
  return {
    agentId,
    displayName: null,
    shortDescription: null,
    longDescription: null,
    instructions: null,
    accentColor: null,
    verbosity: null,
    language: null,
    persona: null,
    quality: null,
    composed: { text: 'compiled prompt', family: 'claude' },
    revision: 3,
    avatar: { etag: 'avatar-etag' },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...fields,
  } as AgentIdentityRecord;
}

const SEO_IDENTITY = record('agent-1', {
  displayName: 'Sophie',
  shortDescription: 'SEO analyst',
  longDescription: 'Audits pages and explains what to fix first.',
  instructions: 'You are the SEO analyst of the marketing team.',
  accentColor: '#112233',
  verbosity: 'brief',
  language: 'de',
  persona: { template: 'research-analyst', axes: { directness: 70, warmth: 40 } },
  quality: { sycophancy: 'high', boundaries: { presets: ['no-pii'], custom: [] } },
});

function catalogOf(): PluginCatalog {
  const entries = [
    { id: ODOO, name: 'Odoo', kind: 'integration' },
    { id: SEARCH, name: 'Web search', kind: 'tool' },
    { id: TEAMS, name: 'Teams', kind: 'channel' },
  ].map((p) => ({ plugin: { ...p, version: '1.0.0', setup_fields: [], depends_on: [] }, manifest: {} }));
  return {
    get: (id: string) => entries.find((e) => e.plugin.id === id),
    list: () => entries,
  } as unknown as PluginCatalog;
}

interface Harness {
  base: string;
  close(): Promise<void>;
}

async function harness(identities: Map<string, AgentIdentityRecord>, withIdentityStore = true): Promise<Harness> {
  const store = new FakeStore();
  const identityStore = {
    getByAgentId: (id: string) => Promise.resolve(identities.get(id)),
  } as unknown as OperatorAgentIdentityStore;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/operator/agents',
    createOperatorAgentsRouter({
      getConfigStore: () => store as unknown as ConfigStore,
      getRegistry: () => ({ reload: () => Promise.resolve() }) as unknown as OrchestratorRegistry,
      getChatSessionStore: () => ({}) as unknown as ChatSessionStore,
      getPluginCatalog: () => catalogOf(),
      ...(withIdentityStore ? { getAgentIdentity: () => ({ store: identityStore }) } : {}),
    }),
  );
  const server: Server = await listenLoopback(app);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${String(port)}/api/v1/operator/agents`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('#2049 — export an agent as an agent template', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('returns one entry with the identity and the granted capabilities, nothing else', async () => {
    h = await harness(new Map([['agent-1', SEO_IDENTITY]]));
    const res = await fetch(`${h.base}/seo/template`);
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text) as { agent_templates: Array<Record<string, unknown>> };
    assert.equal(body.agent_templates.length, 1);
    assert.deepEqual(body.agent_templates[0], {
      id: 'seo',
      archetype: 'standard',
      name: 'Sophie',
      short_description: 'SEO analyst',
      long_description: 'Audits pages and explains what to fix first.',
      instructions: 'You are the SEO analyst of the marketing team.',
      language: 'de',
      persona: { template: 'research-analyst', axes: { directness: 70, warmth: 40 } },
      quality: { sycophancy: 'high', boundaries: { presets: ['no-pii'], custom: [] } },
      // The disabled grant and the channel plugin are no capability of it.
      capabilities: [ODOO],
    });
    assert.equal(text.includes(SECRET), false, 'plugin configuration never leaves');
    for (const leak of ['avatar', 'composed', 'revision', 'accent_color', 'verbosity', 'bindings', 'memory']) {
      assert.equal(text.includes(leak), false, `no ${leak}`);
    }
  });

  it('round-trips: the reader accepts the export and the prefill gives the same identity', async () => {
    h = await harness(new Map([['agent-1', SEO_IDENTITY]]));
    const exported = (await (await fetch(`${h.base}/seo/template`)).json()) as { agent_templates: unknown[] };
    const read = readAgentTemplates(exported.agent_templates, 'agent-template');
    assert.ok('templates' in read, 'error' in read ? read.error : '');

    const plugin = adaptManifestV1(
      {
        schema_version: '1',
        identity: { id: '@acme/seo-templates', name: 'SEO templates', version: '1.0.0', kind: 'agent-template' },
        agent_templates: exported.agent_templates,
      },
      () => undefined,
    );
    assert.ok(plugin);
    const app = express();
    app.use(
      '/t',
      createAgentTemplatesRouter({
        listPlugins: () => [plugin as Plugin],
        isInstalled: () => true,
        isArchetypeRegistered: () => true,
      }),
    );
    const server = await listenLoopback(app);
    try {
      const port = (server.address() as AddressInfo).port;
      const prefill = (await (
        await fetch(`http://127.0.0.1:${String(port)}/t/prefill?plugin=${encodeURIComponent('@acme/seo-templates')}&template=seo`)
      ).json()) as Record<string, Record<string, unknown>>;
      assert.deepEqual(prefill['identity'], {
        display_name: SEO_IDENTITY.displayName,
        short_description: SEO_IDENTITY.shortDescription,
        long_description: SEO_IDENTITY.longDescription,
        instructions: SEO_IDENTITY.instructions,
        language: SEO_IDENTITY.language,
        persona: SEO_IDENTITY.persona,
        quality: SEO_IDENTITY.quality,
      });
      assert.deepEqual(prefill['agent'], { name: 'Sophie', description: 'SEO analyst', archetype: 'standard' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serves the same document as a YAML download', async () => {
    h = await harness(new Map([['agent-1', SEO_IDENTITY]]));
    const json = (await (await fetch(`${h.base}/seo/template`)).json()) as unknown;
    const res = await fetch(`${h.base}/seo/template?format=yaml`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/yaml/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="seo.agent-template.yaml"');
    assert.deepEqual(parseYaml(await res.text()), json);
  });

  it('exports an agent without an authored identity under its own name; other archetypes keep theirs', async () => {
    h = await harness(new Map());
    const plain = (await (await fetch(`${h.base}/plain/template`)).json()) as { agent_templates: unknown[] };
    assert.deepEqual(plain.agent_templates, [{ id: 'plain', archetype: 'standard', name: 'Plain Agent', capabilities: [] }]);
    const mo = (await (await fetch(`${h.base}/mo/template`)).json()) as { agent_templates: Array<Record<string, unknown>> };
    assert.equal(mo.agent_templates[0]?.['archetype'], 'facilitator');
  });

  it('refuses loudly an identity the manifest reader would reject', async () => {
    h = await harness(new Map([['agent-1', record('agent-1', { persona: { axes: { warmth: 300 } } } as Partial<AgentIdentityRecord>)]]));
    const res = await fetch(`${h.base}/seo/template`);
    assert.equal(res.status, 409);
    const body = (await res.json()) as Record<string, string>;
    assert.equal(body['error'], 'template_export_invalid');
    assert.match(body['reason'] ?? '', /persona/);
  });

  it('answers 404 for an unknown agent, 400 for an unknown format, 503 without the identity store', async () => {
    h = await harness(new Map());
    assert.equal((await fetch(`${h.base}/nobody/template`)).status, 404);
    assert.equal((await fetch(`${h.base}/plain/template?format=xml`)).status, 400);
    await h.close();
    h = await harness(new Map(), false);
    assert.equal((await fetch(`${h.base}/plain/template`)).status, 503);
  });

  it('derives a template id the reader accepts from any slug', () => {
    assert.equal(templateIdFromSlug('seo'), 'seo');
    assert.equal(templateIdFromSlug('Sales_Team 2'), 'sales-team-2');
    assert.equal(templateIdFromSlug('42-bot'), 'agent-42-bot');
    assert.equal(templateIdFromSlug('x'.repeat(80)).length, 63);
  });
});
