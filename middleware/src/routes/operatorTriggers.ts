// /api/v1/operator/triggers (#2082, spec 2042 §5.12 "Visible") — every
// active trigger of every agent with purpose, context, deadline and cost so
// far, the month's spend against the caps, and the operator's controls.
//
//   GET    /                      triggers + spend of this month + caps,
//                                  plugin jobs (recovery probes) and the
//                                  registered batch jobs
//   GET    /:id/audit             creation, firings, pauses, end (newest first)
//   POST   /:id/pause             pause one (it keeps its deadline)
//   POST   /:id/resume            resume one (breaker starts over)
//   DELETE /:id                   end one now
//   PUT    /recipient-profiles    { recipient_key, timezone?, quiet_from?, quiet_to?, max_per_hour? }
//
// The kill switch that stops all triggers at once is the execution kill
// switch (/api/v1/operator/execution, level instance or agent).

import { Router, type Request, type Response } from 'express';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { RecipientProfileStore } from '../triggers/proactiveGate.js';
import type { TriggerService } from '../triggers/triggerService.js';
import { spendMonth, type TriggerStore } from '../triggers/triggerStore.js';
import { triggerSummary } from '../triggers/triggerTools.js';
import type { JobStatus } from '../plugins/jobScheduler.js';

const MAX_TRIGGERS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface OperatorTriggersDeps {
  /** Absent = no database or triggers not wired: the routes answer 503. */
  readonly triggers: () =>
    | { readonly service: TriggerService; readonly store: TriggerStore; readonly profiles: RecipientProfileStore }
    | undefined;
  readonly audit?: (entry: AuditEntryInput) => Promise<void>;
  /** Plugin background jobs and their recovery state (`JobScheduler.list`). */
  readonly jobs?: () => readonly JobStatus[];
  /** Registered batch jobs (learning, consolidation). */
  readonly batchJobs?: () => readonly { readonly id: string; readonly purpose: string; readonly intervalMinutes: number }[];
}

export function createOperatorTriggersRouter(deps: OperatorTriggersDeps): Router {
  const router = Router();
  const unavailable = (res: Response): void => {
    res.status(503).json({ code: 'triggers.unavailable', message: 'triggers need a database' });
  };
  const fail = (res: Response, err: unknown): void => {
    res.status(500).json({ code: 'triggers.failed', message: err instanceof Error ? err.message : String(err) });
  };
  const idOf = (req: Request, res: Response): string | undefined => {
    const id = String(req.params['id'] ?? '');
    if (UUID.test(id)) return id;
    res.status(400).json({ code: 'triggers.invalid_id', message: 'id must be a trigger id' });
    return undefined;
  };
  const audit = async (req: Request, action: AuditEntryInput['action'], target: string, after: unknown): Promise<void> => {
    await deps.audit?.({ actor: auditActorFromRequest(req), action, target, after }).catch(() => undefined);
  };

  router.get('/', async (_req: Request, res: Response) => {
    const t = deps.triggers();
    if (!t) return unavailable(res);
    try {
      const month = spendMonth(new Date());
      const limits = t.service.limits;
      const triggers = await t.service.listAll(MAX_TRIGGERS);
      const agentIds = [...new Set(triggers.map((x) => x.agentId))];
      const perAgent = await Promise.all(
        agentIds.map(async (id) => [id, await t.store.monthSpend(id, month)] as const),
      );
      res.json({
        month,
        instance: await t.store.monthSpend('instance', month),
        caps: {
          monthlyInstanceUsd: limits.monthlyInstanceUsd,
          monthlyAgentUsd: limits.monthlyAgentUsd,
          perTriggerUsd: limits.perTriggerUsdMax,
          perFiringUsd: limits.perFiringUsdMax,
          maxActivePerAgent: limits.maxActivePerAgent,
        },
        agents: Object.fromEntries(perAgent),
        jobs: deps.jobs?.() ?? [],
        batchJobs: (deps.batchJobs?.() ?? []).map((j) => ({ id: j.id, purpose: j.purpose, intervalMinutes: j.intervalMinutes })),
        triggers: triggers.map((x) => ({
          ...triggerSummary(x),
          agent: x.agentSlug,
          agentId: x.agentId,
          origin: x.origin,
          contextId: x.contextId,
          createdBy: x.createdBy,
          createdAt: x.createdAt.toISOString(),
          lastFiredAt: x.lastFiredAt?.toISOString() ?? null,
          lastError: x.lastError,
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/audit', async (req: Request, res: Response) => {
    const t = deps.triggers();
    if (!t) return unavailable(res);
    const id = idOf(req, res);
    if (!id) return;
    try {
      res.json({ audit: await t.store.auditOf(id, 200) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/pause', async (req: Request, res: Response) => {
    const t = deps.triggers();
    if (!t) return unavailable(res);
    const id = idOf(req, res);
    if (!id) return;
    try {
      const actor = auditActorFromRequest(req);
      const paused = await t.service.pause(id, 'operator', actor.email ?? actor.id ?? 'operator');
      if (!paused) {
        res.status(404).json({ code: 'triggers.not_found', message: 'no such trigger' });
        return;
      }
      await audit(req, 'trigger.pause', `trigger:${id}`, { agent: paused.agentSlug, purpose: paused.purpose });
      res.json({ trigger: triggerSummary(paused) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/resume', async (req: Request, res: Response) => {
    const t = deps.triggers();
    if (!t) return unavailable(res);
    const id = idOf(req, res);
    if (!id) return;
    try {
      const actor = auditActorFromRequest(req);
      const resumed = await t.service.resume(id, actor.email ?? actor.id ?? 'operator');
      if (!resumed) {
        res.status(404).json({ code: 'triggers.not_found', message: 'no such trigger' });
        return;
      }
      await audit(req, 'trigger.resume', `trigger:${id}`, { agent: resumed.agentSlug, purpose: resumed.purpose });
      res.json({ trigger: triggerSummary(resumed) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const t = deps.triggers();
    if (!t) return unavailable(res);
    const id = idOf(req, res);
    if (!id) return;
    try {
      const actor = auditActorFromRequest(req);
      const ended = await t.service.end(id, 'cancelled', { by: actor.email ?? actor.id ?? 'operator' });
      if (!ended) {
        res.status(404).json({ code: 'triggers.not_found', message: 'no such trigger' });
        return;
      }
      await audit(req, 'trigger.end', `trigger:${id}`, {});
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/recipient-profiles', async (req: Request, res: Response) => {
    const t = deps.triggers();
    if (!t) return unavailable(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = typeof body['recipient_key'] === 'string' ? body['recipient_key'].trim() : '';
    const tz = body['timezone'];
    const from = body['quiet_from'];
    const to = body['quiet_to'];
    const rate = body['max_per_hour'];
    const bad = (message: string): void => {
      res.status(400).json({ code: 'triggers.invalid_profile', message });
    };
    if (key === '' || key.length > 300) return bad('recipient_key is required');
    if (tz !== undefined && tz !== null) {
      try {
        if (typeof tz !== 'string') throw new Error('');
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
      } catch {
        return bad('timezone must be an IANA zone');
      }
    }
    const hasQuiet = from !== undefined && from !== null;
    if (hasQuiet !== (to !== undefined && to !== null)) return bad('quiet_from and quiet_to go together');
    if (hasQuiet && (typeof from !== 'string' || typeof to !== 'string' || !HHMM.test(from) || !HHMM.test(to) || from === to)) {
      return bad('quiet hours are HH:MM');
    }
    if (rate !== undefined && rate !== null && (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 0 || rate > 1000)) {
      return bad('max_per_hour is a whole number from 0 to 1000');
    }
    try {
      const actor = auditActorFromRequest(req);
      const profile = {
        ...(typeof tz === 'string' ? { timezone: tz } : {}),
        ...(hasQuiet ? { quiet: { from: from as string, to: to as string } } : {}),
        ...(typeof rate === 'number' ? { maxPerHour: rate } : {}),
      };
      await t.profiles.set(key, profile, actor.email ?? actor.id ?? 'operator');
      await audit(req, 'trigger.recipient_profile', `recipient:${key}`, profile);
      res.json({ recipient_key: key, ...profile });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
