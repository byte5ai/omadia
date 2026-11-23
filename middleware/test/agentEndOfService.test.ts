/**
 * #2088 (K2b) — end of service of an agent.
 *
 * Disabling an agent, deleting it and removing its archetype plugin all take
 * it out of service. Before the change takes effect: the archetype plugin
 * ends its processes (while agent and plugin are still there, so it can
 * close them in the agent's own voice), the kernel ends every message
 * subscription whatever the plugin answered, each affected conversation is
 * handed one `system` notice (the outbox posts it through the shared bot,
 * `systemNoticeOutbox.ts`; nothing under the agent's bot), and the audit says
 * what happened to which agent and conversation. A delete then keeps a
 * tombstone.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import type { AgentEndOfServiceReason, ArchetypeProcessesService } from '@omadia/plugin-api';
import type { AgentTombstone, ConfigStore, OrchestratorRegistry, SystemNoticeRequest } from '@omadia/orchestrator';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { createAgentEndOfService } from '../src/platform/agentEndOfService.js';
import { guardArchetypePluginUninstall } from '../src/platform/archetypeUninstallGuard.js';
import { createOperatorAgentsRouter } from '../src/routes/operatorAgents.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const ENGINE = '@omadia/agent-facilitator';
const MARA = { id: 'id-mara', slug: 'mara', name: 'Mara', archetype: 'facilitator', status: 'enabled' };
const HR = { id: 'id-hr', slug: 'hr', name: 'HR', archetype: 'standard', status: 'enabled' };
const HOME = { channelType: 'teams', conversationId: '19:offsite@thread.v2' };
const SESSION = { channelType: 'teams', conversationId: '19:meeting_session@thread.v2' };
const ACTOR = { email: 'marcel@example.test' };

function setup(
  opts: { processes?: ArchetypeProcessesService | undefined; timeoutMs?: number; revoke?: 'works' | 'fails' } = {},
) {
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
    ...(opts.revoke
      ? {
          revokeExecution: (agentId: string, reason: string) => {
            order.push(`kernel.revokeExecution(${agentId}, ${reason})`);
            return opts.revoke === 'fails'
              ? Promise.reject(new Error('connection lost'))
              : Promise.resolve({ scopesEnded: 3, reservationsReleased: [HOME, SESSION] });
          },
        }
      : {}),
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
      agentSlug: 'mara',
      processId: 'fac-7',
    });
  });

  it('#2090: the kernel revokes scopes and reservations after the plugin spoke, and a released conversation is owed a notice', async () => {
    const h = setup({ revoke: 'works' });
    const report = await h.endOfService.run(MARA, 'agent_deleted', ACTOR);
    assert.deepEqual(h.order.slice(0, 3), [
      'plugin.endProcessesOfAgent(mara, agent_deleted)',
      'kernel.endSubscriptionsOf(mara, agent deleted)',
      'kernel.revokeExecution(id-mara, agent deleted)',
    ]);
    assert.equal(report.scopesEnded, 3);
    assert.deepEqual(report.reservationsReleased, [HOME, SESSION]);
    // Offsite (process, subscription, reservation: once), the other
    // subscription, and the session conversation that was only reserved.
    assert.deepEqual(h.notices.map((n) => n.channelKey).sort(), [HOME.conversationId, '19:other@thread.v2', SESSION.conversationId].sort());
    const after = h.audits[0]?.after as Record<string, unknown>;
    assert.equal(after['execution_scopes_ended'], 3);
    assert.deepEqual(after['reservations_released'], [HOME, SESSION]);
  });

  it('#2090: a revocation that fails does not keep the agent in service', async () => {
    const h = setup({ revoke: 'fails' });
    const report = await h.endOfService.run(MARA, 'agent_disabled', ACTOR);
    assert.equal(report.scopesEnded, 0);
    assert.equal(report.subscriptionsEnded.length, 2);
    assert.match(h.logs.join('\n'), /revoking the execution scopes of 'mara' failed: connection lost/);
    assert.equal(h.audits.length, 1);
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
          execution_scopes_ended: 0,
          reservations_released: [],
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

  it('criterion 37: each conversation gets one notice request naming the agent, and the procedure waits for it to be kept', async () => {
    const kept: string[] = [];
    const endOfService = createAgentEndOfService({
      processesFor: () => undefined,
      endSubscriptionsOf: () => Promise.resolve([HOME, HOME, SESSION]),
      emitSystemNotice: async (notice) => {
        await new Promise((r) => setTimeout(r, 5));
        kept.push(`${notice.kind}:${notice.agentSlug ?? ''}:${notice.agentName}:${notice.channelKey}`);
      },
    });
    const report = await endOfService.run(MARA, 'archetype_plugin_removed', ACTOR);
    assert.deepEqual(kept, [
      `archetype_plugin_removed:mara:Mara:${HOME.conversationId}`,
      `archetype_plugin_removed:mara:Mara:${SESSION.conversationId}`,
    ]);
    assert.equal(report.noticesOwed, 2);
  });

  it('a notice that cannot be kept does not stop the end of service', async () => {
    const endOfService = createAgentEndOfService({
      processesFor: () => undefined,
      endSubscriptionsOf: () => Promise.resolve([HOME]),
      emitSystemNotice: () => Promise.reject(new Error('outbox down')),
    });
    const report = await endOfService.run(MARA, 'agent_disabled', ACTOR);
    assert.equal(report.noticesOwed, 1);
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

  it('#2090: revokes every scope of the plugin, also with no enabled agent, and survives a failure', async () => {
    const h = setup();
    const revoked: string[] = [];
    const logs: string[] = [];
    const base = {
      sources: sources([archetypePlugin(ENGINE, 'facilitator')]),
      agents: () => ({ list: () => Promise.resolve([{ ...MARA, status: 'disabled' }]), disable: () => Promise.resolve() }),
      endOfService: h.endOfService,
      log: (m: string) => logs.push(m),
    };
    await guardArchetypePluginUninstall(ENGINE, {
      ...base,
      revokeExecutionOfPlugin: (pluginId, reason) => {
        revoked.push(`${pluginId}: ${reason}`);
        return Promise.resolve({ scopesEnded: 2 });
      },
    });
    assert.deepEqual(revoked, [`${ENGINE}: archetype plugin removed`]);
    assert.match(logs.join('\n'), /2 further execution scope\(s\) ended/);
    const outcome = await guardArchetypePluginUninstall(ENGINE, {
      ...base,
      revokeExecutionOfPlugin: () => Promise.reject(new Error('connection lost')),
    });
    assert.equal(outcome?.archetypeId, 'facilitator');
    assert.match(logs.join('\n'), /revoking the execution scopes of '@omadia\/agent-facilitator' failed: connection lost/);
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
  /** What the channel plugins answer when a purged agent's own bots are stopped. */
  let botRelease: { ok: boolean; failed: string[]; notReleased: string[] } = { ok: true, failed: [], notReleased: [] };

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
              scopesEnded: 2,
              reservationsReleased: [HOME],
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
        releaseChannelIdentities: (agentId: string) => {
          order.push(`releaseBots(${agentId})`);
          return Promise.resolve(botRelease);
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
      execution_scopes_ended: 2,
      reservations_released: [{ channel_type: 'teams', conversation_id: '19:offsite@thread.v2' }],
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

  it('#2055: the default agent is disabled and deleted like any other, with its end of service', async () => {
    // There is no fallback agent to protect: its conversations get a notice
    // naming it (INV-7), never another agent's answer.
    assert.equal((await call('PATCH', '/hr', { status: 'disabled' })).status, 200);
    assert.equal((await call('DELETE', '/hr')).status, 200);
    assert.deepEqual(
      order.filter((o) => o.startsWith('endOfService') || o.startsWith('store.')),
      [
        'endOfService(hr, agent_disabled)',
        'store.updateAgent(id-hr, {"status":"disabled"})',
        'endOfService(hr, agent_deleted)',
        'store.deleteAgent(id-hr, undefined)',
      ],
    );
  });

  it("purge: the agent's own bots are stopped first; a bot an active plugin cannot stop holds the purge", async () => {
    agents = [{ ...MARA }, { ...HR }];
    tombstones = [];
    retentionDays = 0;
    await call('DELETE', '/mara');
    order = [];
    botRelease = { ok: false, failed: ['telegram:tg:7000000001'], notReleased: [] };
    const held = await call('POST', '/deleted/id-mara/purge', {});
    assert.deepEqual([held.status, held.json['error']], [502, 'channel_identity_release_failed']);
    assert.deepEqual(order, ['releaseBots(id-mara)'], 'nothing was purged');
    botRelease = { ok: true, failed: [], notReleased: ['slack:slack-bot:u1'] };
    const purged = await call('POST', '/deleted/id-mara/purge', {});
    assert.deepEqual([purged.status, purged.json['bots_not_released']], [200, ['slack:slack-bot:u1']]);
    botRelease = { ok: true, failed: [], notReleased: [] };
    retentionDays = 30;
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
    assert.deepEqual(order, ['releaseBots(id-mara)', 'store.purgeAgent(id-mara)', 'audit(agent.purge)']);
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
