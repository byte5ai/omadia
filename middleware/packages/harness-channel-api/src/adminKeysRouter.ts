/**
 * Issue #438 — POST/GET /api/public/v1/admin/keys, POST .../:id/revoke.
 *
 * Deliberately NOT exempted in `middleware/src/auth/publicPaths.ts` (only
 * `/api/public/v1/chat` is) — key lifecycle is an operator action, meant to
 * stay behind the same session an operator uses everywhere else. BUT not
 * being in `publicPaths.ts` is NOT what enforces that: `core.registerRouter`
 * (the kernel API this router is mounted through, in `plugin.ts`) applies
 * only an active/inactive gate, never authentication — see the
 * `RoutesAccessor` doc comment on `PluginContext` ("the kernel does not
 * inject middleware around the contributed router"). A previous revision of
 * this file claimed the publicPaths omission alone was the auth story; that
 * was false and left every route here completely unauthenticated.
 *
 * The REAL gate is the middleware below: it calls `ctx.operatorAuth`
 * (`@omadia/plugin-api`, kernel-published, wraps the exact same
 * verification logic `requireAuth` uses for `/api/v1/*`) on every request,
 * BEFORE any handler runs, and fails closed — refuses to serve at all
 * (`503`) — if the host never wired an `operatorAuth` accessor into this
 * plugin's context. Missing/invalid session → `401`, in the same
 * `{code, message}` shape `requireAuth` itself returns.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { OperatorAuthAccessor } from '@omadia/plugin-api';
import { z } from 'zod';

import type { ApiKeyStore } from './apiKeyStore.js';

const CreateKeyRequestSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  rateLimitPerMinute: z.number().int().positive().max(6000).optional(),
});

export function createAdminKeysRouter(
  apiKeys: ApiKeyStore,
  operatorAuth: OperatorAuthAccessor | undefined,
): Router {
  const router = Router();

  // Fail-closed operator-session gate, applied to every route below. This
  // is the ENTIRE auth story for this router — see the module doc comment
  // above for why relying on publicPaths.ts alone was wrong.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!operatorAuth) {
      // No kernel-published operatorAuth (e.g. an older host, or a narrow
      // test/migration context that never wired one) — refuse to serve
      // rather than silently mounting with no auth check at all.
      res.status(503).json({
        code: 'operator_auth.unavailable',
        message: 'operator auth unavailable',
      });
      return;
    }
    const cookieHeader = req.headers.cookie;
    void operatorAuth.hasValidSession(cookieHeader).then(
      (valid) => {
        if (valid) {
          next();
          return;
        }
        if (!cookieHeader) {
          res.status(401).json({ code: 'auth.missing', message: 'no session' });
          return;
        }
        res
          .status(401)
          .json({ code: 'auth.invalid', message: 'session invalid or expired' });
      },
      () => {
        // hasValidSession is documented to never throw, but a broken
        // implementation must not crash the request — treat it as invalid.
        res
          .status(401)
          .json({ code: 'auth.invalid', message: 'session invalid or expired' });
      },
    );
  });

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
