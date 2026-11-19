/**
 * #2088 (K2b) — end of service of an agent.
 *
 * Disabling an agent, deleting it and removing its archetype plugin all take
 * it out of service. Before the change takes effect: the archetype plugin
 * ends its processes (while agent and plugin are still there, so it can
 * close them in the agent's own voice), the kernel ends every message
 * subscription whatever the plugin answered, the `system` notice the
 * conversation is owed goes to the #2045 seam (nothing is posted under the
 * agent's bot), and the audit says what happened to which agent and
 * conversation. A delete then keeps a tombstone.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import type { AgentEndOfServiceReason, ArchetypeProcessesService } from '@omadia/plugin-api';
import type { AgentTombstone, ConfigStore, OrchestratorRegistry, SystemNoticeRequest } from '@omadia/orchestrator';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { createAgentEndOfService, logOwedSystemNotice } from '../src/platform/agentEndOfService.js';
import { guardArchetypePluginUninstall } from '../src/platform/archetypeUninstallGuard.js';
import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const ENGINE = '@omadia/agent-facilitator';
const MARA = { id: 'id-mara', slug: 'mara', name: 'Mara', archetype: 'facilitator', status: 'enabled' };
const HR = { id: 'id-hr', slug: 'hr', name: 'HR', archetype: 'standard', status: 'enabled' };
const HOME = { channelType: 'teams', conversationId: '19:offsite@thread.v2' };
const ACTOR = { email: 'marcel@example.test' };

function setup(opts: { processes?: ArchetypeProcessesService | undefined; timeoutMs?: number } = {}) {
  const order: string[] = [];
  const audits: AuditEntryInput[] = [];
  const notices: SystemNoticeRequest[] = [];
  const logs: string[] = [];
  let subscriptions = [HOME, { channelType: 'teams', conversationId: '19:other@thread.v2' }];
  const defaultProcesses: ArchetypeProcessesService = {
    endProcessesOfAgent: (request) => {
      order.push(`plugin.endProcessesOfAgent(${request.agentSlug}, ${request.reason})`);
      return Promise.resolve({
        ended: [{ processId: 'fac-7', ...HOME, outcome: 'aborted' as const, reportPosted: true, detail: 'vote open, 2 of 4 ballots' }],
      });
    },
  };
  const service = 'processes' in opts ? opts.processes : defaultProcesses;
  const endOfService = createAgentEndOfService({
    processesFor: (archetypeId) => (archetypeId === 'facilitator' ? service : undefined),
    endSubscriptionsOf: (agentSlug, reason) => {
      order.push(`kernel.endSubscriptionsOf(${agentSlug}, ${reason})`);
      const ended = agentSlug === 'mara' ? subscriptions : [];
      if (agentSlug === 'mara') subscriptions = [];
      return Promise.resolve(ended);
    },
    audit: (entry) => {
      order.push(`audit(${entry.action})`);
      audits.push(entry);
      return Promise.resolve();
    },
    emitSystemNotice: (notice) => {
      order.push(`systemNotice(${notice.kind}, ${notice.channelKey})`);
      notices.push(notice);
    },
    ...(opts.timeoutMs !== undefined ? { processTimeoutMs: opts.timeoutMs } : {}),
    log: (m) => logs.push(m),
  });
  return { endOfService, order, audits, notices, logs };
}

describe('end of service: the procedure', () => {
  it('plugin first, then the kernel ends the subscriptions, then the notices and the audit', async () => {
    const h = setup();
    const report = await h.endOfService.run(MARA, 'agent_disabled', ACTOR);
    assert.deepEqual(h.order, [
      'plugin.endProcessesOfAgent(mara, agent_disabled)',
      'kernel.endSubscriptionsOf(mara, agent disabled)',
      'systemNotice(agent_disabled, 19:offsite@thread.v2)',
      'systemNotice(agent_disabled, 19:other@thread.v2)',
      'audit(agent.end_of_service)',
    ]);
    assert.deepEqual(
      [report.processOutcome, report.processes.length, report.subscriptionsEnded.length, report.noticesOwed],
      ['ended', 1, 2, 2],
    );
    // The notice for the conversation whose process ended names the process.
    assert.deepEqual(h.notices[0], {
      kind: 'agent_disabled',
      channelType: 'teams',
      channelKey: '19:offsite@thread.v2',
      agentId: 'id-mara',
      agentName: 'Mara',
      processId: 'fac-7',
    });
  });

  it('the audit says what happened to which agent and conversation', async () => {
    const h = setup();
    await h.endOfService.run(MARA, 'agent_deleted', ACTOR);
    assert.deepEqual(h.audits, [
      {
        actor: ACTOR,
        action: 'agent.end_of_service',
        target: 'agent:id-mara',
        after: {
          slug: 'mara',
          name: 'Mara',
          archetype: 'facilitator',
          reason: 'agent_deleted',
          process_outcome: 'ended',
          processes: [
            { processId: 'fac-7', ...HOME, outcome: 'aborted', reportPosted: true, detail: 'vote open, 2 of 4 ballots' },
          ],
          subscriptions_ended: [HOME, { channelType: 'teams', conversationId: '19:other@thread.v2' }],
          system_notices_owed: 2,
        },
      },
    ]);
  });

  it('a plugin that throws or does not answer does not keep the agent in service', async () => {
    const throwing = setup({ processes: { endProcessesOfAgent: () => Promise.reject(new Error('lease lost')) } });
    const a = await throwing.endOfService.run(MARA, 'agent_disabled', ACTOR);
    assert.deepEqual([a.processOutcome, a.processDetail, a.subscriptionsEnded.length], ['failed', 'lease lost', 2]);
    assert.match(throwing.logs.join('\n'), /did not end the processes of 'mara': lease lost/);

    const silent = setup({ processes: { endProcessesOfAgent: () => new Promise(() => undefined) }, timeoutMs: 30 });
    const started = Date.now();
    const b = await silent.endOfService.run(MARA, 'archetype_plugin_removed', ACTOR);
    assert.ok(Date.now() - started < 2_000, 'bounded wait');
    assert.deepEqual([b.processOutcome, b.processDetail, b.subscriptionsEnded.length], ['failed', 'no answer within 30 ms', 2]);
    assert.equal((silent.audits[0]?.after as { process_outcome: string }).process_outcome, 'failed');
  });

  it('an archetype without a process service, and a standard agent: the kernel part still runs', async () => {
    const none = setup({ processes: undefined });
    const a = await none.endOfService.run(MARA, 'agent_disabled', ACTOR);
    assert.deepEqual([a.processOutcome, a.subscriptionsEnded.length], ['not_supported', 2]);

    const standard = setup();
    const b = await standard.endOfService.run(HR, 'agent_deleted', ACTOR);
    assert.deepEqual([b.processOutcome, b.processes.length, b.subscriptionsEnded.length, b.noticesOwed], ['not_supported', 0, 0, 0]);
    assert.deepEqual(standard.order, ['kernel.endSubscriptionsOf(hr, agent deleted)', 'audit(agent.end_of_service)']);
  });

  it('only fields of the contract reach the audit, bounded', async () => {
    const h = setup({
      processes: {
        endProcessesOfAgent: () =>
          Promise.resolve({
            ended: [
              { processId: 'p1', ...HOME, outcome: 'aborted', smuggled: 'x', detail: 'd'.repeat(2_000) },
              { processId: 'p2', outcome: 'aborted' },
              'nonsense',
            ],
          } as never),
      },
    });
    const report = await h.endOfService.run(MARA, 'agent_disabled', ACTOR);
    assert.equal(report.processes.length, 1, 'malformed entries are left out');
    assert.equal('smuggled' in report.processes[0]!, false);
    assert.equal(report.processes[0]?.detail?.length, 500);
  });

  it('the #2045 seam today: an owed notice is logged, nothing is posted', () => {
    const lines: string[] = [];
    logOwedSystemNotice((m) => lines.push(m))({
      kind: 'agent_deleted',
      channelType: 'teams',
      channelKey: '19:offsite@thread.v2',
      agentId: 'id-mara',
      agentName: 'Mara',
      processId: 'fac-7',
    });
    assert.deepEqual(lines, [
      "[system-notice] owed, not sent (#2045): agent_deleted for 'Mara' in teams/19:offsite@thread.v2 (process fac-7)",
    ]);
  });
});

describe('kernel-guarded uninstall of an archetype plugin', () => {
  const archetypePlugin = (id: string, archetypeId: string) => ({
    id,
    plugin: { kind: 'archetype', archetype: { id: archetypeId, omits: [], adds: [], requires: [], noun: 'x' } },
  });
  function sources(plugins: ReturnType<typeof archetypePlugin>[]) {
    return () => ({
      installedRegistry: { list: () => plugins.map((p) => ({ id: p.id, status: 'active' })) } as never,
      catalog: { get: (id: string) => plugins.find((p) => p.id === id) } as never,
    });
  }

  it('its enabled agents go out of service and are disabled; nothing is deleted or converted', async () => {
    const h = setup();
    const disabled: string[] = [];
    let reloads = 0;
    const agents = [MARA, { ...MARA, id: 'id-nora', slug: 'nora', name: 'Nora' }, { ...MARA, id: 'id-ida', slug: 'ida', status: 'disabled' }, HR];
    const outcome = await guardArchetypePluginUninstall(ENGINE, {
      sources: sources([archetypePlugin(ENGINE, 'facilitator')]),
      agents: () => ({
        list: () => Promise.resolve(agents),
        disable: (id) => {
          h.order.push(`disable(${id})`);
          disabled.push(id);
          return Promise.resolve();
        },
      }),
      endOfService: h.endOfService,
      audit: (entry) => {
        h.audits.push(entry);
        return Promise.resolve();
      },
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    assert.equal(outcome?.archetypeId, 'facilitator');
    assert.deepEqual(outcome?.agents.map((a) => [a.slug, a.disabled, a.report.reason]), [
      ['mara', true, 'archetype_plugin_removed'],
      ['nora', true, 'archetype_plugin_removed'],
    ]);
    assert.deepEqual(disabled, ['id-mara', 'id-nora'], 'the standard agent and the already disabled one are left alone');
    // For each agent: its processes and subscriptions end BEFORE it is disabled.
    assert.ok(
      h.order.indexOf('plugin.endProcessesOfAgent(mara, archetype_plugin_removed)') < h.order.indexOf('disable(id-mara)'),
    );
    assert.ok(h.order.indexOf('kernel.endSubscriptionsOf(mara, archetype plugin removed)') < h.order.indexOf('disable(id-mara)'));
    const disableAudits = h.audits.filter((a) => a.action === 'agent.disable');
    assert.equal(disableAudits.length, 2);
    assert.deepEqual(disableAudits[0]?.after, {
      status: 'disabled',
      slug: 'mara',
      archetype: 'facilitator',
      reason: 'archetype_plugin_removed',
      plugin: ENGINE,
    });
    assert.equal(disableAudits[0]?.actor.email, 'system:archetype-plugin-uninstall');
    assert.equal(reloads, 1);
  });

  it('another plugin, or one that is not an archetype plugin: nothing is touched', async () => {
    const h = setup();
    const deps = {
      sources: sources([archetypePlugin(ENGINE, 'facilitator')]),
      agents: () => ({
        list: () => Promise.reject(new Error('must not be asked')),
        disable: () => Promise.reject(new Error('must not be asked')),
      }),
      endOfService: h.endOfService,
    };
    assert.equal(await guardArchetypePluginUninstall('@omadia/integration-odoo', deps), undefined);
    assert.deepEqual(h.order, []);
  });

  it('a store that fails does not stop the uninstall', async () => {
    const h = setup();
    const logs: string[] = [];
    const outcome = await guardArchetypePluginUninstall(ENGINE, {
      sources: sources([archetypePlugin(ENGINE, 'facilitator')]),
      agents: () => ({
        list: () => Promise.resolve([MARA]),
        disable: () => Promise.reject(new Error('connection lost')),
      }),
      endOfService: h.endOfService,
      log: (m) => logs.push(m),
    });
    assert.deepEqual(outcome?.agents.map((a) => [a.slug, a.disabled]), [['mara', false]]);
    assert.match(logs.join('\n'), /disabling 'mara' failed: connection lost/);
  });
});

describe('agent routes: disable, delete, deleted agents, purge', () => {
  let server: Server;
  let base: string;
  let agents: (typeof MARA)[];
  let tombstones: AgentTombstone[];
  let order: string[];
  let audits: AuditEntryInput[];
  let retentionDays: number;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  before(async () => {
    const store = {
      getAgentBySlug: (slug: string) => Promise.resolve(agents.find((a) => a.slug === slug)),
      getPlatformSettings: () => Promise.resolve({ fallbackAgentId: 'id-hr', updatedAt: new Date(0) }),
      updateAgent: (id: string, patch: { status?: string }) => {
        order.push(`store.updateAgent(${id}, ${JSON.stringify(patch)})`);
        agents = agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) as typeof agents;
        return Promise.resolve();
      },
      deleteAgent: (id: string, deletedBy?: string) => {
        order.push(`store.deleteAgent(${id}, ${String(deletedBy)})`);
        const agent = agents.find((a) => a.id === id);
        if (!agent) return Promise.resolve(undefined);
        agents = agents.filter((a) => a.id !== id);
        const tombstone: AgentTombstone = {
          id,
          slug: agent.slug,
          name: agent.name,
          archetype: agent.archetype,
          deletedAt: new Date().toISOString(),
          deletedBy: deletedBy ?? null,
        };
        tombstones.push(tombstone);
        return Promise.resolve(tombstone);
      },
      listTombstones: () => Promise.resolve(tombstones),
      purgeAgent: (id: string) => {
        order.push(`store.purgeAgent(${id})`);
        const had = tombstones.some((t) => t.id === id);
        tombstones = tombstones.filter((t) => t.id !== id);
        return Promise.resolve(had);
      },
    } as unknown as ConfigStore;
    const registry = { reload: () => Promise.resolve({ actions: [] }), get: () => undefined } as unknown as OrchestratorRegistry;
    const app = express();
    app.use(express.json());
    app.use(
      '/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => store,
        getRegistry: () => registry,
        getChatSessionStore: () => undefined,
        endOfService: {
          run: (agent: { id: string; slug: string; name: string }, reason: AgentEndOfServiceReason) => {
            order.push(`endOfService(${agent.slug}, ${reason})`);
            return Promise.resolve({
              agentId: agent.id,
              agentSlug: agent.slug,
              agentName: agent.name,
              archetype: 'facilitator',
              reason,
              processOutcome: 'ended' as const,
              processes: [{ processId: 'fac-7', ...HOME, outcome: 'aborted' as const, reportPosted: true }],
              subscriptionsEnded: [HOME],
              noticesOwed: 1,
            });
          },
        },
        recordAudit: (entry: AuditEntryInput) => {
          order.push(`audit(${entry.action})`);
          audits.push(entry);
          return Promise.resolve();
        },
        get tombstoneRetentionDays() {
          return retentionDays;
        },
      } as never),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/agents`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  beforeEach(() => {
    agents = [{ ...MARA }, { ...HR }];
    tombstones = [];
    order = [];
    audits = [];
    retentionDays = 30;
  });

  it('disable: end of service runs before the status changes, and the answer says what ended', async () => {
    const res = await call('PATCH', '/mara', { status: 'disabled' });
    assert.equal(res.status, 200);
    assert.deepEqual(order, [
      'endOfService(mara, agent_disabled)',
      'store.updateAgent(id-mara, {"status":"disabled"})',
      'audit(agent.disable)',
    ]);
    assert.deepEqual(res.json['end_of_service'], {
      reason: 'agent_disabled',
      process_outcome: 'ended',
      processes: [
        { process_id: 'fac-7', channel_type: 'teams', conversation_id: '19:offsite@thread.v2', outcome: 'aborted', report_posted: true },
      ],
      subscriptions_ended: [{ channel_type: 'teams', conversation_id: '19:offsite@thread.v2' }],
      system_notices_owed: 1,
    });
    assert.deepEqual(audits[0]?.before, { status: 'enabled' });
  });

  it('a rename, and disabling an agent that is already disabled, end nothing', async () => {
    await call('PATCH', '/mara', { name: 'Mara M.' });
    agents = agents.map((a) => ({ ...a, status: a.slug === 'mara' ? 'disabled' : a.status }));
    await call('PATCH', '/mara', { status: 'disabled' });
    assert.equal(order.some((o) => o.startsWith('endOfService')), false);
    // Re-enabling never resumes anything: it is a status change and an audit row.
    order = [];
    await call('PATCH', '/mara', { status: 'enabled' });
    assert.deepEqual(order, ['store.updateAgent(id-mara, {"status":"enabled"})', 'audit(agent.disable)']);
    assert.deepEqual(audits.at(-1)?.after, { status: 'enabled', slug: 'mara', archetype: 'facilitator' });
  });

  it('delete: end of service, then a tombstone, and the agent is in the list of deleted agents', async () => {
    const res = await call('DELETE', '/mara');
    assert.equal(res.status, 200);
    assert.deepEqual(order, ['endOfService(mara, agent_deleted)', 'store.deleteAgent(id-mara, undefined)', 'audit(agent.delete)']);
    const tombstone = res.json['tombstone'] as Record<string, unknown>;
    assert.deepEqual([tombstone['slug'], tombstone['name'], tombstone['archetype'], tombstone['purgeable_without_confirmation']], [
      'mara',
      'Mara',
      'facilitator',
      false,
    ]);
    assert.equal((res.json['end_of_service'] as { reason: string }).reason, 'agent_deleted');
    assert.deepEqual(audits[0]?.before, { slug: 'mara', name: 'Mara', status: 'enabled', archetype: 'facilitator' });

    const list = await call('GET', '/deleted');
    assert.equal(list.json['retention_days'], 30);
    assert.deepEqual((list.json['agents'] as { slug: string }[]).map((a) => a.slug), ['mara']);
    assert.equal((await call('PATCH', '/mara', { name: 'x' })).status, 404, 'it is no agent any more');
  });

  it('the default agent is neither disabled nor deleted, and nothing ends for it', async () => {
    assert.equal((await call('DELETE', '/hr')).status, 409);
    assert.equal((await call('PATCH', '/hr', { status: 'disabled' })).status, 409);
    assert.deepEqual(order, []);
  });

  it('purge: inside the retention period it needs the slug typed out; after it, or with the slug, it is the hard delete', async () => {
    await call('DELETE', '/mara');
    order = [];
    audits = [];
    const refused = await call('POST', '/deleted/id-mara/purge', {});
    assert.equal(refused.status, 409);
    assert.equal(refused.json['error'], 'purge_confirmation_required');
    assert.match(String(refused.json['message']), /deleted less than 30 days ago; send \{ "confirm": "mara" \}/);
    assert.equal((await call('POST', '/deleted/id-mara/purge', { confirm: 'hr' })).status, 409);
    assert.deepEqual(order, [], 'nothing was removed');

    const purged = await call('POST', '/deleted/id-mara/purge', { confirm: 'mara' });
    assert.deepEqual([purged.status, purged.json['ok']], [200, true]);
    assert.deepEqual(order, ['store.purgeAgent(id-mara)', 'audit(agent.purge)']);
    assert.deepEqual(audits[0]?.after, { purged: true });
    assert.equal((await call('POST', '/deleted/id-mara/purge', { confirm: 'mara' })).status, 404);

    // After the retention period no confirmation is needed.
    agents = [{ ...MARA }, { ...HR }];
    await call('DELETE', '/mara');
    retentionDays = 0;
    assert.equal((await call('POST', '/deleted/id-mara/purge', {})).status, 200);
    // A live agent cannot be purged: it is not in the list of deleted agents.
    assert.equal((await call('POST', '/deleted/id-hr/purge', { confirm: 'hr' })).status, 404);
  });

  it('`deleted` cannot be taken as a slug', async () => {
    const res = await call('POST', '', { slug: 'deleted', name: 'X' });
    assert.equal(res.status >= 400 && res.status < 500, true);
    assert.match(String(res.json['message']), /reserved/);
  });
});
