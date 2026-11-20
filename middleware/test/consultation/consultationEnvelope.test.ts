/**
 * Spec 2042 §5.4 / §5.11 — the real orchestrator under a consultation scope
 * and at the tool boundary:
 *
 *  - criterion 13: a consulted agent cannot call a system the asking agent has
 *    no grant for — not offered, and refused at dispatch even when named;
 *    no memory, no further consultation;
 *  - criterion 17: after reading an HR record (restricted source), a CRM write
 *    is refused before it runs, because the CRM's readership does not accept
 *    HR data; the read itself is labelled;
 *  - the `consult` tool is offered only while the broker lists a colleague.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow } from '../../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../../packages/harness-orchestrator/src/registry/applyDiff.js';
import { runAsConsultation } from '../../packages/harness-orchestrator/src/consultation/consultationScope.js';
import type { ConsultationPort } from '../../packages/harness-orchestrator/src/consultation/consultTool.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { createDiscretionTurnState } from '../../packages/harness-orchestrator/src/discretion/turnLabels.js';
import { EVERYONE, labelId, readersOf } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import type {
  DiscretionAuditEntry,
  DiscretionPort,
  IntegrationDeclaration,
} from '../../packages/harness-orchestrator/src/discretion/port.js';

const HR = '@omadia/odoo-hr';
const CRM = '@omadia/crm';
const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };

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

function deps(extra: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    assistantIdentity: 'You are a colleague.',
    ...extra,
  } as unknown as OrchestratorDeps;
}

function agentRow(slug: string): AgentRow {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as AgentRow;
}

function tool(name: string, pluginId: string, ran: string[], write = false) {
  return {
    name,
    domain: 'test.domain',
    agentId: pluginId,
    ...(write ? { writeCapabilities: [{ kind: 'create', resource: 'note' }] } : {}),
    spec: { name, description: name, input_schema: { type: 'object', properties: {}, required: [] } },
    handle: async () => {
      ran.push(name);
      return `${name} result`;
    },
  } as never;
}

type Dispatchable = {
  dispatchTool(n: string, i: unknown, o?: unknown, m?: unknown): Promise<string>;
  offeredToolNames(): ReadonlySet<string>;
};

function orchestratorOf(built: ReturnType<typeof buildForAgent>): Dispatchable {
  return built.orchestrator as unknown as Dispatchable;
}

describe('consultation envelope in the real orchestrator (criterion 13)', () => {
  it('the colleague is not offered and cannot run a system outside the envelope', async () => {
    const ran: string[] = [];
    const built = buildForAgent(agentRow('ben'), deps(), RUNTIME, undefined, [HR, CRM]);
    built.orchestrator.registerDomainTool(tool('query_odoo_hr', HR, ran));
    built.orchestrator.registerDomainTool(tool('query_crm', CRM, ran));
    const orch = orchestratorOf(built);

    // Outside a consultation: both are B's own grants.
    assert.ok(orch.offeredToolNames().has('query_odoo_hr'));

    const scope = {
      agentSlug: 'ben',
      fromAgentSlug: 'anna',
      fromTurnId: 't-1',
      callId: 'c-1',
      // Anna has no HR grant: the envelope holds the CRM only.
      allowedPluginIds: new Set([CRM]),
      memoryAccess: 'none' as const,
      result: {},
    };
    await runAsConsultation(scope, async () => {
      const offered = orch.offeredToolNames();
      assert.equal(offered.has('query_odoo_hr'), false);
      assert.equal(offered.has('memory'), false);
      assert.equal(offered.has('query_crm'), true);
      const refused = await orch.dispatchTool('query_odoo_hr', {}, undefined, undefined);
      assert.match(refused, /not available while answering a colleague's consultation/);
      const allowed = await orch.dispatchTool('query_crm', {}, undefined, undefined);
      assert.match(allowed, /query_crm result/);
    });
    assert.deepEqual(ran, ['query_crm'], 'the HR handler is never reached');

    // A scope for ANOTHER agent does not narrow this one.
    await runAsConsultation({ ...scope, agentSlug: 'someone-else' }, async () => {
      assert.ok(orch.offeredToolNames().has('query_odoo_hr'));
    });
  });

  it('`consult` is offered while the broker lists a colleague, never inside a consultation', async () => {
    let targets = [{ slug: 'ben', displayName: 'Ben' }];
    const port: ConsultationPort = {
      targetsFor: () => targets,
      consult: async () => ({ kind: 'refused', reason: 'no_grant', message: 'x' }),
    };
    const built = buildForAgent(agentRow('anna'), deps({ consultation: port }), RUNTIME, undefined, []);
    const orch = orchestratorOf(built);
    assert.ok(orch.offeredToolNames().has('consult'));
    targets = [];
    assert.equal(orch.offeredToolNames().has('consult'), false);
    targets = [{ slug: 'ben', displayName: 'Ben' }];
    await runAsConsultation(
      {
        agentSlug: 'anna',
        fromAgentSlug: 'carl',
        fromTurnId: 't',
        callId: 'c',
        allowedPluginIds: new Set(),
        memoryAccess: 'none',
        result: {},
      },
      async () => {
        assert.equal(orch.offeredToolNames().has('consult'), false, 'depth 1');
      },
    );
  });

  it('a consult without an active audience floor is refused before the broker runs', async () => {
    let called = false;
    const port: ConsultationPort = {
      targetsFor: () => [{ slug: 'ben', displayName: 'Ben' }],
      consult: async () => {
        called = true;
        return { kind: 'refused', reason: 'no_grant', message: 'x' };
      },
    };
    const built = buildForAgent(agentRow('anna'), deps({ consultation: port }), RUNTIME, undefined, []);
    const orch = orchestratorOf(built);
    const out = await turnContext.run({ turnId: 't-1', turnDate: '2026-11-20' }, () =>
      orch.dispatchTool('consult', { agent: 'ben', request: 'hi' }, undefined, undefined),
    );
    assert.match(out, /audience floor is not active/);
    assert.equal(called, false);
  });
});

describe('discretion at the tool boundary (criterion 17)', () => {
  function discretionPort(declarations: Record<string, IntegrationDeclaration>) {
    const audits: DiscretionAuditEntry[] = [];
    const port: DiscretionPort = {
      declarationOf: async (integration) => declarations[integration],
      labelsOf: async () => new Map(),
      persistLabels: async () => undefined,
      audit: (entry) => audits.push(entry),
    };
    return { port, audits };
  }

  it('reading an HR record labels the turn, and the CRM write is refused before it runs', async () => {
    const ran: string[] = [];
    const { port, audits } = discretionPort({
      [HR]: {
        sensitivity: 'restricted',
        readership: { readers: readersOf(['hr-1']), acceptsSystems: [], acceptsClassifications: [] },
      },
      [CRM]: {
        sensitivity: 'internal',
        readership: { readers: EVERYONE, acceptsSystems: [CRM], acceptsClassifications: [] },
      },
    });
    const built = buildForAgent(agentRow('anna'), deps({ discretion: port }), RUNTIME, undefined, [HR, CRM]);
    built.orchestrator.registerDomainTool(tool('query_odoo_hr', HR, ran));
    built.orchestrator.registerDomainTool(tool('crm_create_note', CRM, ran, true));
    const orch = orchestratorOf(built);
    const discretion = createDiscretionTurnState({
      contextKey: 'teams:dm-hr-manager',
      resolveReaders: async () => readersOf(['hr-1']),
    });

    await turnContext.run({ turnId: 't-17', turnDate: '2026-11-20', agentSlug: 'anna', discretion }, async () => {
      // A write before anything restricted was read goes through.
      assert.match(await orch.dispatchTool('crm_create_note', {}, undefined, undefined), /result/);
      await orch.dispatchTool('query_odoo_hr', {}, undefined, undefined);
      assert.ok(discretion.labels.labels.some((l) => labelId(l) === `source:${HR}` && l.kind === 'source' && l.restricted));
      const refused = await orch.dispatchTool('crm_create_note', {}, undefined, undefined);
      assert.match(refused, /was not called/);
      // The refusal quotes nothing of the record.
      assert.equal(refused.includes('query_odoo_hr result'), false);
    });
    assert.deepEqual(ran, ['crm_create_note', 'query_odoo_hr'], 'the second CRM write never ran');
    const refusal = audits.find((a) => !a.allowed);
    assert.ok(refusal);
    assert.equal(refusal.egress, 'integration');
    assert.equal(refusal.target, CRM);
    assert.ok(refusal.violations.includes(`source:${HR}:integration_readership`));
  });

  it('an undeclared integration receives nothing restricted; a turn without a discretion state is not checked', async () => {
    const ran: string[] = [];
    const { port } = discretionPort({
      [HR]: { sensitivity: 'restricted', readership: { readers: EVERYONE, acceptsSystems: [], acceptsClassifications: [] } },
    });
    const built = buildForAgent(agentRow('anna'), deps({ discretion: port }), RUNTIME, undefined, [HR, CRM]);
    built.orchestrator.registerDomainTool(tool('query_odoo_hr', HR, ran));
    built.orchestrator.registerDomainTool(tool('crm_create_note', CRM, ran, true));
    const orch = orchestratorOf(built);
    const discretion = createDiscretionTurnState({ contextKey: 'k', resolveReaders: async () => readersOf(['u']) });
    await turnContext.run({ turnId: 't', turnDate: '2026-11-20', discretion }, async () => {
      await orch.dispatchTool('query_odoo_hr', {}, undefined, undefined);
      assert.match(await orch.dispatchTool('crm_create_note', {}, undefined, undefined), /was not called/);
    });
    // No turn context at all (ad-hoc invocation): nothing is labelled, nothing refused.
    assert.match(await orch.dispatchTool('crm_create_note', {}, undefined, undefined), /result/);
  });
});
