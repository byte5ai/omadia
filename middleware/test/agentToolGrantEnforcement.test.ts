import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type {
  AgentRow,
  ConfigSnapshot,
  ConfigStore,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';

/**
 * AN AGENT MAY ONLY RUN WHAT IT WAS GRANTED — enforced where the tool is
 * invoked, not only where it is registered.
 *
 * The per-agent tool surface is assembled by withholding un-granted tools at
 * hydrate time. That is one filter reached by several paths (boot hydrate,
 * post-boot install reconcile, rebuild, sub-agent hydration), and any path
 * that forgets it turns a registration bug into a PERMISSION bug: the tool is
 * simply present and the model will use it. In production an agent with no
 * grants at all answered with the Odoo HR integration.
 *
 * So these tests do the thing the hydrate filter cannot be trusted to prevent:
 * they REGISTER a foreign tool on the agent directly, then assert it still
 * cannot run. If registration is ever wrong again, the blast radius is a log
 * line instead of somebody else's data.
 */

function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
    get: () => undefined,
    getDomain: () => undefined,
    listWithHandler: () => [],
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
    assistantIdentity: 'You are the platform assistant.',
  } as unknown as OrchestratorDeps;
}

function agentRow(slug: string): AgentRow {
  return {
    id: `00000000-0000-0000-0000-0000000000${slug.length.toString().padStart(2, '0')}`,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as AgentRow;
}

const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };
const HR_PLUGIN = '@omadia/agent-odoo-hr';

/** A domain tool that records whether it ever ran. */
function hrTool(ran: { value: boolean }) {
  return {
    name: 'query_odoo_hr',
    domain: 'odoo.hr',
    agentId: HR_PLUGIN,
    spec: {
      name: 'query_odoo_hr',
      description: 'HR',
      input_schema: { type: 'object', properties: {} },
    },
    handle: async () => {
      ran.value = true;
      return 'REAL HR DATA';
    },
  } as never;
}

async function dispatch(
  built: ReturnType<typeof buildForAgent>,
  name: string,
): Promise<string> {
  const orch = built.orchestrator as unknown as {
    dispatchTool(n: string, i: unknown, o?: unknown, m?: unknown): Promise<string>;
  };
  return orch.dispatchTool(name, {}, undefined, undefined);
}

test('an un-granted plugin tool cannot run, even when registered on the agent', async () => {
  const ran = { value: false };
  // messias, as found in production: zero grants.
  const built = buildForAgent(agentRow('messias'), deps(), RUNTIME, undefined, []);
  built.orchestrator.registerDomainTool(hrTool(ran));

  const result = await dispatch(built, 'query_odoo_hr');

  assert.equal(ran.value, false, 'the handler must never be reached');
  assert.match(result, /not available to this agent/);
  // The refusal does not name the plugin: an agent that was never granted a
  // capability has no business learning which plugin holds it.
  assert.equal(result.includes(HR_PLUGIN), false);
});

test('the granted agent runs the very same tool', async () => {
  // The other half — without it the guard could be "refuse everything" and
  // still pass the test above.
  const ran = { value: false };
  const built = buildForAgent(agentRow('hr'), deps(), RUNTIME, undefined, [
    HR_PLUGIN,
  ]);
  built.orchestrator.registerDomainTool(hrTool(ran));

  const result = await dispatch(built, 'query_odoo_hr');

  assert.equal(ran.value, true);
  assert.equal(result, 'REAL HR DATA');
});

test('an agent with no grant set at all stays ungated', async () => {
  // The legacy single-Agent orchestrator holds the whole deployment's tools
  // and has no per-agent grants. Passing nothing must not disable it.
  const ran = { value: false };
  const built = buildForAgent(agentRow('legacy'), deps(), RUNTIME);
  built.orchestrator.registerDomainTool(hrTool(ran));

  assert.equal(await dispatch(built, 'query_odoo_hr'), 'REAL HR DATA');
  assert.equal(ran.value, true);
});

test('an empty grant list is "nothing", not "everything"', async () => {
  // The distinction the config spread has to preserve: `[]` is a real answer
  // (this agent was granted nothing) and must not collapse into `undefined`
  // (ungated). Pinned separately because that collapse is a one-character bug.
  const ran = { value: false };
  const granted = buildForAgent(agentRow('none'), deps(), RUNTIME, undefined, []);
  granted.orchestrator.registerDomainTool(hrTool(ran));

  assert.match(await dispatch(granted, 'query_odoo_hr'), /not available/);
  assert.equal(ran.value, false);
});


/**
 * THE GRANT HAS TO ARM THE LIVE AGENT, NOT THE NEXT ONE.
 *
 * Everything above tests a freshly built Orchestrator, which is the easy case
 * — the grant was known before the object existed. Production hits the other
 * case: the operator ticks a plugin on a running agent, the row lands, the UI
 * says saved, and the question is whether the agent that is already serving
 * turns can now use it.
 *
 * It could not. A grant change produced a metadata-only `update`, so the
 * running Orchestrator kept both the tool surface and the `grantedPluginIds`
 * it was born with. The capability appeared on the next process start, which
 * read from the outside as "assigned plugins only work after a restart".
 *
 * This test drives the real registry through the real reload and then asks the
 * only question that matters: does the tool RUN. Reproducing the boot wiring
 * (hydrate on `onAgentBuilt`, scoped to the agent's plugins) is the point —
 * that seam is where the stale surface used to survive.
 */
class FakeStore implements Pick<ConfigStore, 'loadSnapshot'> {
  constructor(private snap: ConfigSnapshot) {}
  set(snap: ConfigSnapshot): void {
    this.snap = snap;
  }
  loadSnapshot(): Promise<ConfigSnapshot> {
    return Promise.resolve(this.snap);
  }
}

test('a plugin granted to a RUNNING agent works without a restart', async () => {
  const agent = agentRow('clippy');
  const empty: ConfigSnapshot = {
    agents: [agent],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const store = new FakeStore(empty);
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: RUNTIME,
  });

  // Stand in for the kernel's boot wiring: every built Orchestrator gets the
  // tools its plugin grants allow, and nothing else.
  const ran = { value: false };
  const hydrate = (slug: string, built: ReturnType<typeof buildForAgent>): void => {
    const entry = registry.get(slug);
    const enabled = new Set(
      (entry?.plugins ?? []).filter((p) => p.enabled).map((p) => p.pluginId),
    );
    if (enabled.has(HR_PLUGIN)) built.orchestrator.registerDomainTool(hrTool(ran));
  };
  registry.setOnAgentBuilt(hydrate);
  await registry.start();
  for (const entry of registry.list()) hydrate(entry.agent.slug, entry.built);

  // Before the grant: refused, and the handler is never reached.
  const before = registry.get('clippy')!.built;
  before.orchestrator.registerDomainTool(hrTool(ran));
  assert.match(await dispatch(before, 'query_odoo_hr'), /not available to this agent/);
  assert.equal(ran.value, false);

  // The operator grants the plugin; the route reloads the registry.
  store.set({
    ...empty,
    agentPlugins: [
      {
        agentId: agent.id,
        pluginId: HR_PLUGIN,
        config: {},
        enabled: true,
        createdAt: new Date(0),
      },
    ],
  });
  await registry.reload();

  const after = registry.get('clippy')!.built;
  assert.equal(await dispatch(after, 'query_odoo_hr'), 'REAL HR DATA');
  assert.equal(ran.value, true, 'the granted handler actually ran');
});

test('a plugin revoked from a RUNNING agent stops working immediately', async () => {
  // The direction that is a security bug rather than an inconvenience: an
  // operator who withdraws a capability must not have to restart the process
  // to make the withdrawal true.
  const agent = agentRow('clippy');
  const granted: ConfigSnapshot = {
    agents: [agent],
    agentPlugins: [
      {
        agentId: agent.id,
        pluginId: HR_PLUGIN,
        config: {},
        enabled: true,
        createdAt: new Date(0),
      },
    ],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const store = new FakeStore(granted);
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: RUNTIME,
  });
  await registry.start();

  const ran = { value: false };
  registry.get('clippy')!.built.orchestrator.registerDomainTool(hrTool(ran));
  assert.equal(
    await dispatch(registry.get('clippy')!.built, 'query_odoo_hr'),
    'REAL HR DATA',
  );

  store.set({ ...granted, agentPlugins: [] });
  await registry.reload();

  // The rebuilt Orchestrator has no tool AND no grant. Re-register the tool to
  // prove the gate — not merely the missing registration — is what refuses.
  ran.value = false;
  const after = registry.get('clippy')!.built;
  after.orchestrator.registerDomainTool(hrTool(ran));
  assert.match(await dispatch(after, 'query_odoo_hr'), /not available to this agent/);
  assert.equal(ran.value, false);
});
