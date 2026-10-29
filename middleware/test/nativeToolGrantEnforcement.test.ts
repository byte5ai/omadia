import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';

/**
 * #1598 — per-orchestrator plugin assignment covers `ctx.tools.register`
 * tools, not only domain tools (#983).
 *
 * Native tools live in ONE kernel-wide registry. Before the fix an
 * orchestrator granted nothing was offered — and ran — `odoo_version` of an
 * Odoo integration assigned to no orchestrator at all. The registry here is
 * the real one, shared by every agent, exactly as in production.
 */

const ODOO_PLUGIN = '@omadia/integration-odoo';
const TOOL = 'odoo_version';
const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };

let rowSeq = 0;
function agentRow(slug: string): AgentRow {
  rowSeq += 1;
  return {
    id: `00000000-0000-0000-0000-${rowSeq.toString().padStart(12, '0')}`,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as AgentRow;
}

function setup(): { registry: NativeToolRegistry; ran: { value: boolean }; deps: OrchestratorDeps } {
  const registry = new NativeToolRegistry();
  const ran = { value: false };
  registry.register(TOOL, {
    spec: {
      name: TOOL,
      description: 'Odoo server version',
      input_schema: { type: 'object', properties: {} },
    },
    handler: async () => {
      ran.value = true;
      return '18.0-20260926';
    },
    agentId: ODOO_PLUGIN,
    domain: 'odoo',
    promptDoc: 'ODOO_VERSION_PROMPT_DOC',
  });
  const deps = {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: registry,
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    assistantIdentity: 'You are the platform assistant.',
  } as unknown as OrchestratorDeps;
  return { registry, ran, deps };
}

interface OrchestratorProbe {
  getSystemPrompt(): string;
  dispatchTool(n: string, i: unknown, o?: unknown, m?: unknown): Promise<string>;
  offeredToolNames(): ReadonlySet<string>;
  isToolGranted(name: string, pluginId: string | undefined): boolean;
}

function probe(built: ReturnType<typeof buildForAgent>): OrchestratorProbe {
  return built.orchestrator as unknown as OrchestratorProbe;
}

test('an un-granted plugin native tool is neither offered nor run', async () => {
  const { ran, deps } = setup();
  const orch = probe(buildForAgent(agentRow('zweiter'), deps, RUNTIME, undefined, []));

  assert.equal(orch.offeredToolNames().has(TOOL), false, 'must not be offered');
  const result = await orch.dispatchTool(TOOL, {}, undefined, undefined);
  assert.equal(ran.value, false, 'the handler must never be reached');
  assert.match(result, /not available to this agent/);
  assert.equal(result.includes(ODOO_PLUGIN), false, 'refusal must not name the plugin');
});

test('an un-granted tool is not described in the system prompt either', () => {
  const { deps } = setup();
  const denied = probe(buildForAgent(agentRow('zweiter'), deps, RUNTIME, undefined, []));
  const granted = probe(buildForAgent(agentRow('odoo'), deps, RUNTIME, undefined, [ODOO_PLUGIN]));
  assert.equal(denied.getSystemPrompt().includes('ODOO_VERSION_PROMPT_DOC'), false);
  assert.equal(granted.getSystemPrompt().includes('ODOO_VERSION_PROMPT_DOC'), true);
});

test('the grant is checked before readiness, so a refusal never names the plugin', async () => {
  const { ran, deps } = setup();
  const notReady = { ...deps, isPluginToolsReady: () => false } as OrchestratorDeps;
  const orch = probe(buildForAgent(agentRow('zweiter'), notReady, RUNTIME, undefined, []));
  const result = await orch.dispatchTool(TOOL, {}, undefined, undefined);
  assert.match(result, /not available to this agent/);
  assert.equal(result.includes(ODOO_PLUGIN), false);
  assert.equal(ran.value, false);
});

test('the granted agent is offered and runs the very same tool', async () => {
  const { ran, deps } = setup();
  const orch = probe(buildForAgent(agentRow('odoo'), deps, RUNTIME, undefined, [ODOO_PLUGIN]));

  assert.equal(orch.offeredToolNames().has(TOOL), true);
  assert.equal(await orch.dispatchTool(TOOL, {}, undefined, undefined), '18.0-20260926');
  assert.equal(ran.value, true);
});

test('an agent with no grant set at all stays ungated (legacy single-Agent boot)', async () => {
  const { ran, deps } = setup();
  const orch = probe(buildForAgent(agentRow('legacy'), deps, RUNTIME));

  assert.equal(orch.offeredToolNames().has(TOOL), true);
  assert.equal(await orch.dispatchTool(TOOL, {}, undefined, undefined), '18.0-20260926');
  assert.equal(ran.value, true);
});

test('kernel-registered tools (no owning plugin) and memory stay available to every agent', () => {
  const { deps } = setup();
  const orch = probe(buildForAgent(agentRow('zweiter'), deps, RUNTIME, undefined, []));

  assert.equal(orch.isToolGranted('run_stored_process', undefined), true);
  // The memory provider only backs the store; the kernel scopes what each
  // Agent sees, so un-granting the provider must not take memory away.
  assert.equal(orch.isToolGranted('memory', '@omadia/memory'), true);
  assert.equal(orch.isToolGranted(TOOL, ODOO_PLUGIN), false);
});

test('subscription-CLI dispatcher: an un-granted tool is neither advertised nor run', async () => {
  const { registry, ran, deps } = setup();
  const orch = probe(buildForAgent(agentRow('zweiter'), deps, RUNTIME, undefined, []));
  const dispatch = new ToolDispatchService({
    nativeTools: registry,
    isToolGranted: (name, agentId) => orch.isToolGranted(name, agentId),
  });

  assert.equal(
    dispatch.listDispatchableToolSpecs().some((s) => s.name === TOOL),
    false,
  );
  const result = await dispatch.dispatch(TOOL, {});
  assert.equal(result.isError, true);
  assert.match(result.content, /not available to this agent/);
  assert.equal(ran.value, false);
});

test('subscription-CLI dispatcher: the granted agent runs it', async () => {
  const { registry, ran, deps } = setup();
  const orch = probe(buildForAgent(agentRow('odoo'), deps, RUNTIME, undefined, [ODOO_PLUGIN]));
  const dispatch = new ToolDispatchService({
    nativeTools: registry,
    isToolGranted: (name, agentId) => orch.isToolGranted(name, agentId),
  });

  assert.equal(
    dispatch.listDispatchableToolSpecs().some((s) => s.name === TOOL),
    true,
  );
  const result = await dispatch.dispatch(TOOL, {});
  assert.notEqual(result.isError, true);
  assert.equal(ran.value, true);
});
