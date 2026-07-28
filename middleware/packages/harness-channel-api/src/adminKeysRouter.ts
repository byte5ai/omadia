/**
 * Issue #438 — POST/GET /api/public/v1/admin/keys, POST .../:id/revoke.
 *
 * Deliberately NOT exempted in `middleware/src/auth/publicPaths.ts` (only
 * `/api/public/v1/chat` is) — key lifecycle is an operator action, so it
 * stays behind the SAME session-cookie gate every other admin surface in
 * this app uses (see `src/routes/adminSettings.ts`). That is this router's
 * entire auth story: no bearer token of its own, no bootstrapping problem
 * ("how do you create the first key without a key already"), just the
 * operator's normal login.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { ApiKeyStore } from './apiKeyStore.js';

const CreateKeyRequestSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  rateLimitPerMinute: z.number().int().positive().max(6000).optional(),
});

export function createAdminKeysRouter(apiKeys: ApiKeyStore): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    res.json({ keys: await apiKeys.list() });
  });

  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateKeyRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const created = await apiKeys.create(parsed.data);
    // The plaintext token is returned exactly once, here. The operator must
    // copy it now — only its hash is ever stored.
    res.status(201).json({ key: created.record, token: created.token });
  });

  router.post('/:id/revoke', async (req: Request, res: Response) => {
    const rawId = req.params['id'];
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'missing key id' });
      return;
    }
    const revoked = await apiKeys.revoke(id);
    if (!revoked) {
      res.status(404).json({ error: 'not_found', id });
      return;
    }
    res.json({ key: revoked });
  });

  return router;
}
