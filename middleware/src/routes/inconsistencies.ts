import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type {
  AclMutationOptions,
  BulkInconsistencyService,
  GraphNode,
  InconsistencyDetectorService,
  InconsistencyNode,
  InconsistencyResolution,
  InconsistencyStatus,
  KnowledgeGraph,
} from '@omadia/plugin-api';

/**
 * Slice 9 — REST surface for the contradiction-detection workflow.
 * Mounted under `/api/v1/admin/inconsistencies`.
 *
 * Endpoints:
 *   GET  /                  list (filterable by status)
 *   GET  /:id               detail (Inconsistency + both MKs hydrated)
 *   POST /:id/resolve       operator decision: a_wins|b_wins|both|dismiss
 *   POST /detect            manual re-trigger of detector for one MK
 *
 * All gated by `requireSessionUserId`. ACL handled inside the KG
 * (viewer must own at least one of the two conflicting MKs).
 */

const ListQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const ResolveBodySchema = z.object({
  resolution: z.enum(['a_wins', 'b_wins', 'both', 'dismiss']),
  reason: z.string().min(1).max(1000).optional(),
});

const DetectBodySchema = z.object({
  mkId: z.string().min(1),
});

// Slice 9.5 — bulk-detect run body. Limit default 25, hard-cap 200
// matches the service-side clamp. UI confirm-gate triggers at > 25.
const BulkDetectBodySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
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
      case 'inconsistency_not_found':
        return { status: 404, code: 'inconsistency.not_found' };
      case 'already_resolved':
        return { status: 409, code: 'inconsistency.already_resolved' };
      case 'not_an_owner':
        return { status: 403, code: 'inconsistency.not_an_owner' };
    }
  }
  return { status: 500, code: 'inconsistency.internal_error' };
}

interface InconsistencyDetail extends InconsistencyNode {
  /** Hydrated MK snapshot for both sides — saves the UI a roundtrip. */
  mkA: GraphNode | null;
  mkB: GraphNode | null;
}

async function hydrateDetail(
  graph: KnowledgeGraph,
  inc: InconsistencyNode,
  viewer: string,
): Promise<InconsistencyDetail> {
  const [mkA, mkB] = await Promise.all([
    graph.getMemorableKnowledge(inc.conflictsWith[0], viewer),
    graph.getMemorableKnowledge(inc.conflictsWith[1], viewer),
  ]);
  return { ...inc, mkA, mkB };
}

export function createInconsistenciesRouter(deps: {
  graph: KnowledgeGraph;
  detector?: InconsistencyDetectorService;
  /** Slice 9.5 — optional bulk-detect service. When absent, the
   *  `/bulk-detect` + `/bulk-detect/preview` endpoints 503 with the
   *  same shape the single-MK `/detect` endpoint uses. */
  bulkDetect?: BulkInconsistencyService;
}): Router {
  const router = Router();

  // ─── Slice 9.5 — bulk-detect endpoints (mounted before the
  //     dynamic `/:id` matchers so `bulk-detect/preview` doesn't get
  //     swallowed by `GET /:id`). ─────────────────────────────────────

  router.get('/bulk-detect/preview', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    if (!deps.bulkDetect) {
      res.status(503).json({
        code: 'inconsistency.bulk_unavailable',
        message: 'Bulk inconsistency-detect service not wired.',
      });
      return;
    }
    try {
      const preview = await deps.bulkDetect.preview();
      res.json(preview);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'inconsistency.bulk_preview_failed', message });
    }
  });

  router.post('/bulk-detect', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    if (!deps.bulkDetect) {
      res.status(503).json({
        code: 'inconsistency.bulk_unavailable',
        message: 'Bulk inconsistency-detect service not wired.',
      });
      return;
    }
    const parsed = BulkDetectBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'inconsistency.invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const result = await deps.bulkDetect.run(
        parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {},
      );
      res.json(result);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err &&
          (err as { code: string }).code === 'bulk.detector_unavailable') {
        res.status(503).json({
          code: 'bulk.detector_unavailable',
          message: 'Detector judgement-pass not wired — Anthropic key required.',
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'inconsistency.bulk_run_failed', message });
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'inconsistency.invalid_query', issues: parsed.error.issues });
      return;
    }
    try {
      const items = await deps.graph.listInconsistencies({
        viewerOmadiaUserId: sessionUserId,
        ...(parsed.data.status
          ? { status: parsed.data.status as InconsistencyStatus }
          : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      });
      const hydrated = await Promise.all(
        items.map((inc) => hydrateDetail(deps.graph, inc, sessionUserId)),
      );
      res.json({ items: hydrated });
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const id = String(req.params['id'] ?? '');
    try {
      const inc = await deps.graph.getInconsistency(id, sessionUserId);
      if (!inc) {
        res.status(404).json({ code: 'inconsistency.not_found' });
        return;
      }
      const hydrated = await hydrateDetail(deps.graph, inc, sessionUserId);
      res.json(hydrated);
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  router.post('/:id/resolve', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = ResolveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'inconsistency.invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const actor: AclMutationOptions = {
        actorOmadiaUserId: sessionUserId,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      };
      const resolved = await deps.graph.resolveInconsistency(
        String(req.params['id'] ?? ''),
        parsed.data.resolution as InconsistencyResolution,
        actor,
      );
      res.json(resolved);
    } catch (err) {
      const { status, code } = mapErrorToHttp(err);
      res.status(status).json({ code });
    }
  });

  router.post('/detect', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    if (!deps.detector) {
      res.status(503).json({
        code: 'inconsistency.detector_unavailable',
        message:
          'Detector not wired — embedding client + Anthropic key required.',
      });
      return;
    }
    const parsed = DetectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'inconsistency.invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const stats = await deps.detector.detectFor(parsed.data.mkId);
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'inconsistency.detect_failed', message });
    }
  });

  return router;
}
