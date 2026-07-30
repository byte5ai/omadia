/**
 * Issue #438 — POST/GET /api/public/v1/admin/keys, POST .../:id/revoke.
 *
 * Deliberately NOT exempted in `middleware/src/auth/publicPaths.ts` (only
 * `/api/public/v1/chat` is) — key lifecycle is an operator action, meant to
 * stay behind the same session an operator uses everywhere else. `core.registerRouter`
 * (the kernel API this router is mounted through, in `plugin.ts`) applies
 * only an active/inactive gate, never authentication itself — see the
 * `RoutesAccessor` doc comment on `PluginContext` ("the kernel does not
 * inject middleware around the contributed router") — but that is not the
 * whole picture: `middleware/src/index.ts` mounts a broad `app.use('/api',
 * requireAuth, ...)` ahead of `pluginRouteRegistry.mountAll(app)` in boot
 * order, so every `/api/*` request, including this plugin's, already passes
 * through that session gate unless its path is listed in `publicPaths.ts`
 * (only `.../chat` is). A previous revision of this file's comment claimed
 * the publicPaths omission alone left these routes reachable by any
 * anonymous caller; a runtime reproduction mirroring the real mount order
 * disproved that — see `docs/security-architecture.md` § 9 for the full
 * account and why that coverage, while real, was an *implicit* invariant
 * worth replacing with an explicit one.
 *
 * The middleware below adds that explicit, non-implicit gate: it calls
 * `ctx.operatorAuth` (`@omadia/plugin-api`, kernel-published, wraps the
 * exact same verification logic `requireAuth` uses for `/api/v1/*`) on every
 * request, BEFORE any handler runs, and fails closed — refuses to serve at
 * all (`503`) — if the host never wired an `operatorAuth` accessor into this
 * plugin's context. Missing/invalid session → `401`, in the same
 * `{code, message}` shape `requireAuth` itself returns. That guarantee no
 * longer depends on mount order or on this path staying out of
 * `publicPaths.ts` — it travels with the router regardless.
 *
 * Issue #439 added `scopes` to creation and to the listing, on top of — never
 * instead of — that operator-session gate. Omitting `scopes` yields
 * `LEGACY_DEFAULT_SCOPES` (the exact capability set a key minted before scopes
 * existed had), so existing operator tooling that posts `{label}` keeps
 * producing working keys.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { OperatorAuthAccessor } from '@omadia/plugin-api';
import { z } from 'zod';
import type { ApiKeyStore } from '@omadia/api-key-auth';
import { isValidScope } from '@omadia/api-key-auth';

const CreateKeyRequestSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  rateLimitPerMinute: z.number().int().positive().max(6000).optional(),
  // Validated here (400 on a typo) rather than letting the store's
  // `assertValidScopes` throw into a 500 — operator input is user input.
  //
  // `.min(1)`: an explicitly-supplied empty array is rejected, never resolved
  // to a default. A zero-capability key is not a useful thing to mint, so `[]`
  // is far more likely an operator slip or a buggy client than a deliberate
  // request — and the alternatives are both worse. Granting the legacy default
  // would hand chat access to someone who asked for none, while minting a key
  // with no scopes would produce a credential that silently 403s forever,
  // because `normalizeScopes` in `@omadia/api-key-auth` reads a persisted `[]`
  // back as corruption and denies everything. Omit the field to accept the
  // default.
  scopes: z
    .array(z.string().refine(isValidScope, 'must be `<resource>:<action>` or `*`'))
    .min(1, 'scopes must not be empty; omit the field entirely to accept the default')
    .optional(),
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
