/**
 * Cluster C02 — runtime config changes must not drop agent tools.
 *
 * Every trigger below ends in a re-activation of `@omadia/orchestrator`, which
 * publishes a FRESH chat orchestrator (`chatAgent@1`, the one routines run on)
 * and a FRESH per-Agent registry, both starting with `domainTools: []`. The
 * kernel answers that activation with `createOrchestratorToolRebinder().rebind()`
 * (fired from `toolPluginRuntime.onActivated`). These tests drive the real
 * trigger code (settings PATCH router, `applyProviderAssignment`) into a fake
 * plugin activation and assert on the NEW instances:
 *
 *   - #1345 provider key save on /admin/settings
 *   - #1400 orchestrator model change on the LLM access page
 *   - #1358 routines (chat orchestrator) + agent-plugin re-install afterwards,
 *           and the key-less first boot
 *   - #1394 case 2: the first key save rebuilds extras before the orchestrator
 */
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  LlmProviderCatalog,
  clearExternalModels,
} from '@omadia/llm-provider';
import type { DomainTool } from '@omadia/orchestrator';
import express from 'express';

import {
  createOrchestratorToolRebinder,
  hydrateAgentRegistry,
  liveDomainTools,
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
const SEO = '@omadia/agent-seo-analyst';

function tool(name: string, agentId: string): DomainTool {
  return { name, agentId } as unknown as DomainTool;
}

const HR = tool('query_odoo_hr', 'de.byte5.agent.odoo-hr'); // kernel built-in
const SEO_TOOL = tool('query_seo_analyst', SEO); // dynamic agent plugin

class FakeOrchestrator {
  readonly tools = new Map<string, DomainTool>();
  hasDomainTool(name: string): boolean {
    return this.tools.has(name);
  }
  registerDomainTool(t: DomainTool): void {
    if (this.tools.has(t.name)) throw new Error(`duplicate domain-tool name '${t.name}'`);
    this.tools.set(t.name, t);
  }
  unregisterDomainTool(name: string): boolean {
    return this.tools.delete(name);
  }
}

interface FakeEntry {
  agent: { slug: string };
  plugins: Array<{ pluginId: string; enabled: boolean }>;
  built: { orchestrator: FakeOrchestrator };
}

/** What a fresh `orchestratorRegistry@1` looks like: one fallback Agent with
 *  every plugin enabled, and no domain tools yet. */
function freshRegistry() {
  const entries: FakeEntry[] = [
    {
      agent: { slug: 'fallback' },
      plugins: [
        { pluginId: SEO, enabled: true },
        { pluginId: 'de.byte5.agent.odoo-hr', enabled: true },
      ],
      built: { orchestrator: new FakeOrchestrator() },
    },
  ];
  return {
    list: () => entries,
    get: (slug: string) => entries.find((e) => e.agent.slug === slug),
    setOnAgentBuilt: (_cb: (slug: string, built: FakeEntry['built']) => void) => undefined,
  };
}
type FakeRegistry = ReturnType<typeof freshRegistry>;

/** The slice of `DynamicAgentRuntime` the re-bind drives. */
class FakeDynamicAgentRuntime {
  attached: FakeOrchestrator | undefined;
  readonly active: DomainTool[] = [];
  attachOrchestrator(o: FakeOrchestrator): void {
    this.attached = o;
    for (const t of this.active) if (!o.hasDomainTool(t.name)) o.registerDomainTool(t);
  }
  /** An agent plugin (re)activated after boot hot-registers on the attached one. */
  activate(t: DomainTool): void {
    if (!this.active.some((a) => a.name === t.name)) this.active.push(t);
    this.attached?.unregisterDomainTool(t.name);
    this.attached?.registerDomainTool(t);
  }
}

interface World {
  services: Map<string, unknown>;
  runtime: FakeDynamicAgentRuntime;
  rebinder: OrchestratorToolRebinder<FakeOrchestrator, FakeRegistry>;
  logs: string[];
  /** `toolPluginRuntime.activate('@omadia/orchestrator')` + its `onActivated`. */
  activateOrchestrator(): void;
  chat(): FakeOrchestrator | undefined;
  fallback(): FakeOrchestrator | undefined;
}

/**
 * Mirrors the kernel wiring in `index.ts`: boot set = kernel built-ins + the
 * dynamic agents active at boot; the registry hydration uses the LIVE set.
 * `keyless` = the orchestrator published nothing at boot.
 */
function makeWorld(opts: { keyless?: boolean } = {}): World {
  const services = new Map<string, unknown>();
  const runtime = new FakeDynamicAgentRuntime();
  runtime.active.push(SEO_TOOL);
  const dynamicAtBoot = [SEO_TOOL];
  const bootSet = [HR, ...dynamicAtBoot];
  const logs: string[] = [];
  const publish = (): void => {
    services.set('chatAgent', { raw: new FakeOrchestrator() });
    services.set('orchestratorRegistry', freshRegistry());
  };
  if (!opts.keyless) publish();

  const rebinder = createOrchestratorToolRebinder<FakeOrchestrator, FakeRegistry>({
    getChat: () => (services.get('chatAgent') as { raw: FakeOrchestrator } | undefined)?.raw,
    getRegistry: () => services.get('orchestratorRegistry') as FakeRegistry | undefined,
    kernelTools: () => bootSet.filter((t) => !dynamicAtBoot.includes(t)),
    attachDynamicAgents: (chat) => runtime.attachOrchestrator(chat),
    log: (m) => logs.push(m),
  });
  // Boot wiring: bind whatever exists, install the registry hydrator either way.
  const bootChat = (services.get('chatAgent') as { raw: FakeOrchestrator } | undefined)?.raw;
  if (bootChat) rebinder.bindChat(bootChat);
  const hydrate = (reg: FakeRegistry): void => {
    hydrateAgentRegistry(reg, {
      currentDomainTools: () => liveDomainTools(bootSet, dynamicAtBoot, runtime.active),
      hydrateSubAgentTools: () => 0,
      log: (m) => logs.push(m),
    });
  };
  const bootReg = services.get('orchestratorRegistry') as FakeRegistry | undefined;
  if (bootReg) hydrate(bootReg);
  rebinder.setRegistryHydrator(hydrate);

  return {
    services,
    runtime,
    rebinder,
    logs,
    activateOrchestrator() {
      publish();
      rebinder.rebind();
    },
    chat: () => (services.get('chatAgent') as { raw: FakeOrchestrator } | undefined)?.raw,
    fallback: () =>
      (services.get('orchestratorRegistry') as FakeRegistry | undefined)?.get('fallback')?.built
        .orchestrator,
  };
}

function assertHasDomainTools(o: FakeOrchestrator | undefined, where: string): void {
  assert.ok(o, `${where}: no orchestrator published`);
  assert.ok(o.hasDomainTool('query_seo_analyst'), `${where}: query_seo_analyst missing`);
  assert.ok(o.hasDomainTool('query_odoo_hr'), `${where}: query_odoo_hr missing`);
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

describe('orchestrator re-activation keeps domain tools (cluster C02)', () => {
  let close: (() => Promise<void>) | undefined;
  beforeEach(() => {
    clearExternalModels();
  });
  afterEach(async () => {
    await close?.();
    close = undefined;
    clearExternalModels();
  });

  it('#1345: a provider key save on /admin/settings keeps query_* on the NEW instances', async () => {
    const world = makeWorld();
    const bootChat = world.chat();
    const bootFallback = world.fallback();
    assertHasDomainTools(bootChat, 'boot chat');
    assertHasDomainTools(bootFallback, 'boot fallback');

    const reactivated: string[] = [];
    const srv = await settingsServer(world, reactivated);
    close = srv.close;
    assert.equal(await saveKey(srv.baseUrl, 'OPENAI_API_KEY', 'sk-test-openai'), 200);

    assert.ok(reactivated.includes(ORCH), 'the key save re-activates the orchestrator');
    assert.notEqual(world.chat(), bootChat, 'a fresh chat orchestrator was published');
    assert.notEqual(world.fallback(), bootFallback, 'a fresh registry was published');
    assertHasDomainTools(world.chat(), 'chat after key save');
    assertHasDomainTools(world.fallback(), 'fallback after key save');
    assert.ok(
      world.logs.includes('orchestrator re-activated — domain tools re-bound (chat=yes, registry=yes)'),
      world.logs.join('\n'),
    );
  });

  it('#1400: an orchestrator model change on the LLM access page keeps query_*', async () => {
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
    assertHasDomainTools(world.chat(), 'chat after model change');
    assertHasDomainTools(world.fallback(), 'fallback after model change');
  });

  it('#1358: routines run on the re-bound chat orchestrator, and a later agent-plugin reactivation lands there', async () => {
    const world = makeWorld();
    // The routine runner resolves its orchestrator per run (`getChatAgentBundle()?.raw`).
    const routineOrchestrator = (): FakeOrchestrator | undefined => world.chat();
    const before = routineOrchestrator();

    const srv = await settingsServer(world, []);
    close = srv.close;
    assert.equal(await saveKey(srv.baseUrl, 'OPENAI_API_KEY', 'sk-test-openai'), 200);

    const after = routineOrchestrator();
    assert.notEqual(after, before);
    assertHasDomainTools(after, 'routine orchestrator after key save');
    assert.equal(world.runtime.attached, after, 'hot installs target the NEW chat orchestrator');

    // Reactivating the SEO analyst (e.g. saving its setup) re-registers its
    // tool — on the live instance, not on the boot one.
    const v2 = tool('query_seo_analyst', SEO);
    world.runtime.activate(v2);
    assert.equal(after?.tools.get('query_seo_analyst'), v2);
    assert.notEqual(before?.tools.get('query_seo_analyst'), v2);
  });

  it('#1358: a key-less first boot gets every domain tool on the first key save, extras rebuilt before the orchestrator (#1394)', async () => {
    const world = makeWorld({ keyless: true });
    assert.equal(world.chat(), undefined, 'no chat orchestrator at a key-less boot');

    const reactivated: string[] = [];
    const srv = await settingsServer(world, reactivated);
    close = srv.close;
    assert.equal(await saveKey(srv.baseUrl, 'ANTHROPIC_API_KEY', 'sk-ant-first-key'), 200);

    assertHasDomainTools(world.chat(), 'chat after the first key save');
    assertHasDomainTools(world.fallback(), 'fallback after the first key save');
    assert.equal(reactivated.at(-1), ORCH, `orchestrator rebuilt last: ${reactivated.join(', ')}`);
    assert.ok(reactivated.indexOf(EXTRAS) < reactivated.indexOf(ORCH));
    assert.ok(reactivated.indexOf(VERIFIER) < reactivated.indexOf(ORCH));
  });

  it('re-binding twice is idempotent (no duplicate-name throw)', () => {
    const world = makeWorld();
    world.activateOrchestrator();
    assert.doesNotThrow(() => world.rebinder.rebind());
    assertHasDomainTools(world.chat(), 'chat after a double re-bind');
  });
});
