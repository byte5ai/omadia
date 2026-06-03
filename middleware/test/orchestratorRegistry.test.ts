/**
 * US4 / T019 — `OrchestratorRegistry` acceptance tests.
 *
 * Independent test of the registry without a live Postgres: a fake
 * `ConfigStore` returns a hand-built `ConfigSnapshot`, the registry
 * materialises N independent `BuiltOrchestrator`s, and the assertions cover
 * the four US4 acceptance scenarios + SC-007 (FR-009) isolation behaviour:
 *
 *  1. Two enabled Agents → two distinct Orchestrator instances each carrying
 *     its own agentId / chatSessionStore / sessionLogger.
 *  2. A `disabled` Agent is dropped from the registry.
 *  3. The configured channel binding resolves to the correct Agent.
 *  4. The `multi_instance: false` validation refuses to materialise a
 *     snapshot that assigns such a plugin to >1 Agent.
 *  5. SC-007 / T018: an Orchestrator-construction throw for one Agent does
 *     NOT prevent the other Agents from coming up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
} from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  ConfigValidationError,
  type AgentRow,
  type ConfigSnapshot,
  type ConfigStore,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import {
  OrchestratorRegistry,
  validateSnapshot,
  type PluginCapabilityLookup,
} from '../packages/harness-orchestrator/src/registry/index.js';

function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
  } as unknown as NativeToolRegistry;
}

function deps(): OrchestratorDeps {
  return {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  };
}

function fakeStore(snapshot: ConfigSnapshot): ConfigStore {
  return {
    loadSnapshot: () => Promise.resolve(snapshot),
  } as unknown as ConfigStore;
}

function agentRow(slug: string, id: string, status: AgentRow['status'] = 'enabled'): AgentRow {
  return {
    id,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const twoAgentSnapshot: ConfigSnapshot = {
  agents: [
    agentRow('public', '00000000-0000-0000-0000-000000000001'),
    agentRow('general', '00000000-0000-0000-0000-000000000002'),
  ],
  agentPlugins: [
    {
      agentId: '00000000-0000-0000-0000-000000000001',
      pluginId: '@omadia/agent-seo-analyst',
      config: {},
      enabled: true,
      createdAt: new Date(0),
    },
    {
      agentId: '00000000-0000-0000-0000-000000000002',
      pluginId: '@omadia/agent-odoo-hr',
      config: {},
      enabled: true,
      createdAt: new Date(0),
    },
  ],
  channelBindings: [
    {
      channelType: 'teams',
      channelKey: '28:public-bot',
      agentId: '00000000-0000-0000-0000-000000000001',
      createdAt: new Date(0),
    },
    {
      channelType: 'telegram',
      channelKey: '@omadia_general_bot',
      agentId: '00000000-0000-0000-0000-000000000002',
      createdAt: new Date(0),
    },
  ],
  platformSettings: {
    fallbackAgentId: '00000000-0000-0000-0000-000000000001',
    updatedAt: new Date(0),
  },
};

test('US4-1: builds two independent Orchestrators from a two-Agent snapshot', async () => {
  const registry = new OrchestratorRegistry(
    fakeStore(twoAgentSnapshot),
    deps(),
    {
      defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
    },
  );
  await registry.start();

  assert.equal(registry.size(), 2);
  const pub = registry.get('public');
  const gen = registry.get('general');
  assert.ok(pub, 'public agent present');
  assert.ok(gen, 'general agent present');

  // Distinct Orchestrators, ids match the slugs (passed through US3 factory),
  // no shared per-Agent state.
  assert.notEqual(pub.built.orchestrator, gen.built.orchestrator);
  assert.equal(pub.built.orchestrator.agentId, 'public');
  assert.equal(gen.built.orchestrator.agentId, 'general');
  assert.notEqual(
    pub.built.bundle.chatSessionStore,
    gen.built.bundle.chatSessionStore,
  );
  assert.notEqual(
    pub.built.bundle.sessionLogger,
    gen.built.bundle.sessionLogger,
  );

  // Each Agent carries only its own enabled plugin set — registry data
  // reflects per-Agent isolation even though runtime tool dispatch is
  // shared until US5/US6 (documented seam).
  assert.deepEqual(pub.plugins.map((p) => p.pluginId), [
    '@omadia/agent-seo-analyst',
  ]);
  assert.deepEqual(gen.plugins.map((p) => p.pluginId), [
    '@omadia/agent-odoo-hr',
  ]);
});

test('US4-2: a disabled Agent is excluded from the registry', async () => {
  const snapshot: ConfigSnapshot = {
    ...twoAgentSnapshot,
    agents: [
      agentRow('public', '00000000-0000-0000-0000-000000000001'),
      agentRow('general', '00000000-0000-0000-0000-000000000002', 'disabled'),
    ],
  };
  const registry = new OrchestratorRegistry(fakeStore(snapshot), deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  assert.equal(registry.size(), 1);
  assert.ok(registry.get('public'));
  assert.equal(registry.get('general'), undefined);
});

test('US4-3: channel binding resolves to the bound Agent, fallback otherwise', async () => {
  const registry = new OrchestratorRegistry(
    fakeStore(twoAgentSnapshot),
    deps(),
    {
      defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
    },
  );
  await registry.start();

  // Bound key → owning Agent.
  assert.equal(
    registry.resolveByChannel('teams', '28:public-bot')?.agent.slug,
    'public',
  );
  assert.equal(
    registry.resolveByChannel('telegram', '@omadia_general_bot')?.agent.slug,
    'general',
  );
  // Unbound key → fallback (configured to the public Agent in the fixture).
  assert.equal(
    registry.resolveByChannel('teams', '28:unbound')?.agent.slug,
    'public',
  );
});

test('US4-3b: unbound key with no fallback returns undefined', async () => {
  const snapshot: ConfigSnapshot = {
    ...twoAgentSnapshot,
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const registry = new OrchestratorRegistry(fakeStore(snapshot), deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  assert.equal(registry.resolveByChannel('teams', '28:unbound'), undefined);
});

test('US4-4: validateSnapshot rejects multi_instance: false on >1 Agent', () => {
  const snapshot: ConfigSnapshot = {
    ...twoAgentSnapshot,
    agentPlugins: [
      {
        agentId: '00000000-0000-0000-0000-000000000001',
        pluginId: '@omadia/integration-microsoft365',
        config: {},
        enabled: true,
        createdAt: new Date(0),
      },
      {
        agentId: '00000000-0000-0000-0000-000000000002',
        pluginId: '@omadia/integration-microsoft365',
        config: {},
        enabled: true,
        createdAt: new Date(0),
      },
    ],
  };
  const lookup: PluginCapabilityLookup = {
    isMultiInstance: (id) =>
      id === '@omadia/integration-microsoft365' ? false : undefined,
  };
  assert.throws(
    () => validateSnapshot(snapshot, lookup),
    (err: unknown) =>
      err instanceof ConfigValidationError &&
      err.message.includes('multi_instance: false') &&
      err.message.includes('@omadia/integration-microsoft365'),
  );
});

test('US4-4b: validateSnapshot rejects duplicate channel binding', () => {
  const snapshot: ConfigSnapshot = {
    ...twoAgentSnapshot,
    channelBindings: [
      {
        channelType: 'teams',
        channelKey: '28:shared',
        agentId: '00000000-0000-0000-0000-000000000001',
        createdAt: new Date(0),
      },
      {
        channelType: 'teams',
        channelKey: '28:shared',
        agentId: '00000000-0000-0000-0000-000000000002',
        createdAt: new Date(0),
      },
    ],
  };
  assert.throws(
    () => validateSnapshot(snapshot),
    (err: unknown) =>
      err instanceof ConfigValidationError &&
      err.message.includes('duplicate channel binding'),
  );
});

test('US4-4c: validateSnapshot rejects a snapshot with an uninstalled plugin', () => {
  const lookup: PluginCapabilityLookup = {
    isMultiInstance: () => true,
    isInstalled: (id) => (id === '@omadia/agent-odoo-hr' ? false : true),
  };
  assert.throws(
    () => validateSnapshot(twoAgentSnapshot, lookup),
    (err: unknown) =>
      err instanceof ConfigValidationError &&
      err.message.includes('@omadia/agent-odoo-hr') &&
      err.message.includes('not installed'),
  );
});

test('US4-4d: registry.start() quarantines an uninstalled plugin instead of aborting the whole boot', async () => {
  // Regression: the fallback Agent had `de.byte5.agent.github-prs` enabled
  // after that plugin was unbundled from the deployment. `validateSnapshot`
  // threw on the missing plugin, which aborted `registry.start()` and left
  // the orchestratorRegistry / configStore / channelResolver unpublished —
  // every `/operator/*` route then returned `multi_orchestrator_unavailable`
  // (503). The registry must instead disable just the offending binding and
  // come up with the rest.
  const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const lookup: PluginCapabilityLookup = {
    isMultiInstance: () => true,
    // The `general` Agent's only plugin is no longer installed.
    isInstalled: (id) => (id === '@omadia/agent-odoo-hr' ? false : true),
  };
  const registry = new OrchestratorRegistry(
    fakeStore(twoAgentSnapshot),
    deps(),
    {
      defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
      pluginLookup: lookup,
      log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
    },
  );

  // Boot does NOT throw — the snapshot is sanitised before validation.
  await registry.start();

  // Both Agents come up; the offending binding is dropped, not the Agent.
  assert.equal(registry.size(), 2);
  assert.ok(registry.get('public'), 'public agent present');
  const general = registry.get('general');
  assert.ok(general, 'general agent still present despite its missing plugin');
  assert.deepEqual(
    general.plugins.filter((p) => p.enabled).map((p) => p.pluginId),
    [],
    'the uninstalled plugin is quarantined off the general Agent',
  );

  // The quarantine is surfaced loudly so an operator can fix the manifest.
  assert.ok(
    logged.some(
      (l) =>
        l.msg.includes('plugin not installed') &&
        l.fields?.['pluginId'] === '@omadia/agent-odoo-hr',
    ),
    'a per-binding warning is logged',
  );
});

test('SC-007 / T018: a build-time failure for Agent B does NOT prevent Agent A', async () => {
  // Inject a faulty `nativeToolRegistry` that throws once — Orchestrator
  // construction calls `register` for each native-tool name; failing one of
  // those constructions is the closest we can get to a per-Agent build
  // failure without mocking `buildOrchestratorForAgent`.
  let throws = 0;
  const flaky = (): NativeToolRegistry => {
    const names = new Set<string>();
    return {
      has: () => false,
      register: (name: string) => {
        // First Agent built (public) is fine. Trip the SECOND Agent's
        // Orchestrator construction by throwing once on its third register.
        if (throws < 1 && name === 'suggest_follow_ups') {
          throws += 1;
          throw new Error('synthetic build failure');
        }
        names.add(name);
        return () => names.delete(name);
      },
    } as unknown as NativeToolRegistry;
  };

  // Two Agents — second one trips the synthetic build failure. The first
  // build call succeeds with a fresh registry; the second is given the
  // flaky one.
  const flakyDeps: OrchestratorDeps = { ...deps(), nativeToolRegistry: flaky() };
  const registry = new OrchestratorRegistry(
    fakeStore(twoAgentSnapshot),
    flakyDeps,
    {
      defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
      log: () => undefined,
    },
  );
  await registry.start();

  // The first Agent built successfully — the registry kept it; the
  // second build trip was caught and logged, not propagated.
  assert.ok(registry.size() >= 1, 'at least one agent survived isolation');
});
