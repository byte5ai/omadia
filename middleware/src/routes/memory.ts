import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type {
  AclMutationOptions,
  KnowledgeGraph,
  MemorableKind,
} from '@omadia/plugin-api';

/**
 * Slice 3b — REST surface for MemorableKnowledge + ACL operations.
 *
 * Mounted under `/api/v1/memory` with `optionalAuth` (mirrors the
 * `/api/chat` pattern): authenticated callers get
 * `req.session.omadia_user_id` populated so the router can auto-derive
 * `aclOwners = [session]` on create and authorise mutations against
 * the same identity. Anonymous calls are NOT 401-blocked — they can
 * still hit the read paths but get the strict ACL filter (which means
 * `null`/empty unless the caller passes a viewer hint).
 */

const MEMORABLE_KINDS = [
  'decision',
  'insight',
  'preference',
  'reference',
] as const satisfies readonly MemorableKind[];

const CreateMemorySchema = z.object({
  kind: z.enum(MEMORABLE_KINDS),
  summary: z.string().min(1).max(2000),
  rationale: z.string().min(1).max(10000).optional(),
  significance: z.number().min(0).max(1).optional(),
  involvedOmadiaUserIds: z.array(z.string().uuid()).optional(),
  requiredEntityIds: z.array(z.string().min(1)).optional(),
  derivedFromTurnIds: z.array(z.string().min(1)).optional(),
  /** Optional explicit owners. When the request is authenticated, the
   *  session user is appended automatically (so a Web-UI save always
   *  ends up with at least the saver as owner). */
  aclOwners: z.array(z.string().uuid()).optional(),
});

const OwnerMutationBodySchema = z.object({
  omadiaUserId: z.string().uuid(),
  reason: z.string().min(1).max(1000).optional(),
});

const DeleteBodySchema = z
  .object({ reason: z.string().min(1).max(1000).optional() })
  .partial();

const ListQuerySchema = z.object({
  kind: z.enum(MEMORABLE_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function requireSessionUserId(req: Request, res: Response): string | null {
  const id = req.session?.omadia_user_id;
  if (!id) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return id;
}

function mapErrorToHttp(err: unknown): { status: number; code: string } {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    switch (code) {
      case 'memory_not_found':
        return { status: 404, code: 'memory.not_found' };
      case 'not_an_owner':
        return { status: 403, code: 'memory.not_an_owner' };
      case 'cannot_remove_last_owner':
        return { status: 409, code: 'memory.cannot_remove_last_owner' };
    }
  }
  return { status: 500, code: 'memory.internal_error' };
}

export function createMemoryRouter(deps: {
  graph: KnowledgeGraph;
}): Router {
  const router = Router();

  // ── POST /memory — create + auto-own ────────────────────────────────────
  router.post('/', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = CreateMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'memory.invalid_request', issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    const owners = Array.from(
      new Set([sessionUserId, ...(body.aclOwners ?? [])]),
    );
    // Slice-3b polish: mirror the owners-auto-include for involvement.
    // Strict-ACL gating (`listMemorableKnowledgeFor`) requires both an
    // INVOLVED edge AND `acl_owners @> [user]`; without auto-including
    // the saver, a Web-UI save produced an MK the saver could never
    // see in /memories.
    const involved = Array.from(
      new Set([sessionUserId, ...(body.involvedOmadiaUserIds ?? [])]),
    );
    const createdBy =
      req.session?.provider && req.session.sub
        ? `${req.session.provider === 'entra' ? 'web' : 'web'}:${sessionUserId}`
        : `web:${sessionUserId}`;
    try {
      const result = await deps.graph.createMemorableKnowledge({
        kind: body.kind,
        summary: body.summary,
        ...(body.rationale ? { rationale: body.rationale } : {}),
        ...(body.significance !== undefined
          ? { significance: body.significance }
          : {}),
        createdBy,
        actorOmadiaUserId: sessionUserId,
        aclOwners: owners,
        involvedOmadiaUserIds: involved,
        ...(body.requiredEntityIds
          ? { requiredEntityIds: body.requiredEntityIds }
          : {}),
        ...(body.derivedFromTurnIds
          ? { derivedFromTurnIds: body.derivedFromTurnIds }
          : {}),
      });
      res.status(201).json(result);
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  // ── GET /memory — list for current session user ─────────────────────────
  router.get('/', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'memory.invalid_query', issues: parsed.error.issues });
      return;
    }
    try {
      const opts: { kind?: MemorableKind; limit?: number } = {};
      if (parsed.data.kind) opts.kind = parsed.data.kind;
      if (parsed.data.limit !== undefined) opts.limit = parsed.data.limit;
      const nodes = await deps.graph.listMemorableKnowledgeFor(
        sessionUserId,
        opts,
      );
      res.json({ items: nodes });
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  // ── GET /memory/:id — ACL-filtered read ─────────────────────────────────
  router.get('/:id', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const id = String(req.params['id'] ?? '');
    try {
      const node = await deps.graph.getMemorableKnowledge(id, sessionUserId);
      if (!node) {
        res.status(404).json({ code: 'memory.not_found' });
        return;
      }
      res.json(node);
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  // ── POST /memory/:id/owners — add owner ─────────────────────────────────
  router.post('/:id/owners', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = OwnerMutationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'memory.invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const actor: AclMutationOptions = {
        actorOmadiaUserId: sessionUserId,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      };
      const owners = await deps.graph.addOwner(
        String(req.params['id'] ?? ''),
        parsed.data.omadiaUserId,
        actor,
      );
      res.json({ owners });
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  // ── DELETE /memory/:id/owners/:userId — remove owner ────────────────────
  router.delete('/:id/owners/:userId', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const reasonParsed = DeleteBodySchema.safeParse(req.body ?? {});
    const reason = reasonParsed.success
      ? reasonParsed.data.reason
      : undefined;
    try {
      const actor: AclMutationOptions = {
        actorOmadiaUserId: sessionUserId,
        ...(reason ? { reason } : {}),
      };
      const owners = await deps.graph.removeOwner(
        String(req.params['id'] ?? ''),
        String(req.params['userId'] ?? ''),
        actor,
      );
      res.json({ owners });
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  // ── DELETE /memory/:id — hard delete ────────────────────────────────────
  router.delete('/:id', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const reasonParsed = DeleteBodySchema.safeParse(req.body ?? {});
    const reason = reasonParsed.success
      ? reasonParsed.data.reason
      : undefined;
    try {
      const actor: AclMutationOptions = {
        actorOmadiaUserId: sessionUserId,
        ...(reason ? { reason } : {}),
      };
      await deps.graph.deleteMemory(String(req.params['id'] ?? ''), actor);
      res.status(204).end();
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  // ── GET /memory/:id/audit — list ACL audit-trail ────────────────────────
  router.get('/:id/audit', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'memory.invalid_query', issues: parsed.error.issues });
      return;
    }
    // Authorise: only owners of the (possibly-deleted) memory or admins
    // could read the trail. Since we don't have an admin-role concept
    // yet, we check the latest non-delete audit row's owners.
    try {
      const opts: { limit?: number } = {};
      if (parsed.data.limit !== undefined) opts.limit = parsed.data.limit;
      const entries = await deps.graph.listMemoryAclAudit(
        String(req.params['id'] ?? ''),
        opts,
      );
      // Determine the last-known owner set: latest entry's afterOwners
      // if non-null, otherwise the latest beforeOwners (covers the
      // "after delete" case so trails stay visible for the user who
      // owned the MK at delete-time).
      const latest = entries[0];
      const lastKnownOwners =
        latest === undefined
          ? []
          : latest.afterOwners ?? latest.beforeOwners;
      if (!lastKnownOwners.includes(sessionUserId)) {
        res.status(403).json({ code: 'memory.not_an_owner' });
        return;
      }
      res.json({ items: entries });
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  return router;
}
