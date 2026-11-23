/**
 * Cluster C02 — runtime config changes must not drop agent tools.
 *
 * Every trigger below ends in a re-activation of `@omadia/orchestrator`, which
 * publishes a FRESH per-Agent registry whose orchestrators start without their
 * DB-defined sub-agent tools. The kernel answers that activation with
 * `createOrchestratorToolRebinder().rebind()` (fired from
 * `toolPluginRuntime.onActivated`). These tests drive the real trigger code
 * (settings PATCH router, `applyProviderAssignment`) into a fake plugin
 * activation and assert on the NEW instances:
 *
 *   - #1345 provider key save on /admin/settings
 *   - #1400 orchestrator model change on the LLM access page
 *   - #1358 the key-less first boot
 *   - #1394 case 2: the first key save rebuilds extras before the orchestrator
 *
 * Spec 2042 §5.10 — plugins contribute no domain tools; a capability plugin's
 * tools live in the native tool registry, which a re-activation does not drop.
 */
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  LlmProviderCatalog,
  clearExternalModels,
} from '@omadia/llm-provider';
import express from 'express';

import {
  createOrchestratorToolRebinder,
  hydrateAgentRegistry,
  type OrchestratorToolRebinder,
} from '../src/agents/runtimeToolPropagation.js';
import { registerBuiltinLlmProviders } from '../src/platform/builtinLlmProviders.js';
import { applyProviderAssignment } from '../src/platform/providerAssignment.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { createAdminSettingsRouter } from '../src/routes/adminSettings.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

const ORCH = '@omadia/orchestrator';
const VERIFIER = '@omadia/verifier';
const EXTRAS = '@omadia/orchestrator-extras';
const HELPER = 'ask_research_helper'; // a DB-defined sub-agent of the fallback Agent

class FakeOrchestrator {
  readonly tools = new Set<string>();
  register(name: string): void {
    if (this.tools.has(name)) throw new Error(`duplicate domain-tool name '${name}'`);
    this.tools.add(name);
  }
}

interface FakeEntry {
  agent: { slug: string };
  built: { orchestrator: FakeOrchestrator };
}

/** What a fresh `orchestratorRegistry@1` looks like: one fallback Agent, no
 *  tools yet. */
function freshRegistry() {
  const entries: FakeEntry[] = [
    { agent: { slug: 'fallback' }, built: { orchestrator: new FakeOrchestrator() } },
  ];
  return {
    list: () => entries,
    get: (slug: string) => entries.find((e) => e.agent.slug === slug),
    setOnAgentBuilt: (_cb: (slug: string, built: FakeEntry['built']) => void) => undefined,
  };
}
type FakeRegistry = ReturnType<typeof freshRegistry>;

interface World {
  services: Map<string, unknown>;
  rebinder: OrchestratorToolRebinder<FakeRegistry>;
  logs: string[];
  /** `toolPluginRuntime.activate('@omadia/orchestrator')` + its `onActivated`. */
  activateOrchestrator(): void;
  fallback(): FakeOrchestrator | undefined;
}

/**
 * Mirrors the kernel wiring in `index.ts`: the hydration registers each
 * Agent's sub-agent tools, idempotently (as `hydrateSubAgentTools` does).
 * `keyless` = the orchestrator published nothing at boot.
 */
function makeWorld(opts: { keyless?: boolean } = {}): World {
  const services = new Map<string, unknown>();
  const logs: string[] = [];
  const publish = (): void => {
    services.set('orchestratorRegistry', freshRegistry());
  };
  if (!opts.keyless) publish();

  const rebinder = createOrchestratorToolRebinder<FakeRegistry>({
    getRegistry: () => services.get('orchestratorRegistry') as FakeRegistry | undefined,
    log: (m) => logs.push(m),
  });
  const hydrate = (reg: FakeRegistry): void => {
    hydrateAgentRegistry(reg, {
      hydrateSubAgentTools: (_slug, built) => {
        if (built.orchestrator.tools.has(HELPER)) return 0;
        built.orchestrator.register(HELPER);
        return 1;
      },
      log: (m) => logs.push(m),
    });
  };
  const bootReg = services.get('orchestratorRegistry') as FakeRegistry | undefined;
  if (bootReg) hydrate(bootReg);
  rebinder.setRegistryHydrator(hydrate);

  return {
    services,
    rebinder,
    logs,
    activateOrchestrator() {
      publish();
      rebinder.rebind();
    },
    fallback: () =>
      (services.get('orchestratorRegistry') as FakeRegistry | undefined)?.get('fallback')?.built
        .orchestrator,
  };
}

function assertHasAgentTools(o: FakeOrchestrator | undefined, where: string): void {
  assert.ok(o, `${where}: no orchestrator published`);
  assert.ok(o.tools.has(HELPER), `${where}: ${HELPER} missing`);
}

async function settingsServer(
  world: World,
  reactivated: string[],
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const registry = new InMemoryInstalledRegistry();
  for (const id of [ORCH, VERIFIER, EXTRAS]) {
    await registry.register({
      id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: {},
    });
  }
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/settings',
    createAdminSettingsRouter({
      installedRegistry: registry,
      vault: new InMemorySecretVault(),
      reactivate: async (id: string) => {
        reactivated.push(id);
        if (id === ORCH) world.activateOrchestrator();
      },
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function saveKey(baseUrl: string, key: string, value: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/v1/admin/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes: [{ key, value }] }),
  });
  await res.json();
  return res.status;
}

describe('orchestrator re-activation keeps agent tools (cluster C02)', () => {
  let close: (() => Promise<void>) | undefined;
  beforeEach(() => {
    clearExternalModels();
  });
  afterEach(async () => {
    await close?.();
    close = undefined;
    clearExternalModels();
  });

  it('#1345: a provider key save on /admin/settings keeps the sub-agent tools on the NEW instances', async () => {
    const world = makeWorld();
    const bootFallback = world.fallback();
    assertHasAgentTools(bootFallback, 'boot fallback');

    const reactivated: string[] = [];
    const srv = await settingsServer(world, reactivated);
    close = srv.close;
    assert.equal(await saveKey(srv.baseUrl, 'OPENAI_API_KEY', 'sk-test-openai'), 200);

    assert.ok(reactivated.includes(ORCH), 'the key save re-activates the orchestrator');
    assert.notEqual(world.fallback(), bootFallback, 'a fresh registry was published');
    assertHasAgentTools(world.fallback(), 'fallback after key save');
    assert.ok(
      world.logs.includes('orchestrator re-activated — agent tools re-bound (registry=yes)'),
      world.logs.join('\n'),
    );
  });

  it('#1400: an orchestrator model change on the LLM access page keeps the sub-agent tools', async () => {
    const world = makeWorld();
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: ORCH,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: { llm_provider: 'anthropic', orchestrator_model: 'claude-opus-4-8' },
    });
    const llmProviderCatalog = new LlmProviderCatalog();
    registerBuiltinLlmProviders(llmProviderCatalog);
    const bootFallback = world.fallback();

    const result = await applyProviderAssignment(
      {
        installedRegistry: registry,
        llmProviderCatalog,
        reactivate: async (id: string) => {
          if (id === ORCH) world.activateOrchestrator();
        },
      },
      { pluginId: ORCH, provider: 'anthropic', model: 'claude-sonnet-4-6' },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(world.fallback(), bootFallback);
    assertHasAgentTools(world.fallback(), 'fallback after model change');
  });

  it('#1358: a key-less first boot gets every sub-agent tool on the first key save, extras rebuilt before the orchestrator (#1394)', async () => {
    const world = makeWorld({ keyless: true });
    assert.equal(world.fallback(), undefined, 'no registry at a key-less boot');

    const reactivated: string[] = [];
    const srv = await settingsServer(world, reactivated);
    close = srv.close;
    assert.equal(await saveKey(srv.baseUrl, 'ANTHROPIC_API_KEY', 'sk-ant-first-key'), 200);

    assertHasAgentTools(world.fallback(), 'fallback after the first key save');
    assert.equal(reactivated.at(-1), ORCH, `orchestrator rebuilt last: ${reactivated.join(', ')}`);
    assert.ok(reactivated.indexOf(EXTRAS) < reactivated.indexOf(ORCH));
    assert.ok(reactivated.indexOf(VERIFIER) < reactivated.indexOf(ORCH));
  });

  it('re-binding twice is idempotent (no duplicate-name throw)', () => {
    const world = makeWorld();
    world.activateOrchestrator();
    assert.doesNotThrow(() => world.rebinder.rebind());
    assertHasAgentTools(world.fallback(), 'fallback after a double re-bind');
  });
});
