import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import {
  SubAgentBudgetExceededError,
  SubAgentPermissionDeniedError,
  SubAgentRecursionError,
  UnknownSubAgentError,
} from '@omadia/plugin-api';
import type { DomainTool } from '@omadia/orchestrator';

import type { Plugin } from '../../src/api/admin-v1.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../../src/platform/serviceRegistry.js';
import { createPluginContext } from '../../src/platform/pluginContext.js';

// Minimal stubs for the bits createPluginContext needs but we don't exercise.
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
  permissions: {
    sub_agents_calls?: string[];
    sub_agents_calls_per_invocation?: number;
  } = {},
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
      ...permissions,
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

function makeFakeDomainTool(name: string, fixedAnswer: string): DomainTool {
  return {
    name,
    spec: {
      name,
      description: 'fake',
      input_schema: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
    async handle(input) {
      const q = (input as { question?: string }).question ?? '';
      return `${fixedAnswer} <- ${q.length} chars`;
    },
  };
}

describe('agent-reference / SubAgentAccessor', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  it('ctx.subAgent is undefined when manifest has no permissions.subAgents.calls', () => {
    const catalog = makeFakeCatalog([makePlugin('caller-without-perm')]);
    const ctx = createPluginContext({
      agentId: 'caller-without-perm',
      vault: stubVault,
      registry: stubInstalledRegistry,
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: stubNativeToolRegistry,
      routeRegistry: stubRouteRegistry,
      jobScheduler: stubJobScheduler,
    });
    assert.equal(ctx.subAgent, undefined);
  });

  it('ctx.subAgent.ask delegates to the registered DomainTool', async () => {
    registry.provide(
      'subAgent:@omadia/agent-seo-analyst',
      makeFakeDomainTool('query_seo_analyst', 'seo-answer'),
    );
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        sub_agents_calls: ['@omadia/agent-seo-analyst'],
      }),
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

    assert.ok(ctx.subAgent);
    const answer = await ctx.subAgent!.ask(
      '@omadia/agent-seo-analyst',
      'How is example.com doing?',
    );
    assert.match(answer, /^seo-answer <- 25 chars$/);
  });

  it('ask throws UnknownSubAgentError when target is not registered (despite whitelist)', async () => {
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        sub_agents_calls: ['@omadia/agent-seo-analyst'],
      }),
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
      ctx.subAgent!.ask('@omadia/agent-seo-analyst', 'q'),
      UnknownSubAgentError,
    );
  });

  it('ask throws SubAgentPermissionDeniedError for un-whitelisted target', async () => {
    registry.provide(
      'subAgent:de.byte5.agent.confluence',
      makeFakeDomainTool('query_confluence', 'wiki'),
    );
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        sub_agents_calls: ['@omadia/agent-seo-analyst'],
      }),
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
      ctx.subAgent!.ask('de.byte5.agent.confluence', 'q'),
      SubAgentPermissionDeniedError,
    );
  });

  it('ask honors wildcard whitelist (one segment deep)', async () => {
    registry.provide(
      'subAgent:de.byte5.agent.foo',
      makeFakeDomainTool('q_foo', 'foo'),
    );
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        sub_agents_calls: ['de.byte5.agent.*'],
      }),
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
    const answer = await ctx.subAgent!.ask('de.byte5.agent.foo', 'q');
    assert.match(answer, /^foo /);
  });

  it('wildcard does NOT match deeper nesting', async () => {
    registry.provide(
      'subAgent:de.byte5.agent.foo.bar',
      makeFakeDomainTool('q_foobar', 'fb'),
    );
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        sub_agents_calls: ['de.byte5.agent.*'],
      }),
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
      ctx.subAgent!.ask('de.byte5.agent.foo.bar', 'q'),
      SubAgentPermissionDeniedError,
    );
  });

  it('ask throws SubAgentRecursionError on direct self-call', async () => {
    registry.provide('subAgent:caller', makeFakeDomainTool('q_self', 'self'));
    const catalog = makeFakeCatalog([
      makePlugin('caller', { sub_agents_calls: ['caller'] }),
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
      ctx.subAgent!.ask('caller', 'q'),
      SubAgentRecursionError,
    );
  });

  it('ask enforces calls_per_invocation budget', async () => {
    registry.provide(
      'subAgent:@omadia/agent-seo-analyst',
      makeFakeDomainTool('q', 'ok'),
    );
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        sub_agents_calls: ['@omadia/agent-seo-analyst'],
        sub_agents_calls_per_invocation: 2,
      }),
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
    await ctx.subAgent!.ask('@omadia/agent-seo-analyst', 'first');
    await ctx.subAgent!.ask('@omadia/agent-seo-analyst', 'second');
    await assert.rejects(
      ctx.subAgent!.ask('@omadia/agent-seo-analyst', 'third'),
      SubAgentBudgetExceededError,
    );
  });

  it('list() returns reachable subAgent: services', () => {
    registry.provide(
      'subAgent:@omadia/agent-seo-analyst',
      makeFakeDomainTool('q', 'a'),
    );
    registry.provide(
      'subAgent:de.byte5.agent.confluence',
      makeFakeDomainTool('q', 'b'),
    );
    registry.provide('memoryStore', { dummy: true });
    const catalog = makeFakeCatalog([
      makePlugin('caller', {
        sub_agents_calls: ['de.byte5.agent.*'],
      }),
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
    const list = ctx.subAgent!.list();
    assert.deepEqual(
      [...list].sort(),
      ['de.byte5.agent.confluence', '@omadia/agent-seo-analyst'],
    );
  });
});
