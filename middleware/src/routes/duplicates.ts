import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type {
  AclMutationOptions,
  BulkMergeDetectService,
  GraphNode,
  KnowledgeGraph,
  MergeCandidateDetectorService,
  MergeCandidateNode,
  MergeCandidateResolution,
  MergeCandidateStatus,
} from '@omadia/plugin-api';

/**
 * Slice 10 — REST surface for near-duplicate MK workflow. Mounted at
 * `/api/v1/admin/duplicates`. Mirrors `inconsistencies.ts` (Slice 9):
 *
 *   GET    /                       list (filterable by status)
 *   GET    /:id                    detail (MergeCandidate + both MKs)
 *   POST   /:id/resolve            keep_a | keep_b | not_duplicate
 *   POST   /detect                 manual re-trigger for one MK
 *   GET    /bulk-detect/preview    operator preview (bucket counts)
 *   POST   /bulk-detect            operator-triggered bulk pass
 */

const ListQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const ResolveBodySchema = z.object({
  resolution: z.enum(['keep_a', 'keep_b', 'not_duplicate']),
  reason: z.string().min(1).max(1000).optional(),
});

const DetectBodySchema = z.object({
  mkId: z.string().min(1),
});

const BulkDetectBodySchema = z.object({
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
      case 'merge_candidate_not_found':
        return { status: 404, code: 'duplicates.not_found' };
      case 'already_resolved':
        return { status: 409, code: 'duplicates.already_resolved' };
      case 'not_an_owner':
        return { status: 403, code: 'duplicates.not_an_owner' };
    }
  }
  return { status: 500, code: 'duplicates.internal_error' };
}

interface MergeCandidateDetail extends MergeCandidateNode {
  mkA: GraphNode | null;
  mkB: GraphNode | null;
}

async function hydrateDetail(
  graph: KnowledgeGraph,
  mc: MergeCandidateNode,
  viewer: string,
): Promise<MergeCandidateDetail> {
  const [mkA, mkB] = await Promise.all([
    graph.getMemorableKnowledge(mc.duplicateOf[0], viewer),
    graph.getMemorableKnowledge(mc.duplicateOf[1], viewer),
  ]);
  return { ...mc, mkA, mkB };
}

export function createDuplicatesRouter(deps: {
  graph: KnowledgeGraph;
  detector?: MergeCandidateDetectorService;
  bulkDetect?: BulkMergeDetectService;
}): Router {
  const router = Router();

  // Bulk-Detect endpoints first so `/bulk-detect/preview` doesn't get
  // swallowed by `GET /:id`.
  router.get('/bulk-detect/preview', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    if (!deps.bulkDetect) {
      res.status(503).json({
        code: 'duplicates.bulk_unavailable',
        message: 'Bulk merge-detect service not wired.',
      });
      return;
    }
    try {
      const preview = await deps.bulkDetect.preview();
      res.json(preview);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'duplicates.bulk_preview_failed', message });
    }
  });

  router.post('/bulk-detect', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    if (!deps.bulkDetect) {
      res.status(503).json({
        code: 'duplicates.bulk_unavailable',
        message: 'Bulk merge-detect service not wired.',
      });
      return;
    }
    const parsed = BulkDetectBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        code: 'duplicates.invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      const result = await deps.bulkDetect.run(
        parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {},
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'duplicates.bulk_run_failed', message });
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        code: 'duplicates.invalid_query',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      const items = await deps.graph.listMergeCandidates({
        viewerOmadiaUserId: sessionUserId,
        ...(parsed.data.status
          ? { status: parsed.data.status as MergeCandidateStatus }
          : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      });
      const hydrated = await Promise.all(
        items.map((mc) => hydrateDetail(deps.graph, mc, sessionUserId)),
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
      const mc = await deps.graph.getMergeCandidate(id, sessionUserId);
      if (!mc) {
        res.status(404).json({ code: 'duplicates.not_found' });
        return;
      }
      const hydrated = await hydrateDetail(deps.graph, mc, sessionUserId);
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
      res.status(400).json({
        code: 'duplicates.invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      const actor: AclMutationOptions = {
        actorOmadiaUserId: sessionUserId,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      };
      const resolved = await deps.graph.resolveMergeCandidate(
        String(req.params['id'] ?? ''),
        parsed.data.resolution as MergeCandidateResolution,
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
        code: 'duplicates.detector_unavailable',
        message: 'MergeCandidate detector not wired — embedding client required.',
      });
      return;
    }
    const parsed = DetectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'duplicates.invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      const stats = await deps.detector.detectFor(parsed.data.mkId);
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'duplicates.detect_failed', message });
    }
  });

  return router;
}
