/**
 * Spec 2042 §6 criterion 37 (uninstall part), §5.10: uninstalling an
 * archetype plugin with processes in `configuring`, `active`, `concluding`
 * and `following_up`, with a failing process service and a failing
 * `onUninstall`, and a restart, leaves no reservation, no later model call or
 * invitation, and one `system` notice in each home conversation — posted
 * through the channel's shared bot, localized, exactly once across restarts.
 *
 * Runs on the facilitator kernel harness (real execution authorization,
 * message hub, send services, end of service, uninstall guard and notice
 * outbox over Postgres; a simulated Teams channel; a fixture engine plugin).
 */

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';

import type { ExecutionPhase, ExecutionPurpose, ExecutionScopeKind } from '@omadia/plugin-api';

import { CHAT, CHAT_2, CHAT_3, contractSuite } from './_helpers/facilitatorContractSuite.js';
import { bootFacilitatorKernel, BUSINESS_PLUGIN, CHANNEL_TYPE, ENGINE_PLUGIN } from './_helpers/facilitatorKernelHarness.js';

const CHAT_4 = '19:retro@thread.v2';
const BUDGET = { actions: 20, modelCalls: 20 };
const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

interface Proc {
  readonly slug: string;
  readonly home: string;
  readonly processId: string;
  /** The scope the process acts under in its state, and what it would do next. */
  readonly scopeId: string;
  readonly phase: ExecutionPhase;
  readonly purpose: ExecutionPurpose;
}

await contractSuite('criterion 37: uninstalling an archetype plugin in every process state (pg)', 'archetypeUninstall', (c) => {
  /** Open a process the way an engine does: `configuring` with its home, then the scope of its state. */
  async function processIn(slug: string, home: string, state: 'configuring' | 'active' | 'concluding' | 'following_up'): Promise<Proc> {
    const processId = `facilitation-${randomUUID()}`;
    const exec = c.k.engine.execution;
    const target = { kind: 'conversation' as const, channelType: CHANNEL_TYPE, conversationId: home };
    const configuring = await exec.openScope({ agentSlug: slug, processId, kind: 'configuring', budget: BUDGET, home: { channelType: CHANNEL_TYPE, conversationId: home } });
    assert.equal(configuring.outcome, 'opened', JSON.stringify(configuring));
    if (configuring.outcome !== 'opened') throw new Error('unreachable');
    if (state === 'configuring') {
      return { slug, home, processId, scopeId: configuring.scope.id, phase: 'configuring', purpose: 'handshake' };
    }
    const open = async (kind: ExecutionScopeKind, extra: Record<string, unknown> = {}) => {
      const out = await exec.openScope({ agentSlug: slug, processId, kind, budget: BUDGET, deadline: inHours(2), targets: [target], ...extra });
      assert.equal(out.outcome, 'opened', `${kind}: ${JSON.stringify(out)}`);
      if (out.outcome !== 'opened') throw new Error('unreachable');
      return out.scope.id;
    };
    const active = await open('active');
    if (state === 'active') {
      assert.deepEqual(await c.k.engine.messages.subscribe({ agentSlug: slug, channelType: CHANNEL_TYPE, conversationId: home, processId }, { mode: 'all' }), {
        outcome: 'subscribed',
        mode: 'all',
      });
      return { slug, home, processId, scopeId: active, phase: 'active', purpose: 'moderation' };
    }
    const closing = await open('closing', { eventId: `close-${processId}` });
    if (state === 'concluding') return { slug, home, processId, scopeId: closing, phase: 'concluding', purpose: 'essential_message' };
    const followUp = await open('follow_up');
    return { slug, home, processId, scopeId: followUp, phase: 'following_up', purpose: 'invitation' };
  }

  /** Four facilitators, one process each, in four home conversations. */
  async function fourProcesses(): Promise<Proc[]> {
    const plan = [
      ['cara', CHAT, 'configuring'],
      ['ava', CHAT_2, 'active'],
      ['cleo', CHAT_3, 'concluding'],
      ['fia', CHAT_4, 'following_up'],
    ] as const;
    const out: Proc[] = [];
    for (const [slug, home, state] of plan) {
      await c.facilitator(slug, `${slug}-app`, home);
      out.push(await processIn(slug, home, state));
    }
    return out;
  }

  /** What a process would do next in its state: refused for every one of them. */
  async function nothingMoreRuns(procs: readonly Proc[]): Promise<void> {
    for (const p of procs) {
      const turn = await c.k.engine.execution.authorize({ scopeId: p.scopeId, phase: p.phase, purpose: p.purpose, action: 'model_turn', modelCalls: 1 });
      assert.notEqual(turn.outcome, 'authorized', `${p.slug} (${p.phase}) gets no model call`);
      const invite = await c.k.engine.execution.authorize({
        scopeId: p.scopeId,
        phase: p.phase,
        purpose: 'invitation',
        action: 'direct_message',
        target: { kind: 'conversation', channelType: CHANNEL_TYPE, conversationId: p.home },
        emission: 'template',
      });
      assert.notEqual(invite.outcome, 'authorized', `${p.slug} (${p.phase}) sends no invitation`);
    }
    const active = procs.find((p) => p.phase === 'active')!;
    const run = await c.k.engine.agentTurn.runTurn({
      agentSlug: active.slug,
      sessionKey: 's',
      channelType: CHANNEL_TYPE,
      conversationId: active.home,
      input: 'weiter?',
      scopeId: active.scopeId,
      processId: active.processId,
      phase: 'active',
      purpose: 'moderation',
      emission: 'prose',
      budget: { modelCalls: 1 },
    });
    assert.equal(run.outcome, 'refused');
    assert.equal(c.k.model.requests.length, 0, 'the model was never called');
    assert.equal((await c.pool.query('SELECT 1 FROM conversation_reservations WHERE released_at IS NULL')).rows.length, 0, 'no reservation');
    assert.equal((await c.pool.query(`SELECT 1 FROM execution_scopes WHERE state = 'open'`)).rows.length, 0, 'no open scope');
    assert.equal((await c.pool.query('SELECT 1 FROM conversation_message_subscriptions WHERE ended_at IS NULL')).rows.length, 0, 'no subscription');
  }

  const systemNotices = () => c.k.channel.sent.filter((s) => s.message.speaker?.kind === 'system');

  it('criterion 37: configuring, active, concluding, following_up — a failing plugin, a restart, one notice per home conversation', async () => {
    const procs = await fourProcesses();
    // The plugin misbehaves twice: its process service throws, its own onUninstall too.
    c.k.processes = { endProcessesOfAgent: () => Promise.reject(new Error('engine crashed')) };
    await c.k.uninstall(ENGINE_PLUGIN, {
      onUninstall: () => Promise.reject(new Error('close failed')),
    });
    assert.ok(c.k.logs.some((l) => /did not end the processes of 'cara': engine crashed/.test(l)));
    assert.ok(c.k.logs.some((l) => /onUninstall hook failed for .*close failed/.test(l)));
    assert.deepEqual(c.k.installed, [BUSINESS_PLUGIN]);
    for (const p of procs) assert.equal((await c.k.store.getAgentBySlug(p.slug))?.status, 'disabled', `${p.slug} disabled, record kept`);
    await nothingMoreRuns(procs);

    await c.k.notices.drain();
    const notices = systemNotices();
    assert.deepEqual(notices.map((s) => s.target).sort(), [CHAT, CHAT_2, CHAT_3, CHAT_4].sort(), 'one in each home conversation');
    for (const n of notices) {
      assert.equal(n.kind, 'conversation');
      assert.equal(n.asChannelKey, undefined, "through the shared bot, never the agent's own");
      assert.match(n.message.text, /steht nicht mehr zur Verfügung: Das Plugin für die Rolle von \w+ wurde entfernt/, 'localized (de)');
    }
    assert.deepEqual(
      notices.map((n) => (/^(\w+) steht/.exec(n.message.text) ?? [])[1]).sort(),
      ['ava', 'cara', 'cleo', 'fia'],
      'each names its agent',
    );
    assert.deepEqual(
      c.k.channel.sent.filter((s) => s.message.speaker?.kind !== 'system'),
      [],
      'nothing else was posted, nothing as an agent',
    );

    // Restart: a new kernel on the same database, without the plugin.
    await c.k.stop();
    c.k = await bootFacilitatorKernel({ pool: c.pool, installed: [BUSINESS_PLUGIN] });
    assert.equal(await c.k.notices.drain(), 0, 'a sent notice is never sent again');
    assert.deepEqual(c.k.channel.sent, []);
    await nothingMoreRuns(procs);
    for (const p of procs) assert.equal((await c.k.store.getAgentBySlug(p.slug))?.status, 'disabled');
    const rows = await c.pool.query<{ state: string; code: string }>('SELECT state, code FROM system_notice_outbox');
    assert.deepEqual(rows.rows.map((r) => [r.state, r.code]), Array.from({ length: 4 }, () => ['sent', 'archetype_plugin_removed']));
  });

  it('a notice not yet out when the instance restarts goes out once after it; a repeated uninstall owes nothing new', async () => {
    await c.facilitator('ava', 'ava-app', CHAT_2);
    const proc = await processIn('ava', CHAT_2, 'active');
    // The channel does not take the notice (platform hiccup), then the instance goes down.
    c.k.channel.nextOutcome = { outcome: 'unreachable', code: 'channel_error', message: 'bot framework 502' };
    // Crash before the plugin is gone: the agent is out of service, the plugin still installed.
    await c.k.uninstall(ENGINE_PLUGIN);
    await c.k.notices.drain();
    assert.equal(systemNotices().length, 1, 'tried once');
    const pending = await c.pool.query<{ state: string; attempts: number }>('SELECT state, attempts FROM system_notice_outbox');
    assert.deepEqual(pending.rows, [{ state: 'pending', attempts: 1 }]);
    await c.k.stop();

    // Restart with the plugin still installed; the operator repeats the
    // uninstall after re-enabling the agent the crash left half-done.
    c.k = await bootFacilitatorKernel({ pool: c.pool, installed: [ENGINE_PLUGIN, BUSINESS_PLUGIN] });
    await c.k.store.updateAgent((await c.k.store.getAgentBySlug('ava'))!.id, { status: 'enabled' });
    await c.k.registry.reload();
    // The restarted plugin answers this time, naming the process it aborted
    // in the same home conversation.
    c.k.processes = {
      endProcessesOfAgent: () =>
        Promise.resolve({ ended: [{ processId: proc.processId, channelType: CHANNEL_TYPE, conversationId: CHAT_2, outcome: 'aborted' as const }] }),
    };
    await c.k.uninstall(ENGINE_PLUGIN);
    assert.equal((await c.pool.query('SELECT 1 FROM system_notice_outbox')).rows.length, 1, 'still one notice owed');
    assert.ok(c.k.logs.some((l) => /already owed: archetype_plugin_removed for 'ava'/.test(l)));
    // Its retry is due.
    await c.pool.query('UPDATE system_notice_outbox SET next_attempt_at = now()');
    assert.equal(await c.k.notices.drain(), 1);
    assert.equal(await c.k.notices.drain(), 0);
    assert.deepEqual(systemNotices().map((s) => s.target), [CHAT_2], 'exactly once');
    assert.equal((await c.pool.query(`SELECT state FROM system_notice_outbox`)).rows[0]?.state, 'sent');
    await nothingMoreRuns([proc]);
  });
});
