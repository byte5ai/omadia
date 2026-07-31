/**
 * W5-1 — the operator surface for `public_mcp_key_bindings`.
 *
 * Mounted by `agentBuilder.ts` under the existing `/api/v1/operator` parent, so
 * it reuses the web-ui's `callJson` base and needs no new mount point.
 *
 * WHY A SEPARATE FILE RATHER THAN THREE MORE HANDLERS IN `agentBuilder.ts`.
 * Every other route on that router is gated only by the `app.use('/api',
 * requireAuth, …)` that sits in front of the mount — mount order is the whole
 * auth story. That is fine for canvas CRUD and NOT fine here: these three routes
 * decide what a third-party API key may do against an internet-facing endpoint,
 * and their gate must travel WITH them rather than depend on where they happen
 * to be mounted. Isolating them in their own router lets the gate be attached to
 * the router itself and, just as importantly, lets it be TESTED that way —
 * mounted bare on an express app with no `requireAuth` anywhere, which is the
 * only arrangement in which a missing gate is actually observable.
 *
 * The gate below is copied from `harness-channel-api/src/adminKeysRouter.ts`
 * (issue #438), not reinvented: same `operatorAuth.hasValidSession` call, same
 * 503-when-unwired / 401-on-missing / 401-on-invalid triple, same `{code,
 * message}` body shape `requireAuth` returns. Two admin surfaces that answer
 * "who are you" differently is how one of them ends up subtly weaker.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';

import type {
  PublicMcpKeyBindingAdminStore,
  PublicMcpKeyBindingInput,
} from '../mcp/publicMcpKeyBindingsAdmin.js';
import { validateBindingInput } from '../mcp/publicMcpKeyBindingsAdmin.js';

/** The subset of `OperatorAuthAccessor` this router needs. Structural rather
 *  than an import of the plugin-api type so the middleware's own routes do not
 *  take a dependency on the plugin surface just to type one method. */
export interface OperatorSessionCheck {
  hasValidSession(cookieHeader: string | undefined): Promise<boolean>;
}

export interface PublicMcpBindingsRouterOptions {
  /** Absent ⇒ every route 503s. The store needs the graph pool; without it
   *  there is nothing to read or write. */
  readonly getStore: () => PublicMcpKeyBindingAdminStore | undefined;
  /** Absent ⇒ every route 503s, BEFORE any handler runs. Never a fallback to
   *  "unauthenticated but mounted". */
  readonly operatorAuth?: OperatorSessionCheck;
}

export function createPublicMcpBindingsRouter(
  options: PublicMcpBindingsRouterOptions,
): Router {
  const router = Router();

  // Fail-closed operator-session gate, applied to every route below. Copied
  // verbatim in behaviour from `adminKeysRouter.ts:76-110`.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const { operatorAuth } = options;
    if (!operatorAuth) {
      // No operatorAuth wired (an older host, or a narrow test/migration
      // context) — refuse to serve rather than silently mounting a write path
      // to an authorization table with no auth check at all.
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
        res.status(401).json({ code: 'auth.invalid', message: 'session invalid or expired' });
      },
      () => {
        // `hasValidSession` is documented never to throw, but a broken
        // implementation must not crash the request — treat it as invalid.
        res.status(401).json({ code: 'auth.invalid', message: 'session invalid or expired' });
      },
    );
  });

  function storeOr503(res: Response): PublicMcpKeyBindingAdminStore | undefined {
    const store = options.getStore();
    if (!store) {
      res.status(503).json({
        code: 'public_mcp_bindings.unavailable',
        message: 'public MCP key bindings require a graph database',
      });
      return undefined;
    }
    return store;
  }

  // ── List ────────────────────────────────────────────────────────────────
  router.get('/', async (_req: Request, res: Response) => {
    const store = storeOr503(res);
    if (!store) return;
    try {
      res.json({ bindings: await store.list() });
    } catch (err) {
      res.status(500).json({ code: 'public_mcp_bindings.list_failed', message: String(err) });
    }
  });

  // ── Create / replace ────────────────────────────────────────────────────
  router.post('/', async (req: Request, res: Response) => {
    const store = storeOr503(res);
    if (!store) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: PublicMcpKeyBindingInput = {
      keyId: typeof body['keyId'] === 'string' ? body['keyId'].trim() : '',
      agentId: typeof body['agentId'] === 'string' ? body['agentId'].trim() : '',
      readTools: Array.isArray(body['readTools']) ? (body['readTools'] as readonly string[]) : [],
      writeTools: Array.isArray(body['writeTools'])
        ? (body['writeTools'] as readonly string[])
        : [],
      ...(body['writeRateLimitPerMinute'] === undefined
        ? {}
        : { writeRateLimitPerMinute: Number(body['writeRateLimitPerMinute']) }),
      ...(typeof body['enabled'] === 'boolean' ? { enabled: body['enabled'] } : {}),
    };

    // The reader's own rules decide. See `validateBindingInput`.
    const validated = validateBindingInput(input);
    if (!validated.ok) {
      res.status(400).json({ error: 'invalid_request', ...validated.error });
      return;
    }

    try {
      res.status(201).json({ binding: await store.upsert(validated.value) });
    } catch (err) {
      res.status(500).json({ code: 'public_mcp_bindings.upsert_failed', message: String(err) });
    }
  });

  // ── Revoke (park, never delete) ─────────────────────────────────────────
  // A revoked binding keeps its configured tool lists so an operator can see
  // what the integration USED to reach, and can restore it without
  // reconstructing the allowlist from memory. `DELETE` exists on the store for
  // completeness but is deliberately not exposed here: the destructive path
  // wants a deliberate decision, and parking already stops every call.
  router.post('/:keyId/revoke', async (req: Request, res: Response) => {
    const store = storeOr503(res);
    if (!store) return;

    const rawKeyId = req.params['keyId'];
    const keyId = Array.isArray(rawKeyId) ? rawKeyId[0] : rawKeyId;
    if (!keyId) {
      res.status(400).json({ error: 'invalid_request', message: 'missing key id' });
      return;
    }

    try {
      const binding = await store.setEnabled(keyId, false);
      if (!binding) {
        res.status(404).json({ error: 'not_found', keyId });
        return;
      }
      res.json({ binding });
    } catch (err) {
      res.status(500).json({ code: 'public_mcp_bindings.revoke_failed', message: String(err) });
    }
  });

  return router;
}
