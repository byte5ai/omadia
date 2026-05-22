import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type {
  AclMutationOptions,
  BulkExcerptMergeDetectService,
  BulkMergeDetectService,
  ExcerptMergeCandidateNode,
  ExcerptMergeResolution,
  ExcerptMergeStatus,
  GraphNode,
  KnowledgeGraph,
  MergeCandidateDetectorService,
  MergeCandidateNode,
  MergeCandidateResolution,
  MergeCandidateStatus,
  PalaiaExcerptNode,
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

interface ExcerptMergeDetail extends ExcerptMergeCandidateNode {
  excerptA: PalaiaExcerptNode | null;
  excerptB: PalaiaExcerptNode | null;
  mkA: GraphNode | null;
  mkB: GraphNode | null;
}

const ExcerptResolveBodySchema = z.object({
  resolution: z.enum(['keep_a', 'keep_b', 'not_duplicate']),
  reason: z.string().min(1).max(1000).optional(),
});

const ExcerptDetectBodySchema = z.object({
  excerptId: z.string().min(1),
});

async function hydrateExcerptDetail(
  graph: KnowledgeGraph,
  mc: ExcerptMergeCandidateNode,
  viewer: string,
): Promise<ExcerptMergeDetail> {
  // For each excerpt: find its parent MK via neighbours, then ACL-gate
  // the MK so we know if the viewer can see the content. listExcerptsForMemory
  // returns full PalaiaExcerptNode for the matching position.
  const out: ExcerptMergeDetail = {
    ...mc,
    excerptA: null,
    excerptB: null,
    mkA: null,
    mkB: null,
  };
  for (const [i, excerptExternalId] of mc.duplicateExcerptOf.entries()) {
    const neighbours = await graph.getNeighbors(excerptExternalId);
    const parentMk = neighbours.find((n) => n.type === 'MemorableKnowledge');
    if (!parentMk) continue;
    const aclGatedMk = await graph.getMemorableKnowledge(parentMk.id, viewer);
    if (!aclGatedMk) continue;
    const excerpts = await graph.listExcerptsForMemory(parentMk.id);
    const ex = excerpts.find((e) => e.id === excerptExternalId) ?? null;
    if (i === 0) {
      out.mkA = aclGatedMk;
      out.excerptA = ex;
    } else {
      out.mkB = aclGatedMk;
      out.excerptB = ex;
    }
  }
  return out;
}

export function createDuplicatesRouter(deps: {
  graph: KnowledgeGraph;
  detector?: MergeCandidateDetectorService;
  bulkDetect?: BulkMergeDetectService;
  /** Slice 12 — Excerpt-level bulk service. Optional; when absent the
   *  `/excerpts/bulk-detect*` endpoints 503 like the MK pendants. */
  bulkExcerptDetect?: BulkExcerptMergeDetectService;
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

  // ═══ Slice 12 — Excerpt-Merge endpoints (mirror of MK-pendants) ═══
  // Mounted under `/excerpts/*`. Order matters: the static
  // `/bulk-detect/*` sub-paths must register before `/:id` matchers.

  router.get('/excerpts/bulk-detect/preview', async (req, res) => {
    if (!requireSessionUserId(req, res)) return;
    if (!deps.bulkExcerptDetect) {
      res.status(503).json({
        code: 'duplicates.excerpt_bulk_unavailable',
        message: 'Bulk excerpt-merge service not wired.',
      });
      return;
    }
    try {
      res.json(await deps.bulkExcerptDetect.preview());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .json({ code: 'duplicates.excerpt_bulk_preview_failed', message });
    }
  });

  router.post('/excerpts/bulk-detect', async (req, res) => {
    if (!requireSessionUserId(req, res)) return;
    if (!deps.bulkExcerptDetect) {
      res.status(503).json({
        code: 'duplicates.excerpt_bulk_unavailable',
        message: 'Bulk excerpt-merge service not wired.',
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
      const result = await deps.bulkExcerptDetect.run(
        parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {},
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'duplicates.excerpt_bulk_run_failed', message });
    }
  });

  router.post('/excerpts/detect', async (req, res) => {
    if (!requireSessionUserId(req, res)) return;
    if (!deps.detector) {
      res.status(503).json({
        code: 'duplicates.detector_unavailable',
        message: 'Detector not wired — embedding client required.',
      });
      return;
    }
    const parsed = ExcerptDetectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'duplicates.invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      const stats = await deps.detector.detectForExcerpt(parsed.data.excerptId);
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'duplicates.excerpt_detect_failed', message });
    }
  });

  router.get('/excerpts', async (req, res) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'duplicates.invalid_query', issues: parsed.error.issues });
      return;
    }
    try {
      const items = await deps.graph.listExcerptMergeCandidates({
        viewerOmadiaUserId: sessionUserId,
        ...(parsed.data.status
          ? { status: parsed.data.status as ExcerptMergeStatus }
          : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      });
      const hydrated = await Promise.all(
        items.map((mc) => hydrateExcerptDetail(deps.graph, mc, sessionUserId)),
      );
      res.json({ items: hydrated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'duplicates.excerpt_list_failed', message });
    }
  });

  router.get('/excerpts/:id', async (req, res) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const id = String(req.params['id'] ?? '');
    try {
      const mc = await deps.graph.getExcerptMergeCandidate(id, sessionUserId);
      if (!mc) {
        res.status(404).json({ code: 'duplicates.excerpt_not_found' });
        return;
      }
      const hydrated = await hydrateExcerptDetail(deps.graph, mc, sessionUserId);
      res.json(hydrated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'duplicates.excerpt_get_failed', message });
    }
  });

  router.post('/excerpts/:id/resolve', async (req, res) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const parsed = ExcerptResolveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'duplicates.invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const actor: AclMutationOptions = {
        actorOmadiaUserId: sessionUserId,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      };
      const resolved = await deps.graph.resolveExcerptMergeCandidate(
        String(req.params['id'] ?? ''),
        parsed.data.resolution as ExcerptMergeResolution,
        actor,
      );
      res.json(resolved);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err) {
        const code = (err as { code: string }).code;
        if (code === 'excerpt_merge_candidate_not_found') {
          res.status(404).json({ code: 'duplicates.excerpt_not_found' });
          return;
        }
        if (code === 'already_resolved') {
          res.status(409).json({ code: 'duplicates.already_resolved' });
          return;
        }
        if (code === 'not_an_owner') {
          res.status(403).json({ code: 'duplicates.not_an_owner' });
          return;
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'duplicates.excerpt_resolve_failed', message });
    }
  });

  return router;
}
