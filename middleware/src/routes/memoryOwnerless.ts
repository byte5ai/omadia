import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { GraphNode, KnowledgeGraph } from '@omadia/plugin-api';

import { auditActorFromRequest, type AdminAuditLog } from '../auth/adminAuditLog.js';

/**
 * ADR-0185 (#1829, #1831) — the operator's view of memorable knowledge that
 * has no owner: entries the system created (scratch reaper, seeded rules,
 * rules planted before ADR-0033). `deleteMemory` requires the actor to be an
 * owner, so before this route only a full Danger-Zone purge or SQL could
 * remove one.
 *
 * Mounted at `/api/v1/admin/memory/ownerless` behind `requireAuth`, beside
 * the purge and promotion routers (cookie session, an attributable person).
 * Owned memory is never reachable here: the graph refuses an entry with an
 * owner (`409 has_owners`), so this is not a way around an owner's ACL.
 * The delete writes its `admin_audit` row first; a delete that cannot be
 * recorded does not run.
 */

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const DeleteBodySchema = z
  .object({ reason: z.string().min(1).max(1000).optional() })
  .partial();

export interface MemoryOwnerlessDeps {
  knowledgeGraph?: KnowledgeGraph;
  /** Absent on a database-less boot: the delete then runs unrecorded. */
  adminAudit?: AdminAuditLog;
}

/** What the page shows of an entry; no content beyond the summary. */
function toItem(node: GraphNode): Record<string, unknown> {
  const p = node.props;
  return {
    id: node.id,
    kind: p['kind'] ?? null,
    summary: p['summary'] ?? '',
    createdBy: p['created_by'] ?? null,
    originAgent: p['origin_agent'] ?? null,
    createdAt: p['created_at'] ?? null,
    isRule: typeof p['rationale'] === 'string' && p['rationale'].startsWith('source-memory-path: /memories/_rules/'),
  };
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function createMemoryOwnerlessRouter(deps: MemoryOwnerlessDeps): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const kg = deps.knowledgeGraph;
    if (!kg?.listOwnerlessMemorableKnowledge) {
      res.json({ supported: false, items: [] });
      return;
    }
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: 'memory.invalid_query', issues: parsed.error.issues });
      return;
    }
    try {
      const nodes = await kg.listOwnerlessMemorableKnowledge(
        parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {},
      );
      res.json({ supported: true, items: nodes.map(toItem) });
    } catch (err) {
      console.error('[memory-ownerless] list failed:', err instanceof Error ? err.message : err);
      res.status(500).json({ code: 'memory.internal_error' });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const kg = deps.knowledgeGraph;
    if (!kg?.deleteOwnerlessMemory) {
      res.status(501).json({ code: 'memory.ownerless_unsupported' });
      return;
    }
    // memory_acl_audit records the knowledge-graph user id of the actor.
    const omadiaUserId = req.session?.omadia_user_id;
    if (!omadiaUserId) {
      res.status(401).json({ code: 'auth.required', message: 'login required' });
      return;
    }
    const id = String(req.params['id'] ?? '');
    const body = DeleteBodySchema.safeParse(req.body ?? {});
    const reason = body.success ? body.data.reason : undefined;

    if (deps.adminAudit) {
      try {
        await deps.adminAudit.record({
          actor: auditActorFromRequest(req),
          action: 'memory.ownerless_delete',
          target: `memory:${id}`,
          ...(reason ? { before: { reason } } : {}),
        });
      } catch (err) {
        console.error('[memory-ownerless] audit write failed, delete refused:', err instanceof Error ? err.message : err);
        res.status(500).json({ code: 'audit_write_failed' });
        return;
      }
    }
    try {
      await kg.deleteOwnerlessMemory(id, {
        actorOmadiaUserId: omadiaUserId,
        ...(reason ? { reason } : {}),
      });
      res.status(204).end();
    } catch (err) {
      const code = errorCode(err);
      if (code === 'memory_not_found') {
        res.status(404).json({ code: 'memory.not_found' });
      } else if (code === 'has_owners') {
        res.status(409).json({ code: 'memory.has_owners' });
      } else {
        console.error('[memory-ownerless] delete failed:', err instanceof Error ? err.message : err);
        res.status(500).json({ code: 'memory.internal_error' });
      }
    }
  });

  return router;
}
