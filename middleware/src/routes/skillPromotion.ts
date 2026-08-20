import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  SkillLifecycleTransitionRejected,
  type PgSkillOwnershipLifecycleStore,
  type SkillOwnershipLifecycleRow,
} from '../services/skillLifecycleStore.js';
import { SkillAutomationWriteBlocked } from '../services/skillLifecycle.js';

/**
 * #778 W1 — REST surface for `PgSkillOwnershipLifecycleStore.promoteSkillOwnerScope`
 * (#577 P3), the only path a skill ever reaches `group`/`org` ownership.
 * Mounted under `/api/v1/admin/skills`.
 *
 * One endpoint:
 *   POST /:skillId/promote   → promote an already-published skill to a
 *                               team (group) or org home, re-signing its
 *                               manifest at the new owner scope.
 *
 * Auth follows the EXACT `routes/bulkPromotion.ts` precedent
 * (`req.session.omadia_user_id`, single-tenant byte5 — every authenticated
 * session is an operator). `promoteSkillOwnerScope` itself has no notion of
 * roles; this route's session check IS the "admin-gated" half #577 P3's PR
 * description explicitly left to the route layer. A subtly wrong auth check
 * here is a security regression — this is why the route was not rushed
 * alongside the service layer.
 */

const TargetScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group'), groupRef: z.string().min(1) }),
  z.object({ kind: z.literal('org'), orgId: z.string().min(1) }),
]);

const PromoteBodySchema = z.object({
  targetScope: TargetScopeSchema,
});

function requireSessionUserId(req: Request, res: Response): string | null {
  const id = req.session?.omadia_user_id;
  if (!id) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return id;
}

function toSkillBody(row: SkillOwnershipLifecycleRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    ownerScope: row.ownerScope,
    lifecycleStatus: row.lifecycleStatus,
    manifestSignedAt: row.manifestSignedAt ? row.manifestSignedAt.toISOString() : null,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SkillPromotionRouteDeps {
  /** Narrowed to the one method this route calls (`Pick`, not the concrete
   *  class) so a test double can stand in without a real `Pool`. */
  readonly store: Pick<PgSkillOwnershipLifecycleStore, 'promoteSkillOwnerScope'>;
  /** HMAC key `promoteSkillOwnerScope` re-signs the manifest with — see
   *  `services/skillManifestSigningKey.ts`. */
  readonly signingKey: string;
}

export function createSkillPromotionRouter(deps: SkillPromotionRouteDeps): Router {
  const router = Router();

  router.post('/:skillId/promote', async (req: Request, res: Response): Promise<void> => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;

    const skillId = req.params.skillId as string;
    const parsed = PromoteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ code: 'skill_promotion.invalid_request', issues: parsed.error.issues });
      return;
    }

    try {
      const updated = await deps.store.promoteSkillOwnerScope(skillId, parsed.data.targetScope, {
        actorScope: { kind: 'personal', userId: sessionUserId },
        signingKey: deps.signingKey,
      });
      res.json(toSkillBody(updated));
    } catch (err) {
      if (err instanceof SkillAutomationWriteBlocked) {
        // Unreachable today (actorScope is always 'personal' here, never
        // 'system') but handled explicitly rather than falling into the
        // generic 500 branch below — a machine actor being rejected is a
        // 403, not a server error.
        res.status(403).json({ code: 'skill_promotion.automation_blocked', message: err.message });
        return;
      }
      if (err instanceof SkillLifecycleTransitionRejected) {
        res.status(409).json({
          code: 'skill_promotion.transition_rejected',
          reason: err.reason,
          ...(err.missing ? { missing: err.missing } : {}),
          message: err.message,
        });
        return;
      }
      const message = errMsg(err);
      if (message.includes('not found')) {
        res.status(404).json({ code: 'skill_promotion.not_found', message });
        return;
      }
      if (message.includes('is not published') || message.includes('has no owner scope yet')) {
        res.status(409).json({ code: 'skill_promotion.not_eligible', message });
        return;
      }
      res.status(500).json({ code: 'skill_promotion.failed', message });
    }
  });

  return router;
}
