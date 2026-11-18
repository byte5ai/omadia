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
 *
 * Issues #1327–#1329 (cluster C08):
 *  - scopes must be KNOWN (`isKnownScope`, the catalog in
 *    `@omadia/api-key-auth`), not merely well-formed; `GET /scopes` serves the
 *    catalog to the admin UI;
 *  - `expiresAt` on create, `createdBy` from the operator session, and
 *    `DELETE /:id` for revoked or expired keys;
 *  - create, revoke and delete write `api_key.*` rows to the kernel's
 *    `admin_audit` via `operatorAuth.recordAdminAction` (actor resolved by the
 *    kernel from the cookie, never the token or its hash);
 *  - the per-key usage log is readable (`GET /:id/usage`) and the list carries
 *    `lastUsedAt`.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { OperatorAdminAuditEntry, OperatorAuthAccessor } from '@omadia/plugin-api';
import { z } from 'zod';
import type { ApiKeyPublicView, ApiKeyStore, AuditLog } from '@omadia/api-key-auth';
import { isKnownScope, listApiKeyScopes } from '@omadia/api-key-auth';

/** #1328 — the furthest an expiry may lie in the future (~5 years). Guards
 *  against a unit slip (seconds vs ms) minting a "temporary" key that lives
 *  for centuries. */
const MAX_EXPIRY_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;

const CreateKeyRequestSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  rateLimitPerMinute: z.number().int().positive().max(6000).optional(),
  // Validated here (400 on a typo) rather than letting the store's
  // `assertValidScopes` throw into a 500 — operator input is user input.
  //
  // #1327: KNOWN, not just well-formed. `isKnownScope` admits the built-ins,
  // plugin-registered scopes and `mcp:write:<tool>`; `foo:bar` or `chat:wirte`
  // would mint a key no route accepts.
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
    .array(z.string().max(128))
    .max(64)
    .min(1, 'scopes must not be empty; omit the field entirely to accept the default')
    .optional(),
  /** #1328 — epoch ms, strictly in the future, at most ~5 years out. */
  expiresAt: z.number().int().positive().optional(),
});

/** #1327 — the scopes in a request that no route checks. */
function unknownScopes(scopes: readonly string[] | undefined): string[] {
  return (scopes ?? []).filter((scope) => !isKnownScope(scope));
}

function idParam(req: Request): string | undefined {
  const rawId = req.params['id'];
  return Array.isArray(rawId) ? rawId[0] : rawId;
}

/** The audit payload for a key — never the token, never the hash
 *  (`ApiKeyPublicView` carries neither). */
function auditView(key: ApiKeyPublicView): Record<string, unknown> {
  return {
    id: key.id,
    ...(key.label ? { label: key.label } : {}),
    scopes: [...key.scopes],
    rateLimitPerMinute: key.rateLimitPerMinute,
    // Epoch ms, as stored: formatting a corrupt value could throw after the
    // action already happened.
    ...(key.expiresAt !== undefined ? { expiresAt: key.expiresAt } : {}),
  };
}

export interface AdminKeysRouterOptions {
  /** #1329 — the per-key usage log. Absent → `/usage` answers 404 and the
   *  list carries no `lastUsedAt`. */
  readonly usageLog?: AuditLog;
  readonly log?: (...args: unknown[]) => void;
}

export function createAdminKeysRouter(
  apiKeys: ApiKeyStore,
  operatorAuth: OperatorAuthAccessor | undefined,
  opts: AdminKeysRouterOptions = {},
): Router {
  const router = Router();
  const log = opts.log ?? ((...args: unknown[]) => console.warn(...args));
  // Revokes of one key run one at a time, so of two concurrent revokes only
  // the first sees an active key and writes the audit row.
  const revokeChains = new Map<string, Promise<unknown>>();
  function serializedPerKey<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (revokeChains.get(id) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    revokeChains.set(id, tail);
    void tail.then(() => {
      if (revokeChains.get(id) === tail) revokeChains.delete(id);
    });
    return run;
  }

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

  /** #1329 — one `admin_audit` row. The action already happened, so a failed
   *  write is logged loudly rather than turned into an error response that
   *  would invite the operator to repeat it. */
  async function audit(req: Request, entry: OperatorAdminAuditEntry): Promise<void> {
    const written = operatorAuth?.recordAdminAction
      ? await operatorAuth.recordAdminAction(req.headers.cookie, entry)
      : false;
    if (!written) {
      log(`[channel-api] admin_audit row for ${entry.action} ${entry.target} NOT written`);
    }
  }

  router.get('/', async (_req: Request, res: Response) => {
    const [keys, lastUsed] = await Promise.all([
      apiKeys.list(),
      opts.usageLog ? opts.usageLog.lastUsed() : Promise.resolve(undefined),
    ]);
    res.json({
      keys: keys.map((key) => {
        const lastUsedAt = lastUsed?.[key.id];
        return lastUsedAt !== undefined ? { ...key, lastUsedAt } : key;
      }),
    });
  });

  // #1327 — registered BEFORE `/:id/...` so `scopes` is never read as an id.
  router.get('/scopes', (_req: Request, res: Response) => {
    res.json(listApiKeyScopes());
  });

  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateKeyRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const unknown = unknownScopes(parsed.data.scopes);
    if (unknown.length > 0) {
      res.status(400).json({
        error: 'invalid_scope',
        message: `unknown scope(s): ${unknown.join(', ')}`,
        scopes: unknown,
      });
      return;
    }
    const { expiresAt } = parsed.data;
    const now = Date.now();
    if (expiresAt !== undefined && (expiresAt <= now || expiresAt > now + MAX_EXPIRY_HORIZON_MS)) {
      res.status(400).json({
        error: 'invalid_expiry',
        message: 'expiresAt must lie in the future and at most 5 years ahead',
      });
      return;
    }
    const principal = await operatorAuth?.sessionPrincipal?.(req.headers.cookie);
    const created = await apiKeys.create({
      ...parsed.data,
      ...(principal ? { createdBy: principal } : {}),
    });
    await audit(req, {
      action: 'api_key.create',
      target: `api-key:${created.record.id}`,
      after: auditView(created.record),
    });
    // The plaintext token is returned exactly once, here. The operator must
    // copy it now — only its hash is ever stored.
    res.status(201).json({ key: created.record, token: created.token });
  });

  router.post('/:id/revoke', async (req: Request, res: Response) => {
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'missing key id' });
      return;
    }
    const { before, revoked } = await serializedPerKey(id, async () => ({
      before: (await apiKeys.list()).find((k) => k.id === id),
      revoked: await apiKeys.revoke(id),
    }));
    if (!revoked) {
      res.status(404).json({ error: 'not_found', id });
      return;
    }
    // Revoke is idempotent; only the call that actually revoked is audited.
    if (before && before.revokedAt === undefined) {
      await audit(req, {
        action: 'api_key.revoke',
        target: `api-key:${id}`,
        after: auditView(revoked),
      });
    }
    res.json({ key: revoked });
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const id = idParam(req);
    if (!id) {
      res.status(400).json({ error: 'invalid_request', message: 'missing key id' });
      return;
    }
    const result = await apiKeys.delete(id);
    if (result.status === 'not_found') {
      res.status(404).json({ error: 'not_found', id });
      return;
    }
    if (result.status === 'active') {
      res.status(409).json({
        error: 'key_active',
        message: 'revoke the key (or let it expire) before deleting it',
      });
      return;
    }
    await opts.usageLog?.forget(id);
    await audit(req, {
      action: 'api_key.delete',
      target: `api-key:${id}`,
      before: auditView(result.key),
    });
    res.status(204).end();
  });

  router.get('/:id/usage', async (req: Request, res: Response) => {
    const id = idParam(req);
    if (!id || !opts.usageLog) {
      res.status(404).json({ error: 'not_found', id });
      return;
    }
    const known = (await apiKeys.list()).some((k) => k.id === id);
    if (!known) {
      res.status(404).json({ error: 'not_found', id });
      return;
    }
    res.json({ entries: await opts.usageLog.forKey(id) });
  });

  return router;
}
