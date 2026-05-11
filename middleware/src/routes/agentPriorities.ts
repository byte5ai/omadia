import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { AgentPrioritiesStore } from '@omadia/plugin-api';

interface AgentPrioritiesDeps {
  store: AgentPrioritiesStore;
}

const ENTRY_EXTERNAL_ID_RE = /^(turn:|Session::)/;

const UpsertBodySchema = z.object({
  action: z.enum(['block', 'boost']),
  weight: z.number().finite().min(0).optional(),
  reason: z.string().max(500).nullable().optional(),
});

/**
 * Operator-facing per-Agent priorities admin endpoints (palaia Phase 5 /
 * OB-74 Slice 5). Mounted under `/api/dev/graph/priorities` only when
 * `DEV_ENDPOINTS_ENABLED` is set, mirroring the kg-lifecycle pattern. The
 * web-dev page at `/admin/kg-priorities` is the consumer.
 *
 *   GET    /:agentId                 — list (block | boost) entries
 *   POST   /:agentId/:entryId        — upsert (action, weight, reason)
 *   DELETE /:agentId/:entryId        — remove
 *
 * `entryId` is URL-encoded by the caller (entry external IDs contain
 * colons). Server validates the format matches `turn:*` or `Session::*`
 * to defend against accidental writes from malformed admin payloads.
 */
export function createAgentPrioritiesRouter(
  deps: AgentPrioritiesDeps,
): Router {
  const router = Router();

  router.get('/:agentId', async (req: Request, res: Response) => {
    const agentId = String(req.params['agentId'] ?? '').trim();
    if (agentId.length === 0) {
      res.status(400).json({ error: 'agentId required' });
      return;
    }
    try {
      const records = await deps.store.listForAgent(agentId);
      res.json({ records });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post('/:agentId/:entryId', async (req: Request, res: Response) => {
    const agentId = String(req.params['agentId'] ?? '').trim();
    const entryExternalId = decodeURIComponent(
      String(req.params['entryId'] ?? ''),
    ).trim();
    if (agentId.length === 0) {
      res.status(400).json({ error: 'agentId required' });
      return;
    }
    if (!ENTRY_EXTERNAL_ID_RE.test(entryExternalId)) {
      res.status(400).json({
        error:
          'invalid entry_external_id — expected `turn:<scope>:<time>` or `Session::<scope>`',
      });
      return;
    }
    const parsed = UpsertBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    const body = parsed.data;
    const weight = body.weight ?? 1.3;
    const reason = body.reason ?? null;
    try {
      await deps.store.upsert({
        agentId,
        entryExternalId,
        action: body.action,
        weight,
        reason,
      });
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.delete('/:agentId/:entryId', async (req: Request, res: Response) => {
    const agentId = String(req.params['agentId'] ?? '').trim();
    const entryExternalId = decodeURIComponent(
      String(req.params['entryId'] ?? ''),
    ).trim();
    if (agentId.length === 0 || entryExternalId.length === 0) {
      res.status(400).json({ error: 'agentId and entryId required' });
      return;
    }
    try {
      await deps.store.remove(agentId, entryExternalId);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  return router;
}
