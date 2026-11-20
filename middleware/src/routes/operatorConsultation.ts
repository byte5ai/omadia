/**
 * Spec 2042 §5.4 / §5.11 (#2047, #2079) — operator API for consultation and
 * discretion. Mounted beside `/api/v1/operator/agents` (same auth gate):
 *
 *   GET  /api/v1/operator/agents/:slug/consultation            switches + grants (both directions)
 *   PUT  /api/v1/operator/agents/:slug/consultation            { consultable?, mayConsult? }
 *   PUT  /api/v1/operator/agents/:slug/consultation/grants/:to grant A(:slug) → B(:to)
 *   DELETE /api/v1/operator/agents/:slug/consultation/grants/:to revoke (effective on the next call)
 *   GET  /api/v1/operator/discretion/readerships               every declared integration
 *   PUT  /api/v1/operator/discretion/readerships/:integration  declare
 *   DELETE /api/v1/operator/discretion/readerships/:integration back to undeclared
 *
 * Every write lands in the admin audit (`agent.consultation_change` once per
 * agent of a grant, `discretion.readership_change`) and refreshes the
 * broker's offering snapshot. Facilitators can neither hold nor be the target
 * of a grant (spec §5.4); the archetype gate refuses that at save time.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  ArchetypeOmissionError,
  archetypeOmits,
  parseDisclosurePolicy,
  type ConfigStore,
} from '@omadia/orchestrator';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { ConsultationGrant, ConsultationStore } from '../consultation/consultationStore.js';
import type { DiscretionStore } from '../discretion/discretionStore.js';

export interface OperatorConsultationRouterOptions {
  readonly getConfigStore: () => Pick<ConfigStore, 'getAgentBySlug' | 'getAgentById'> | undefined;
  readonly consultationStore: Pick<
    ConsultationStore,
    'getSwitches' | 'setSwitches' | 'listGrantsOf' | 'upsertGrant' | 'deleteGrant'
  >;
  readonly discretionStore: Pick<DiscretionStore, 'listReaderships' | 'upsertReadership' | 'deleteReadership'>;
  /** Re-read the broker's offering snapshot after a change. */
  readonly refreshBroker: () => Promise<void>;
  readonly recordAudit?: (entry: AuditEntryInput) => Promise<void>;
}

const SYSTEM_ID = /^[A-Za-z0-9@._:/-]{1,200}$/;
const CHANNEL_TYPE = /^[a-z][a-z0-9_-]{0,63}$/;

const SwitchesSchema = z
  .object({ consultable: z.boolean().optional(), mayConsult: z.boolean().optional() })
  .strict();

const GrantSchema = z
  .object({
    channelScope: z.array(z.string().regex(CHANNEL_TYPE)).max(32).nullable().optional(),
    allowedCapabilities: z.array(z.string().regex(SYSTEM_ID)).max(64).optional(),
    memoryAccess: z.enum(['none', 'discreet']).optional(),
    disclosure: z.record(z.string(), z.unknown()).optional(),
    maxCallsPerTurn: z.number().int().min(1).max(10).optional(),
    maxCallsPerDay: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

const ReadershipSchema = z
  .object({
    sensitivity: z.enum(['internal', 'restricted']).default('internal'),
    readers: z.union([
      z.object({ kind: z.literal('everyone') }).strict(),
      z.object({ kind: z.literal('set'), ids: z.array(z.string().min(1).max(200)).max(1000) }).strict(),
    ]),
    acceptsSystems: z.array(z.string().regex(SYSTEM_ID)).max(64).default([]),
    acceptsClassifications: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(32).default([]),
  })
  .strict();

function grantView(grant: ConsultationGrant, slugs: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    from: slugs.get(grant.fromAgentId) ?? grant.fromAgentId,
    to: slugs.get(grant.toAgentId) ?? grant.toAgentId,
    channelScope: grant.channelScope,
    allowedCapabilities: grant.allowedCapabilities,
    memoryAccess: grant.memoryAccess,
    disclosure: grant.disclosure,
    maxCallsPerTurn: grant.maxCallsPerTurn,
    maxCallsPerDay: grant.maxCallsPerDay,
    createdBy: grant.createdBy,
    createdAt: grant.createdAt.toISOString(),
    updatedBy: grant.updatedBy,
    updatedAt: grant.updatedAt.toISOString(),
  };
}

export function createOperatorConsultationRouter(options: OperatorConsultationRouterOptions): Router {
  const router = Router();

  const recordAudit = async (entry: AuditEntryInput): Promise<void> => {
    try {
      if (options.recordAudit) await options.recordAudit(entry);
      else console.warn(`[security-audit] ${entry.action} ${entry.target}`);
    } catch (err) {
      console.error(
        `[security-audit] ${entry.action} ${entry.target} could not be recorded:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const refresh = async (): Promise<void> => {
    await options.refreshBroker().catch((err: unknown) => {
      console.warn(`[consultation] broker refresh after a change failed: ${String(err)}`);
    });
  };

  function fail(res: Response, err: unknown): void {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'invalid_body',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    if (err instanceof ArchetypeOmissionError) {
      res.status(409).json({ error: 'archetype_omits', message: err.message });
      return;
    }
    console.error('[consultation] operator route failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'internal_error' });
  }

  async function agentOr404(req: Request, res: Response, param = 'slug') {
    const store = options.getConfigStore();
    if (!store) {
      res.status(503).json({ error: 'multi_orchestrator_unavailable' });
      return undefined;
    }
    const slug = req.params[param];
    if (typeof slug !== 'string' || slug.length === 0) {
      res.status(400).json({ error: 'invalid_slug' });
      return undefined;
    }
    const agent = await store.getAgentBySlug(slug);
    if (!agent) {
      res.status(404).json({ error: 'not_found', slug });
      return undefined;
    }
    return agent;
  }

  router.get('/agents/:slug/consultation', async (req, res) => {
    try {
      const agent = await agentOr404(req, res);
      if (!agent) return;
      const [switches, grants] = await Promise.all([
        options.consultationStore.getSwitches(agent.id),
        options.consultationStore.listGrantsOf(agent.id),
      ]);
      const store = options.getConfigStore();
      const ids = new Set(grants.flatMap((g) => [g.fromAgentId, g.toAgentId]));
      const slugs = new Map<string, string>();
      for (const id of ids) {
        const other = await store?.getAgentById(id);
        if (other) slugs.set(id, other.slug);
      }
      res.json({
        slug: agent.slug,
        consultable: switches?.consultable ?? false,
        mayConsult: switches?.mayConsult ?? false,
        consults: grants.filter((g) => g.fromAgentId === agent.id).map((g) => grantView(g, slugs)),
        consultedBy: grants.filter((g) => g.toAgentId === agent.id).map((g) => grantView(g, slugs)),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/agents/:slug/consultation', async (req, res) => {
    try {
      const body = SwitchesSchema.parse(req.body);
      const agent = await agentOr404(req, res);
      if (!agent) return;
      if ((body.consultable || body.mayConsult) && archetypeOmits(agent, 'consultation')) {
        res.status(409).json({ error: 'archetype_omits', message: 'facilitators neither consult nor are consulted' });
        return;
      }
      const before = await options.consultationStore.getSwitches(agent.id);
      const after = await options.consultationStore.setSwitches(agent.id, body);
      await recordAudit({
        actor: auditActorFromRequest(req),
        action: 'agent.consultation_change',
        target: `agent:${agent.slug}`,
        before: before ?? null,
        after,
      });
      await refresh();
      res.json({ slug: agent.slug, ...after });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/agents/:slug/consultation/grants/:to', async (req, res) => {
    try {
      const body = GrantSchema.parse(req.body);
      const disclosure = body.disclosure === undefined ? undefined : parseDisclosurePolicy(body.disclosure);
      if (body.disclosure !== undefined && disclosure === undefined) {
        res.status(400).json({ error: 'invalid_disclosure', message: 'levels: full | redacted | aggregate | existence | none' });
        return;
      }
      const from = await agentOr404(req, res);
      if (!from) return;
      const to = await agentOr404(req, res, 'to');
      if (!to) return;
      if (from.id === to.id) {
        res.status(400).json({ error: 'self_grant', message: 'an agent cannot consult itself' });
        return;
      }
      if (archetypeOmits(from, 'consultation') || archetypeOmits(to, 'consultation')) {
        res.status(409).json({ error: 'archetype_omits', message: 'facilitators neither consult nor are consulted' });
        return;
      }
      const actor = auditActorFromRequest(req);
      const { before, after } = await options.consultationStore.upsertGrant(
        from.id,
        to.id,
        {
          ...(body.channelScope !== undefined ? { channelScope: body.channelScope } : {}),
          ...(body.allowedCapabilities !== undefined ? { allowedCapabilities: body.allowedCapabilities } : {}),
          ...(body.memoryAccess !== undefined ? { memoryAccess: body.memoryAccess } : {}),
          ...(disclosure !== undefined ? { disclosure } : {}),
          ...(body.maxCallsPerTurn !== undefined ? { maxCallsPerTurn: body.maxCallsPerTurn } : {}),
          ...(body.maxCallsPerDay !== undefined ? { maxCallsPerDay: body.maxCallsPerDay } : {}),
        },
        actor.email ?? actor.id ?? 'operator',
      );
      const slugs = new Map([
        [from.id, from.slug],
        [to.id, to.slug],
      ]);
      // Audited on both agents (spec §5.4).
      for (const slug of [from.slug, to.slug]) {
        await recordAudit({
          actor,
          action: 'agent.consultation_change',
          target: `agent:${slug}`,
          before: before ? grantView(before, slugs) : null,
          after: grantView(after, slugs),
        });
      }
      await refresh();
      res.json(grantView(after, slugs));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/agents/:slug/consultation/grants/:to', async (req, res) => {
    try {
      const from = await agentOr404(req, res);
      if (!from) return;
      const to = await agentOr404(req, res, 'to');
      if (!to) return;
      const removed = await options.consultationStore.deleteGrant(from.id, to.id);
      if (!removed) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const slugs = new Map([
        [from.id, from.slug],
        [to.id, to.slug],
      ]);
      const actor = auditActorFromRequest(req);
      for (const slug of [from.slug, to.slug]) {
        await recordAudit({
          actor,
          action: 'agent.consultation_change',
          target: `agent:${slug}`,
          before: grantView(removed, slugs),
          after: null,
        });
      }
      await refresh();
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/discretion/readerships', async (_req, res) => {
    try {
      const rows = await options.discretionStore.listReaderships();
      res.json({
        readerships: rows.map((r) => ({
          integration: r.integration,
          sensitivity: r.declaration.sensitivity,
          readers: r.declaration.readership.readers,
          acceptsSystems: r.declaration.readership.acceptsSystems,
          acceptsClassifications: r.declaration.readership.acceptsClassifications,
          updatedBy: r.updatedBy,
          updatedAt: r.updatedAt.toISOString(),
        })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/discretion/readerships/:integration', async (req, res) => {
    try {
      const integration = req.params['integration'];
      if (typeof integration !== 'string' || !SYSTEM_ID.test(integration)) {
        res.status(400).json({ error: 'invalid_integration' });
        return;
      }
      const body = ReadershipSchema.parse(req.body);
      const actor = auditActorFromRequest(req);
      const before = (await options.discretionStore.listReaderships()).find((r) => r.integration === integration);
      const row = await options.discretionStore.upsertReadership(
        integration,
        body.readers.kind === 'everyone'
          ? { ...body, readers: { kind: 'everyone' } }
          : { ...body, readers: { kind: 'set', ids: [...new Set(body.readers.ids)].sort() } },
        actor.email ?? actor.id ?? 'operator',
      );
      await recordAudit({
        actor,
        action: 'discretion.readership_change',
        target: `integration:${integration}`,
        before: before?.declaration ?? null,
        after: row.declaration,
      });
      res.json({ integration, ...row.declaration });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/discretion/readerships/:integration', async (req, res) => {
    try {
      const integration = req.params['integration'];
      if (typeof integration !== 'string' || !SYSTEM_ID.test(integration)) {
        res.status(400).json({ error: 'invalid_integration' });
        return;
      }
      const before = (await options.discretionStore.listReaderships()).find((r) => r.integration === integration);
      if (!before) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await options.discretionStore.deleteReadership(integration);
      await recordAudit({
        actor: auditActorFromRequest(req),
        action: 'discretion.readership_change',
        target: `integration:${integration}`,
        before: before.declaration,
        after: null,
      });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
