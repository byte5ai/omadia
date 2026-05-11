import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import {
  KgEntityNamespaceError,
  KgServiceUnavailableError,
} from '@omadia/plugin-api';
import type { KnowledgeGraph } from '@omadia/plugin-api';

import type { Plugin } from '../../src/api/admin-v1.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../../src/platform/serviceRegistry.js';
import { createPluginContext } from '../../src/platform/pluginContext.js';

const stubVault = {
  get: async () => undefined,
  list: async () => [],
} as unknown as Parameters<typeof createPluginContext>[0]['vault'];

const stubInstalledRegistry = {
  has: () => true,
  get: () => undefined,
  list: () => [],
  getOrThrow: () => {
    throw new Error('not used');
  },
} as unknown as Parameters<typeof createPluginContext>[0]['registry'];

const stubNativeToolRegistry = {
  register: () => () => {},
  registerHandler: () => () => {},
} as unknown as Parameters<typeof createPluginContext>[0]['nativeToolRegistry'];

const stubRouteRegistry = {
  register: () => () => {},
  disposeBySource: () => 0,
} as unknown as Parameters<typeof createPluginContext>[0]['routeRegistry'];

const stubJobScheduler = {
  register: () => () => {},
  stopForPlugin: () => {},
} as unknown as Parameters<typeof createPluginContext>[0]['jobScheduler'];

function makePlugin(
  id: string,
  graphEntitySystems: string[] = [],
): Plugin {
  return {
    id,
    kind: 'agent',
    name: id,
    version: '0.1.0',
    latest_version: '0.1.0',
    description: '',
    authors: [],
    license: 'Proprietary',
    icon_url: null,
    categories: [],
    domain: 'test',
    compat_core: '>=1.0 <2.0',
    signed: false,
    signed_by: null,
    required_secrets: [],
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
      graph_entity_systems: graphEntitySystems,
    },
    integrations_summary: [],
    install_state: 'available',
    depends_on: [],
    jobs: [],
    provides: [],
    requires: [],
  };
}

function makeFakeCatalog(plugins: Plugin[]): PluginCatalog {
  const entries: PluginCatalogEntry[] = plugins.map((plugin) => ({
    plugin,
    manifest: {},
    source_path: `/abs/${plugin.id}/manifest.yaml`,
    source_kind: 'manifest-v1',
  }));
  return {
    list: () => entries,
    get: (id: string) => entries.find((e) => e.plugin.id === id),
  } as unknown as PluginCatalog;
}

interface FakeKgCalls {
  ingestEntities: { system: string; model: string; id: string | number }[];
  ingestFacts: number;
}

function makeFakeKg(calls: FakeKgCalls): KnowledgeGraph {
  return {
    async ingestEntities(entities) {
      for (const e of entities) {
        calls.ingestEntities.push({
          system: e.system,
          model: e.model,
          id: e.id,
        });
      }
      return {
        entityIds: entities.map((e) => `${e.system}:${e.model}:${e.id}`),
        inserted: entities.length,
        updated: 0,
      };
    },
    async ingestFacts(facts) {
      calls.ingestFacts += facts.length;
      return {
        factIds: facts.map((f) => f.factId),
        inserted: facts.length,
        updated: 0,
      };
    },
    // Read methods are stubbed minimally — not exercised by these tests.
    ingestTurn: async () => {
      throw new Error('not used');
    },
    ingestRun: async () => {
      throw new Error('not used');
    },
    getRunForTurn: async () => null,
    getSession: async () => null,
    listSessions: async () => [],
    getNeighbors: async () => [],
    stats: async () => ({
      nodes: 0,
      edges: 0,
      byNodeType: {} as Record<string, number>,
      byEdgeType: {} as Record<string, number>,
    }),
    searchTurns: async () => [],
    searchTurnsByEmbedding: async () => [],
    findEntityCapturedTurns: async () => [],
    findEntities: async () => [],
    ingestCompanies: async () => ({ companyIds: [], inserted: 0, updated: 0 }),
    ingestPersons: async () => ({ personIds: [], inserted: 0, updated: 0 }),
    ingestManagesEdges: async () => ({ inserted: 0, updated: 0 }),
    ingestShareholderEdges: async () => ({ inserted: 0, updated: 0 }),
    ingestSucceededByEdges: async () => ({ inserted: 0, updated: 0 }),
    ingestRefersToEdges: async () => ({ inserted: 0, updated: 0 }),
    ingestFinancialSnapshots: async () => ({ ids: [], inserted: 0, updated: 0 }),
    listCompaniesForPerson: async () => [],
    listPersonsForCompany: async () => [],
    listShareholdersForCompany: async () => [],
    listOwnedCompaniesForPerson: async () => [],
    listFinancialsForCompany: async () => [],
    findCompanyByExternalId: async () => null,
    findPersonByExternalId: async () => null,
  } as unknown as KnowledgeGraph;
}

describe('agent-reference / KnowledgeGraphAccessor (OB-29-2)', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  it('ctx.knowledgeGraph is undefined when manifest has no entity_systems', () => {
    const catalog = makeFakeCatalog([makePlugin('plain-caller', [])]);
    const ctx = createPluginContext({
      agentId: 'plain-caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    assert.equal(ctx.knowledgeGraph, undefined);
  });

  it('ingestEntities passes through allowed system to underlying KG', async () => {
    const calls: FakeKgCalls = { ingestEntities: [], ingestFacts: 0 };
    registry.provide('knowledgeGraph', makeFakeKg(calls));
    const catalog = makeFakeCatalog([
      makePlugin('caller', ['personal-notes']),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    assert.ok(ctx.knowledgeGraph);
    const result = await ctx.knowledgeGraph!.ingestEntities([
      {
        system: 'personal-notes',
        model: 'Person',
        id: 'marcel',
        displayName: 'Marcel',
      },
    ]);
    assert.equal(result.inserted, 1);
    assert.equal(calls.ingestEntities.length, 1);
    assert.equal(calls.ingestEntities[0]!.system, 'personal-notes');
  });

  it('ingestEntities throws KgEntityNamespaceError for un-whitelisted system', async () => {
    const calls: FakeKgCalls = { ingestEntities: [], ingestFacts: 0 };
    registry.provide('knowledgeGraph', makeFakeKg(calls));
    const catalog = makeFakeCatalog([
      makePlugin('caller', ['personal-notes']),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    await assert.rejects(
      ctx.knowledgeGraph!.ingestEntities([
        {
          system: 'odoo',
          model: 'res.partner',
          id: 42,
        },
      ]),
      KgEntityNamespaceError,
    );
    // Underlying KG was NOT called.
    assert.equal(calls.ingestEntities.length, 0);
  });

  it('throws KgServiceUnavailableError when no provider is registered', async () => {
    const catalog = makeFakeCatalog([
      makePlugin('caller', ['personal-notes']),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    // ctx.knowledgeGraph IS defined (because manifest declares entity_systems)
    // but the underlying provider isn't registered → first ingest throws.
    assert.ok(ctx.knowledgeGraph);
    await assert.rejects(
      ctx.knowledgeGraph!.ingestEntities([
        {
          system: 'personal-notes',
          model: 'Person',
          id: 'x',
        },
      ]),
      KgServiceUnavailableError,
    );
  });

  it('ingestFacts passes through (no namespace check on facts in v1)', async () => {
    const calls: FakeKgCalls = { ingestEntities: [], ingestFacts: 0 };
    registry.provide('knowledgeGraph', makeFakeKg(calls));
    const catalog = makeFakeCatalog([
      makePlugin('caller', ['personal-notes']),
    ]);
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    await ctx.knowledgeGraph!.ingestFacts([
      {
        factId: 'fact1',
        sourceTurnId: 'turn1',
        subject: 'subject',
        predicate: 'mentions',
        object: 'object',
        mentionedEntityIds: ['personal-notes:Person:marcel'],
      },
    ]);
    assert.equal(calls.ingestFacts, 1);
  });

  it('entitySystems exposes the manifest declaration', () => {
    const catalog = makeFakeCatalog([
      makePlugin('caller', ['personal-notes', 'meeting-notes']),
    ]);
    registry.provide(
      'knowledgeGraph',
      makeFakeKg({ ingestEntities: [], ingestFacts: 0 }),
    );
    const ctx = createPluginContext({
      agentId: 'caller',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    assert.deepEqual([...ctx.knowledgeGraph!.entitySystems], [
      'personal-notes',
      'meeting-notes',
    ]);
  });
});
