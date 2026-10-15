import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DomainTool } from '@omadia/orchestrator';

import {
  hydrateAgentRegistry,
  liveDomainTools,
  mergeDomainTools,
  reconcileDomainToolAcrossAgents,
  type ReconcileTarget,
} from '../src/agents/runtimeToolPropagation.js';

/** Minimal fake of the orchestrator's domain-tool surface. */
function fakeHost(initial: string[] = []) {
  const tools = new Set(initial);
  return {
    tools,
    hasDomainTool: (name: string) => tools.has(name),
    registerDomainTool: (tool: DomainTool) => {
      if (tools.has(tool.name)) {
        throw new Error(`duplicate domain-tool name '${tool.name}'`);
      }
      tools.add(tool.name);
    },
    unregisterDomainTool: (name: string) => tools.delete(name),
  };
}

function tool(name: string, agentId: string): DomainTool {
  // The reconciler only touches `.name`; cast keeps the test free of the full
  // DomainTool shape (handle/spec/domain).
  return { name, agentId } as unknown as DomainTool;
}

const T = tool('query_acme', 'de.byte5.agent.acme');

test('install: registers the tool only on Agents where the plugin is enabled', () => {
  const fallback = fakeHost();
  const scoped = fakeHost();
  const targets: ReconcileTarget[] = [
    { slug: 'fallback', enabled: true, orchestrator: fallback },
    { slug: 'marketing', enabled: false, orchestrator: scoped },
  ];

  reconcileDomainToolAcrossAgents(targets, { tool: T });

  assert.ok(fallback.tools.has('query_acme'), 'enabled Agent gets the tool');
  assert.ok(!scoped.tools.has('query_acme'), 'scoped Agent withholds the tool');
});

test('re-upload: replaces a stale handle instead of throwing on duplicate', () => {
  const host = fakeHost(['query_acme']); // v1 already registered
  const targets: ReconcileTarget[] = [
    { slug: 'fallback', enabled: true, orchestrator: host },
  ];

  // Would throw "duplicate domain-tool name" without the unregister-first step.
  assert.doesNotThrow(() =>
    reconcileDomainToolAcrossAgents(targets, { tool: T }),
  );
  assert.ok(host.tools.has('query_acme'));
});

test('disable: drops the tool from an Agent that no longer enables the plugin', () => {
  const host = fakeHost(['query_acme']);
  const targets: ReconcileTarget[] = [
    { slug: 'fallback', enabled: false, orchestrator: host },
  ];

  reconcileDomainToolAcrossAgents(targets, { tool: T });

  assert.ok(!host.tools.has('query_acme'), 'withheld tool is removed');
});

test('uninstall: drops the tool by name when the runtime no longer knows it', () => {
  const a = fakeHost(['query_acme']);
  const b = fakeHost(['query_acme', 'query_other']);
  const targets: ReconcileTarget[] = [
    { slug: 'fallback', enabled: false, orchestrator: a },
    { slug: 'support', enabled: false, orchestrator: b },
  ];

  // No `tool` (deactivated) — removal is driven by `removedToolName`.
  reconcileDomainToolAcrossAgents(targets, { removedToolName: 'query_acme' });

  assert.ok(!a.tools.has('query_acme'));
  assert.ok(!b.tools.has('query_acme'));
  assert.ok(b.tools.has('query_other'), 'unrelated tools are untouched');
});

test('isolation: a throw on one Agent does not abort the rest', () => {
  const boom = {
    hasDomainTool: () => false,
    registerDomainTool: () => {
      throw new Error('kaboom');
    },
    unregisterDomainTool: () => false,
  };
  const ok = fakeHost();
  const errors: string[] = [];
  const targets: ReconcileTarget[] = [
    { slug: 'broken', enabled: true, orchestrator: boom },
    { slug: 'fine', enabled: true, orchestrator: ok },
  ];

  reconcileDomainToolAcrossAgents(targets, {
    tool: T,
    onError: (slug) => errors.push(slug),
  });

  assert.deepEqual(errors, ['broken']);
  assert.ok(ok.tools.has('query_acme'), 'the healthy Agent still got the tool');
});

test('mergeDomainTools: boot built-ins win on a name clash, runtime tools append', () => {
  const boot = [tool('query_acme', 'agent.acme'), tool('memory', 'core')];
  const runtime = [
    tool('query_acme', 'agent.acme'), // duplicate by name → boot wins
    tool('query_new', 'agent.new'), // hot-installed → appended
  ];

  const merged = mergeDomainTools(boot, runtime);

  assert.deepEqual(
    merged.map((t) => t.name),
    ['query_acme', 'memory', 'query_new'],
  );
});

/** Fake per-Agent registry: what an orchestrator-plugin (re)activation publishes. */
function fakeRegistry(agents: Array<{ slug: string; enabledPlugins: string[] }>) {
  const entries = new Map(
    agents.map((a) => [
      a.slug,
      {
        agent: { slug: a.slug },
        plugins: a.enabledPlugins.map((pluginId) => ({ pluginId, enabled: true })),
        built: { orchestrator: fakeHost() },
      },
    ]),
  );
  let onAgentBuilt: ((slug: string, built: { orchestrator: ReturnType<typeof fakeHost> }) => void) | undefined;
  return {
    entries,
    list: () => [...entries.values()],
    get: (slug: string) => entries.get(slug),
    setOnAgentBuilt: (cb: typeof onAgentBuilt) => {
      onAgentBuilt = cb;
    },
    /** Simulate `reload()` rebuilding an Agent with a fresh orchestrator. */
    rebuild(slug: string) {
      const entry = entries.get(slug);
      if (!entry) throw new Error(slug);
      const built = { orchestrator: fakeHost() };
      entries.set(slug, { ...entry, built });
      onAgentBuilt?.(slug, built);
      return built;
    },
  };
}

const ACCOUNTING = tool('query_odoo_accounting', 'de.byte5.agent.odoo-accounting');
const CORE = { name: 'core_helper' } as unknown as DomainTool;

test('hydrateAgentRegistry: scopes tools per Agent and counts registrations', () => {
  const reg = fakeRegistry([
    { slug: 'fallback', enabledPlugins: ['de.byte5.agent.odoo-accounting'] },
    { slug: 'marketing', enabledPlugins: [] },
  ]);
  const attached = hydrateAgentRegistry(reg, {
    currentDomainTools: () => [ACCOUNTING, CORE],
    hydrateSubAgentTools: () => 0,
    log: () => {},
  });
  assert.equal(attached, 3);
  assert.ok(reg.get('fallback')?.built.orchestrator.tools.has('query_odoo_accounting'));
  assert.ok(!reg.get('marketing')?.built.orchestrator.tools.has('query_odoo_accounting'));
  assert.ok(reg.get('marketing')?.built.orchestrator.tools.has('core_helper'));
});

test('hydrateAgentRegistry: a registry published by a re-activation is hydrated too', () => {
  const deps = { currentDomainTools: () => [ACCOUNTING], hydrateSubAgentTools: () => 0, log: () => {} };
  const boot = fakeRegistry([{ slug: 'fallback', enabledPlugins: ['de.byte5.agent.odoo-accounting'] }]);
  hydrateAgentRegistry(boot, deps);
  // Provider switch → the orchestrator plugin re-activates → a NEW registry
  // whose orchestrators start empty. Re-binding hydrates it.
  const reactivated = fakeRegistry([{ slug: 'fallback', enabledPlugins: ['de.byte5.agent.odoo-accounting'] }]);
  assert.ok(!reactivated.get('fallback')?.built.orchestrator.tools.has('query_odoo_accounting'));
  hydrateAgentRegistry(reactivated, deps);
  assert.ok(reactivated.get('fallback')?.built.orchestrator.tools.has('query_odoo_accounting'));
  // …and keeps its rebuilds hydrated.
  const rebuilt = reactivated.rebuild('fallback');
  assert.ok(rebuilt.orchestrator.tools.has('query_odoo_accounting'));
});

test('hydrateAgentRegistry: idempotent on an already-hydrated registry', () => {
  const reg = fakeRegistry([{ slug: 'fallback', enabledPlugins: ['de.byte5.agent.odoo-accounting'] }]);
  const deps = { currentDomainTools: () => [ACCOUNTING], hydrateSubAgentTools: () => 0, log: () => {} };
  hydrateAgentRegistry(reg, deps);
  assert.doesNotThrow(() => hydrateAgentRegistry(reg, deps));
  assert.equal(hydrateAgentRegistry(reg, deps), 0);
});

test('liveDomainTools: a dynamic agent re-uploaded after boot binds its FRESH handle', () => {
  const kernel = tool('query_kernel', 'kernel');
  const bootHandle = { ...ACCOUNTING, handle: 'boot' } as unknown as DomainTool;
  const freshHandle = { ...ACCOUNTING, handle: 'fresh' } as unknown as DomainTool;
  const live = liveDomainTools([kernel, bootHandle], [bootHandle], [freshHandle]);
  assert.deepEqual(live.map((t) => t.name), ['query_kernel', 'query_odoo_accounting']);
  assert.equal((live[1] as unknown as { handle: string }).handle, 'fresh');
});

test('liveDomainTools: a dynamic agent uninstalled after boot stays gone', () => {
  const kernel = tool('query_kernel', 'kernel');
  const live = liveDomainTools([kernel, ACCOUNTING], [ACCOUNTING], []);
  assert.deepEqual(live.map((t) => t.name), ['query_kernel']);
});
