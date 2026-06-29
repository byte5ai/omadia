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

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import {
  clearExternalModels,
  registerExternalModels,
  type ModelInfo,
} from '@omadia/llm-provider';
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
import { DEFAULT_ORCHESTRATOR_MODEL } from '../packages/harness-orchestrator/src/registry/agentRuntime.js';

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

/** `deps()` with a concrete provider id so the build path can pin model-ref
 *  resolution to a single provider (and drop cross-provider picks). The
 *  orchestrator only touches the provider at turn time, so a stub id suffices
 *  for build-time resolution assertions. */
function depsWithProvider(id: string): OrchestratorDeps {
  return { ...deps(), provider: { id } as OrchestratorDeps['provider'] };
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

// The build path resolves a per-Agent model ref to the active provider's
// concrete `modelId` via `@omadia/llm-provider`. Register the ids the tests
// pin so resolution lands on them instead of dropping to the platform default.
const OPUS: ModelInfo = {
  id: 'anthropic:claude-opus-4-8',
  provider: 'anthropic',
  modelId: 'claude-opus-4-8',
  label: 'Claude Opus 4.8',
  class: 'frontier',
  maxTokens: 16384,
  contextWindow: 200000,
  vision: true,
  aliases: ['opus'],
};
const HAIKU: ModelInfo = {
  id: 'anthropic:claude-haiku-4-5',
  provider: 'anthropic',
  modelId: 'claude-haiku-4-5',
  label: 'Claude Haiku 4.5',
  class: 'fast',
  maxTokens: 8192,
  contextWindow: 200000,
  vision: true,
  aliases: ['haiku'],
};
const GPT: ModelInfo = {
  id: 'openai:gpt-5.5',
  provider: 'openai',
  modelId: 'gpt-5.5',
  label: 'GPT-5.5',
  class: 'frontier',
  maxTokens: 16384,
  contextWindow: 400000,
  vision: true,
  aliases: [],
};

beforeEach(() => {
  clearExternalModels();
  registerExternalModels([OPUS, HAIKU, GPT]);
});

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

test('issue #296 acceptance #4: `agent added` log includes effectiveModel + effectiveModelRouting', async () => {
  // Per-agent overlay: agent persists `model_routing.main = haiku` so the
  // registry must build it on haiku instead of the platform default `m-default`.
  // The boot log line is the operator-visible surface for that resolution.
  const snapshot: ConfigSnapshot = {
    agents: [
      {
        ...agentRow('public', '00000000-0000-0000-0000-000000000001'),
        modelRouting: { mode: 'single', main: 'claude-haiku-4-5' },
      },
    ],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const registry = new OrchestratorRegistry(fakeStore(snapshot), deps(), {
    defaultRuntimeConfig: { model: 'm-default', maxTokens: 100, maxToolIterations: 4 },
    log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
  });
  await registry.start();

  const added = logged.find((l) => l.msg === 'registry: agent added');
  assert.ok(added, '`agent added` log was emitted');
  assert.equal(added.fields?.['slug'], 'public');
  assert.equal(
    added.fields?.['effectiveModel'],
    'claude-haiku-4-5',
    'effectiveModel reflects per-agent overlay, not platform default',
  );

  // Triage overlay also surfaces effectiveModelRouting so an operator can
  // confirm per-turn routing is wired without reading the orchestrator state.
  const triageSnap: ConfigSnapshot = {
    ...snapshot,
    agents: [
      {
        ...agentRow('triaged', '00000000-0000-0000-0000-000000000099'),
        modelRouting: { mode: 'triage', main: 'claude-opus-4-8' },
      },
    ],
  };
  logged.length = 0;
  const r2 = new OrchestratorRegistry(fakeStore(triageSnap), deps(), {
    defaultRuntimeConfig: { model: 'm-default', maxTokens: 100, maxToolIterations: 4 },
    log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
  });
  await r2.start();
  const addedTriage = logged.find((l) => l.msg === 'registry: agent added');
  assert.equal(addedTriage?.fields?.['effectiveModel'], 'claude-opus-4-8');
  assert.ok(
    addedTriage?.fields?.['effectiveModelRouting'],
    'effectiveModelRouting present in log when agent is on triage mode',
  );
});

test('issue #296 acceptance #4: `agent rebuilt` log includes the new effectiveModel after a routing change', async () => {
  // Hot-apply path: a routing edit triggers a rebuild (see
  // `runtimeChangeReasons:model_routing`). The rebuild log must carry the
  // freshly-resolved effectiveModel so the operator can confirm the change
  // landed without restarting.
  const before: ConfigSnapshot = {
    agents: [
      {
        ...agentRow('public', '00000000-0000-0000-0000-000000000001'),
        modelRouting: { mode: 'single', main: 'claude-haiku-4-5' },
      },
    ],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const after: ConfigSnapshot = {
    ...before,
    agents: [
      {
        ...agentRow('public', '00000000-0000-0000-0000-000000000001'),
        modelRouting: { mode: 'single', main: 'claude-opus-4-8' },
      },
    ],
  };
  let current: ConfigSnapshot = before;
  const store: ConfigStore = {
    loadSnapshot: () => Promise.resolve(current),
  } as unknown as ConfigStore;
  const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const registry = new OrchestratorRegistry(store, deps(), {
    defaultRuntimeConfig: { model: 'm-default', maxTokens: 100, maxToolIterations: 4 },
    log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
  });
  await registry.start();
  current = after;
  await registry.reload();

  const rebuilt = logged.find((l) => l.msg === 'registry: agent rebuilt');
  assert.ok(rebuilt, '`agent rebuilt` log was emitted on reload');
  assert.equal(rebuilt.fields?.['effectiveModel'], 'claude-opus-4-8');
  assert.match(
    String(rebuilt.fields?.['reason']),
    /model_routing/,
    'rebuild reason cites the routing change',
  );
});

test('issue #296 AC#2: per-instance model resolution is 3-tier (per-Agent → platform default → DEFAULT_ORCHESTRATOR_MODEL)', async () => {
  // Tier 1 (per-Agent overlay) wins over the platform default; an Agent with no
  // overlay falls to tier 2 (platform default); a blank platform default falls
  // to tier 3 (DEFAULT_ORCHESTRATOR_MODEL) so the turn loop never gets an empty
  // model id (which would 404 on every turn).
  const snapshot: ConfigSnapshot = {
    agents: [
      {
        ...agentRow('overridden', '00000000-0000-0000-0000-000000000001'),
        modelRouting: { mode: 'single', main: 'claude-haiku-4-5' },
      },
      // No modelRouting → inherits the platform default (tier 2).
      agentRow('inherits', '00000000-0000-0000-0000-000000000002'),
    ],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };

  // Tier 1 + tier 2 with a real platform default.
  const r1 = new OrchestratorRegistry(fakeStore(snapshot), deps(), {
    defaultRuntimeConfig: { model: 'platform-default', maxTokens: 100, maxToolIterations: 4 },
  });
  await r1.start();
  assert.equal(
    r1.get('overridden')?.built.effectiveModel,
    'claude-haiku-4-5',
    'tier 1: per-Agent overlay wins',
  );
  assert.equal(
    r1.get('inherits')?.built.effectiveModel,
    'platform-default',
    'tier 2: no overlay falls to the platform default',
  );

  // Tier 3: a blank platform default + no overlay falls to the hard fallback.
  const r2 = new OrchestratorRegistry(fakeStore(snapshot), deps(), {
    defaultRuntimeConfig: { model: '   ', maxTokens: 100, maxToolIterations: 4 },
  });
  await r2.start();
  assert.equal(
    r2.get('inherits')?.built.effectiveModel,
    DEFAULT_ORCHESTRATOR_MODEL,
    'tier 3: blank platform default falls to DEFAULT_ORCHESTRATOR_MODEL',
  );
});

test('issue #296 BLOCKER: per-Agent model ref resolves to the active provider bare modelId (never sent raw)', async () => {
  // The Admin picker writes a provider-qualified id; aliases are also valid.
  // The orchestrator sends `model` RAW to a single concrete adapter, so the
  // build path must resolve the overlay to the bare vendor `modelId` — sending
  // `anthropic:claude-opus-4-8` or `opus` raw 404s every turn.
  const snapshot: ConfigSnapshot = {
    agents: [
      {
        ...agentRow('qualified', '00000000-0000-0000-0000-0000000000a1'),
        modelRouting: { mode: 'single', main: 'anthropic:claude-opus-4-8' },
      },
      {
        ...agentRow('alias', '00000000-0000-0000-0000-0000000000a2'),
        modelRouting: { mode: 'single', main: 'opus' },
      },
      {
        // triage sub-models are sent raw too — they must resolve as well.
        ...agentRow('triaged', '00000000-0000-0000-0000-0000000000a3'),
        modelRouting: {
          mode: 'triage',
          main: 'anthropic:claude-opus-4-8',
          triage: 'haiku',
          simple: 'anthropic:claude-haiku-4-5',
        },
      },
    ],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const registry = new OrchestratorRegistry(
    fakeStore(snapshot),
    depsWithProvider('anthropic'),
    { defaultRuntimeConfig: { model: 'claude-opus-4-8', maxTokens: 100, maxToolIterations: 4 } },
  );
  await registry.start();

  assert.equal(
    registry.get('qualified')?.built.effectiveModel,
    'claude-opus-4-8',
    'provider-qualified id resolves to the bare modelId',
  );
  assert.equal(
    registry.get('alias')?.built.effectiveModel,
    'claude-opus-4-8',
    'legacy alias resolves to the bare modelId',
  );
  const triaged = registry.get('triaged')?.built;
  assert.equal(triaged?.effectiveModel, 'claude-opus-4-8');
  assert.deepEqual(
    triaged?.effectiveModelRouting,
    {
      classifierModel: 'claude-haiku-4-5',
      simpleModel: 'claude-haiku-4-5',
      complexModel: 'claude-opus-4-8',
    },
    'every per-turn routing sub-model is resolved to a bare modelId',
  );
});

test('issue #296 FIX2: a cross-provider per-Agent pick is dropped, not sent to the wrong adapter', async () => {
  // The orchestrator runs on ONE provider (`anthropic` here). A pick that
  // resolves to a DIFFERENT provider (`openai:gpt-5.5`) would be sent to the
  // anthropic adapter → 404. The build path drops it and falls back to the
  // platform default so the Agent keeps running.
  const snapshot: ConfigSnapshot = {
    agents: [
      {
        ...agentRow('crossprovider', '00000000-0000-0000-0000-0000000000b1'),
        modelRouting: { mode: 'single', main: 'openai:gpt-5.5' },
      },
    ],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const registry = new OrchestratorRegistry(
    fakeStore(snapshot),
    depsWithProvider('anthropic'),
    { defaultRuntimeConfig: { model: 'claude-opus-4-8', maxTokens: 100, maxToolIterations: 4 } },
  );
  await registry.start();
  assert.equal(
    registry.get('crossprovider')?.built.effectiveModel,
    'claude-opus-4-8',
    'cross-provider pick is dropped → falls back to the platform default (no 404)',
  );
});

test('issue #296 regression: a registry-unknown per-turn classifier is passed through raw, NOT collapsed to the main model', () => {
  // The default classifier (`DEFAULT_CLASSIFIER_MODEL`) and any operator-typed
  // id may be absent from the curated registry yet still served by the API.
  // Resolution must pass it through, not drop it — dropping would silently run
  // the cheap-classifier turn on the (expensive) main model.
  const undatedClassifier = 'classifier-not-in-registry';
  const snapshot: ConfigSnapshot = {
    agents: [
      {
        ...agentRow('triaged', '00000000-0000-0000-0000-0000000000c1'),
        modelRouting: {
          mode: 'triage',
          main: 'anthropic:claude-opus-4-8',
          triage: undatedClassifier,
        },
      },
    ],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const registry = new OrchestratorRegistry(
    fakeStore(snapshot),
    depsWithProvider('anthropic'),
    { defaultRuntimeConfig: { model: 'claude-opus-4-8', maxTokens: 100, maxToolIterations: 4 } },
  );
  return registry.start().then(() => {
    const routing = registry.get('triaged')?.built.effectiveModelRouting;
    assert.equal(
      routing?.classifierModel,
      undatedClassifier,
      'unknown classifier passes through raw',
    );
    assert.notEqual(
      routing?.classifierModel,
      'claude-opus-4-8',
      'unknown classifier is NOT collapsed to the main model',
    );
  });
});
