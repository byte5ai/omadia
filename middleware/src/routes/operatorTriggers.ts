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
//   GET    /recipient-grants      ?agent_id= — the explicit targets operators
//                                  allowed for agents' proactive messages
//   PUT    /recipient-grants      { agent_id, channel, conversation_id, delivery_ref?, label? }
//   DELETE /recipient-grants/:id  take a grant back: its triggers deliver nothing
//
// The kill switch that stops all triggers at once is the execution kill
// switch (/api/v1/operator/execution, level instance or agent).

import { Router, type Request, type Response } from 'express';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { RecipientProfileStore } from '../triggers/proactiveGate.js';
import { conversationIdOf, type RecipientGrant, type RecipientGrantStore } from '../triggers/recipientGrants.js';
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
    | {
        readonly service: TriggerService;
        readonly store: TriggerStore;
        readonly profiles: RecipientProfileStore;
        readonly grants: RecipientGrantStore;
      }
    | undefined;
  /**
   * The channel's conversation reference for a conversation the instance
   * already knows (a bot was added there or wrote there), for a grant that
   * names no `delivery_ref`. Undefined = not known.
   */
  readonly knownConversationRef?: (channel: string, conversationId: string) => Promise<unknown>;
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

  router.get('/recipient-grants', async (req: Request, res: Response) => {
    const t = deps.triggers();
    if (!t) return unavailable(res);
    const agentId = typeof req.query['agent_id'] === 'string' ? req.query['agent_id'] : undefined;
    if (agentId !== undefined && !UUID.test(agentId)) {
      res.status(400).json({ code: 'triggers.invalid_grant', message: 'agent_id must be an agent id' });
      return;
    }
    try {
      res.json({ grants: (await t.grants.list(agentId)).map(grantView) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/recipient-grants', async (req: Request, res: Response) => {
    const t = deps.triggers();
    if (!t) return unavailable(res);
    const parsed = parseGrantBody(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ code: 'triggers.invalid_grant', message: parsed });
      return;
    }
    try {
      const deliveryRef =
        parsed.deliveryRef ??
        (await deps.knownConversationRef?.(parsed.channel, parsed.conversationId)) ??
        (parsed.channel === 'teams' ? undefined : { conversationId: parsed.conversationId });
      if (deliveryRef === undefined) {
        res.status(422).json({
          code: 'triggers.conversation_unknown',
          message: 'no conversation reference is known for that conversation: add the bot there first, or pass delivery_ref',
        });
        return;
      }
      // The target is found again by the conversation its reference names.
      if (conversationIdOf(deliveryRef) !== parsed.conversationId) {
        res.status(400).json({ code: 'triggers.invalid_grant', message: 'delivery_ref names another conversation than conversation_id' });
        return;
      }
      const actor = auditActorFromRequest(req);
      const grant = await t.grants.grant({ ...parsed, deliveryRef, grantedBy: actor.email ?? actor.id ?? 'operator' });
      await audit(req, 'trigger.recipient_grant', `agent:${grant.agentId}`, grantView(grant));
      res.json({ grant: grantView(grant) });
    } catch (err) {
      // 23503: the agent does not exist.
      if ((err as { code?: string }).code === '23503') {
        res.status(404).json({ code: 'triggers.agent_not_found', message: 'no such agent' });
        return;
      }
      fail(res, err);
    }
  });

  router.delete('/recipient-grants/:id', async (req: Request, res: Response) => {
    const t = deps.triggers();
    if (!t) return unavailable(res);
    const id = String(req.params['id'] ?? '');
    if (!UUID.test(id)) {
      res.status(400).json({ code: 'triggers.invalid_grant', message: 'id must be a grant id' });
      return;
    }
    try {
      const revoked = await t.grants.revoke(id);
      if (!revoked) {
        res.status(404).json({ code: 'triggers.grant_not_found', message: 'no such recipient grant' });
        return;
      }
      await audit(req, 'trigger.recipient_grant_revoke', `agent:${revoked.agentId}`, grantView(revoked));
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

const CHANNEL = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_CONVERSATION_ID = 512;
const MAX_LABEL = 200;
const MAX_REF_BYTES = 8_192;

interface GrantBody {
  readonly agentId: string;
  readonly channel: string;
  readonly conversationId: string;
  readonly deliveryRef: Record<string, unknown> | undefined;
  readonly label: string | null;
}

/** A valid grant request, or why it is not one. */
function parseGrantBody(raw: unknown): GrantBody | string {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const agentId = body['agent_id'];
  const channel = body['channel'];
  const conversationId = typeof body['conversation_id'] === 'string' ? body['conversation_id'].trim() : '';
  const ref = body['delivery_ref'];
  const label = body['label'];
  if (typeof agentId !== 'string' || !UUID.test(agentId)) return 'agent_id must be an agent id';
  if (typeof channel !== 'string' || !CHANNEL.test(channel)) return 'channel must be a channel type like teams';
  if (conversationId === '' || conversationId.length > MAX_CONVERSATION_ID) return 'conversation_id is required';
  if (ref !== undefined && ref !== null) {
    if (typeof ref !== 'object' || Array.isArray(ref)) return 'delivery_ref must be an object';
    if (JSON.stringify(ref).length > MAX_REF_BYTES) return 'delivery_ref is too large';
  }
  if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > MAX_LABEL)) {
    return `label is text of at most ${String(MAX_LABEL)} characters`;
  }
  return {
    agentId,
    channel,
    conversationId,
    deliveryRef: ref && typeof ref === 'object' ? (ref as Record<string, unknown>) : undefined,
    label: typeof label === 'string' && label.trim() !== '' ? label.trim() : null,
  };
}

/** A grant as operators see it: without the opaque delivery reference. */
function grantView(g: RecipientGrant): Record<string, unknown> {
  return {
    id: g.id,
    agentId: g.agentId,
    channel: g.channel,
    conversationId: g.conversationId,
    label: g.label,
    grantedBy: g.grantedBy,
    grantedAt: g.grantedAt.toISOString(),
  };
}
