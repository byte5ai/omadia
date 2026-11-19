// /api/v1/operator/execution (#2090) — what archetype plugins are currently
// allowed to do, and the operator's kill switch.
//
//   GET    /                    open execution scopes and set kill switches
//   POST   /kill-switches       set one: { level, agent_slug?, process_id?, reason? }
//   DELETE /kill-switches/:id   clear one
//   POST   /discussions/:workflowId/stop   stop a running agent discussion
//   POST   /reservations/:id/release       release one held conversation
//
// A set switch refuses every authorization in its reach (the instance, one
// agent, one process of an agent). It ends nothing: clearing it lets the
// scopes continue within their own deadlines and budgets.
//
// Reservations (rollout defect D34): every conversation that is held right
// now is listed, whoever holds it, so nothing can block a conversation unseen.
// Releasing one frees the conversation for the next process; it ends no
// process and no discussion, and a process that read every message there is
// turned down to the messages that address its agent.
//
// Agent discussions (#2067) are Conductor runs agents started themselves, not
// execution scopes: `GET /` lists them next to the scopes, and their stop is
// final — the run is cancelled and its conversation released.

import { Router, type Request, type Response } from 'express';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { ConductorDiscussionAdmin, RunningDiscussion } from '../conductor/discussionAdmin.js';
import type { ExecutionScopeStore, KillSwitch, ReservationRow, ScopeRow } from '../execution/scopeStore.js';

const MAX_SCOPES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OperatorExecutionDeps {
  /** Absent = no database: the routes answer 503. */
  readonly store: () => ExecutionScopeStore | undefined;
  /** A live agent by slug, enabled or disabled. */
  readonly agentBySlug: (slug: string) => Promise<{ id: string; slug: string } | undefined>;
  /** Slugs of live agents by id, for display. */
  readonly agentSlugs: () => Promise<ReadonlyMap<string, string>>;
  /** Absent until the Conductor is wired (and without a database): no
   *  discussions are listed and the stop answers 503. */
  readonly discussions?: () => Pick<ConductorDiscussionAdmin, 'list' | 'stop'> | undefined;
  /** Told after a reservation was released: message subscriptions follow. */
  readonly onAccessChanged?: () => void;
  readonly audit?: (entry: AuditEntryInput) => Promise<void>;
}

const MAX_RESERVATIONS = 500;

function reservationDto(r: ReservationRow, slugs: ReadonlyMap<string, string>) {
  return {
    id: r.id,
    channel_type: r.channelType,
    conversation_id: r.conversationId,
    holder_kind: r.holderKind,
    agent_slug: r.agentId ? (slugs.get(r.agentId) ?? null) : null,
    plugin_id: r.pluginId ?? null,
    process_id: r.processId,
    role: r.role,
    reserved_at: r.reservedAt,
  };
}

function discussionDto(d: RunningDiscussion) {
  return {
    workflow_id: d.workflowId,
    slug: d.slug,
    opened_by: d.openedBy,
    participants: d.participants,
    topic: d.topic,
    conversation: d.conversation
      ? { channel_type: d.conversation.channelType, conversation_id: d.conversation.conversationId }
      : null,
    status: d.status,
    started_at: d.startedAt,
    stop_requested_at: d.stopRequestedAt,
    expires_at: d.expiresAt,
    incomplete: d.incomplete,
  };
}

function killSwitchDto(k: KillSwitch, slugs: ReadonlyMap<string, string>) {
  return {
    id: k.id,
    level: k.level,
    agent_slug: k.agentId ? (slugs.get(k.agentId) ?? null) : null,
    process_id: k.processId ?? null,
    reason: k.reason,
    set_by: k.setBy,
    set_at: k.setAt,
  };
}

function reaches(k: KillSwitch, scope: ScopeRow): boolean {
  if (k.level === 'instance') return true;
  if (k.agentId !== scope.agentId) return false;
  return k.level === 'agent' || k.processId === scope.processId;
}

function scopeDto(scope: ScopeRow, switches: readonly KillSwitch[]) {
  return {
    id: scope.id,
    agent_slug: scope.agentSlug,
    plugin_id: scope.pluginId,
    process_id: scope.processId,
    kind: scope.kind,
    event_id: scope.eventId || null,
    deadline: scope.deadline,
    absolute_limit: scope.absoluteLimit,
    deadline_wait: scope.deadlineWait,
    budget: { actions: scope.budget.actions, model_calls: scope.budget.modelCalls },
    used: { actions: scope.used.actions, model_calls: scope.used.modelCalls },
    conversations: scope.targets.filter((t) => t.kind === 'conversation').length,
    people: scope.targets.filter((t) => t.kind === 'person').length,
    opened_at: scope.openedAt,
    stopped: switches.some((k) => reaches(k, scope)),
  };
}

export function createOperatorExecutionRouter(deps: OperatorExecutionDeps): Router {
  const router = Router();
  const unavailable = (res: Response): void => {
    res.status(503).json({ code: 'execution.unavailable', message: 'execution scopes need a database' });
  };

  router.get('/', async (_req: Request, res: Response) => {
    const store = deps.store();
    if (!store) return unavailable(res);
    try {
      // A failing discussion listing must not take the kill switch off the
      // page: it is reported as such, never as "none running".
      let discussionsFailed = false;
      const listDiscussions = async (): Promise<RunningDiscussion[]> => {
        try {
          return (await deps.discussions?.()?.list()) ?? [];
        } catch (err) {
          discussionsFailed = true;
          console.error('[execution] listing running discussions failed:', err);
          return [];
        }
      };
      const [switches, scopes, slugs, discussions, reservations] = await Promise.all([
        store.listKillSwitches(),
        store.listOpenScopes(MAX_SCOPES),
        deps.agentSlugs(),
        listDiscussions(),
        store.listHeldReservations(MAX_RESERVATIONS),
      ]);
      res.json({
        kill_switches: switches.map((k) => killSwitchDto(k, slugs)),
        scopes: scopes.map((s) => scopeDto(s, switches)),
        discussions: discussions.map(discussionDto),
        discussions_failed: discussionsFailed,
        reservations: reservations.map((r) => reservationDto(r, slugs)),
      });
    } catch (err) {
      res.status(500).json({ code: 'execution.failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/kill-switches', async (req: Request, res: Response) => {
    const store = deps.store();
    if (!store) return unavailable(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const level = body['level'];
    if (level !== 'instance' && level !== 'agent' && level !== 'process') {
      res.status(400).json({ code: 'execution.invalid', message: "level is 'instance', 'agent' or 'process'" });
      return;
    }
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim().slice(0, 500) : '';
    try {
      let agent: { id: string; slug: string } | undefined;
      let processId: string | undefined;
      if (level !== 'instance') {
        const slug = typeof body['agent_slug'] === 'string' ? body['agent_slug'].trim() : '';
        agent = slug ? await deps.agentBySlug(slug) : undefined;
        if (!agent) {
          res.status(404).json({ code: 'execution.unknown_agent', message: 'no such agent' });
          return;
        }
      }
      if (level === 'process') {
        processId = typeof body['process_id'] === 'string' ? body['process_id'].trim().slice(0, 200) : '';
        if (!processId) {
          res.status(400).json({ code: 'execution.invalid', message: 'process_id is required for level process' });
          return;
        }
      }
      const actor = auditActorFromRequest(req);
      const set = await store.setKillSwitch({
        level,
        reason,
        setBy: actor.email ?? actor.id ?? 'operator',
        ...(agent ? { agentId: agent.id } : {}),
        ...(processId ? { processId } : {}),
      });
      await deps
        .audit?.({
          actor,
          action: 'execution.kill_switch_set',
          target: `kill-switch:${set.id}`,
          after: { level, agent: agent?.slug ?? null, process_id: processId ?? null, reason },
        })
        .catch(() => undefined);
      res.status(201).json({ kill_switch: killSwitchDto(set, new Map(agent ? [[agent.id, agent.slug]] : [])) });
    } catch (err) {
      res.status(500).json({ code: 'execution.failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/kill-switches/:id', async (req: Request, res: Response) => {
    const store = deps.store();
    if (!store) return unavailable(res);
    const id = String(req.params['id'] ?? '');
    if (!UUID.test(id)) {
      res.status(404).json({ code: 'execution.unknown_kill_switch', message: 'no such kill switch' });
      return;
    }
    try {
      const actor = auditActorFromRequest(req);
      const cleared = await store.clearKillSwitch(id, actor.email ?? actor.id ?? 'operator');
      if (!cleared) {
        res.status(404).json({ code: 'execution.unknown_kill_switch', message: 'no such kill switch, or already cleared' });
        return;
      }
      await deps
        .audit?.({
          actor,
          action: 'execution.kill_switch_clear',
          target: `kill-switch:${cleared.id}`,
          before: { level: cleared.level, process_id: cleared.processId ?? null, reason: cleared.reason },
        })
        .catch(() => undefined);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ code: 'execution.failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/reservations/:id/release', async (req: Request, res: Response) => {
    const store = deps.store();
    if (!store) return unavailable(res);
    const id = String(req.params['id'] ?? '');
    if (!UUID.test(id)) {
      res.status(404).json({ code: 'execution.unknown_reservation', message: 'no such held reservation' });
      return;
    }
    try {
      const actor = auditActorFromRequest(req);
      const released = await store.releaseReservation(id, `released by ${actor.email ?? actor.id ?? 'operator'}`);
      if (!released) {
        res.status(404).json({ code: 'execution.unknown_reservation', message: 'no such held reservation, or already released' });
        return;
      }
      deps.onAccessChanged?.();
      await deps
        .audit?.({
          actor,
          action: 'execution.reservation_release',
          target: `reservation:${released.id}`,
          before: {
            channel_type: released.channelType,
            conversation_id: released.conversationId,
            holder_kind: released.holderKind,
            process_id: released.processId,
          },
        })
        .catch(() => undefined);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ code: 'execution.failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/discussions/:workflowId/stop', async (req: Request, res: Response) => {
    const discussions = deps.discussions?.();
    if (!discussions) return unavailable(res);
    const workflowId = String(req.params['workflowId'] ?? '');
    if (!UUID.test(workflowId)) {
      res.status(404).json({ code: 'execution.unknown_discussion', message: 'no such running discussion' });
      return;
    }
    try {
      const actor = auditActorFromRequest(req);
      const result = await discussions.stop(workflowId, actor.email ?? actor.id ?? 'operator');
      if (result.outcome === 'not_found') {
        res.status(404).json({ code: 'execution.unknown_discussion', message: 'no such running discussion' });
        return;
      }
      if (result.outcome === 'cancel_failed') {
        // Nothing was disposed on purpose: the discussion stays listed so the
        // operator can retry.
        res.status(502).json({
          code: 'execution.discussion_stop_failed',
          message: `${String(result.failedRuns)} run(s) could not be cancelled; the discussion is still listed, retry`,
        });
        return;
      }
      await deps
        .audit?.({
          actor,
          action: 'conductor.discussion_stop',
          target: `conductor-workflow:${result.slug}`,
          before: { workflowId },
          after: { cancelledRuns: result.cancelledRuns },
        })
        .catch(() => undefined);
      res.json({ ok: true, cancelled_runs: result.cancelledRuns });
    } catch (err) {
      res.status(500).json({ code: 'execution.failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
