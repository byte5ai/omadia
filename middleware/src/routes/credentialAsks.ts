/**
 * #578 Phase 3 — the HTTP surface for keychain-asks: request a `personal`
 * credential from its owner; approval creates the grant.
 *
 * Mounted by #778 W1 (#792) at `/api/v1/admin/credential-asks` behind
 * `requireAuth` (`index.ts`; pinned by `778RouteMounts.wiring.test.ts`).
 *
 * ## #778 S1 — every caller identity comes from the session
 *
 * The caller is `user:<req.session.omadia_user_id>`, and nothing else. No
 * `sub`/`email` fallback: `auth/sessionIdentity.ts` documents that as a
 * different namespace (MCP tokens), and every other owner-style check on
 * this server (`datasets.ts`, `memory.ts`, `skillPromotion.ts`) compares
 * against `omadia_user_id`. No session id → 401 `auth.required`.
 *
 * Client-supplied caller identity is REJECTED (400
 * `credential_ask.identity_from_session`), not silently ignored, so a
 * pre-S1 client fails loudly instead of acting as someone it did not mean:
 * `requesterUserId` (create, cancel), `resolvedBy` (approve, deny),
 * `?owner` (`/pending`), `?requester` (`/mine`).
 *
 *  - **create** — requester = session. The owner is derived by the store
 *    from the credential's own `owner`; an optional `ownerUserId` is only a
 *    cross-check (mismatch → 400 `credential_ask.owner_mismatch`). Domain
 *    rejections (unknown / not askable / revoked credential) → 400; any
 *    other failure → 500 with a generic message.
 *  - **approve / deny** — owner-only (maintainer decision D2: no operator
 *    break-glass). Unknown id → 404; session ≠ `ask.owner` → 403
 *    `credential_ask.forbidden`; not actionable (resolved, expired, or the
 *    credential was revoked since the ask) → 409. `ask.owner` is immutable
 *    (migration 0043), so reading it before the atomic claim is race-free.
 *  - **cancel** — requester-scoped in the store; anyone else gets the same
 *    404 as an unknown id.
 *
 * Consequence for credential creation (#778 follow-up): a personal
 * credential's owner must be stored as `user:<omadia_user_id>`, or nobody
 * can ever approve an ask against it.
 *
 * There is deliberately no "list all asks" / operator-wide endpoint here:
 * every read is scoped to the session principal — an owner sees what is
 * addressed to them, a requester sees what they asked for.
 */

import { Router, type Request, type Response } from 'express';

import { makePrincipal, type Principal } from '@omadia/channel-sdk';

import { CredentialAskRejectedError, type CredentialAsk, type CredentialAskStore } from '../credentials/asks.js';

export interface CredentialAskRoutesDeps {
  readonly store: CredentialAskStore;
  /** Ask TTL when the caller does not specify one. Default 24h. */
  readonly defaultAskTtlMs?: number;
  /** Hard ceiling on a caller-specified TTL, so an ask cannot be created
   *  effectively permanent by asking for a huge window. Default 7 days. */
  readonly maxAskTtlMs?: number;
  /** Clock, injected for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

const DEFAULT_ASK_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ASK_TTL_MS = 60 * 1000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A string that parses to a real instant, or undefined. */
function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** Only `user:` principals are accepted — same reasoning as
 *  `audience/routes.ts`'s `parseUserPrincipal`: a `role:` requester or owner
 *  is an indirection over holders, not a subject that can own a credential
 *  or be the one who approves. */
function parseUserPrincipal(userId: string): Principal | undefined {
  const trimmed = userId.trim();
  if (trimmed.length === 0) return undefined;
  return makePrincipal('user', trimmed);
}

interface SessionCaller {
  /** The raw `omadia_user_id` — what `resolved_by` records. */
  readonly userId: string;
  readonly principal: Principal;
}

/** Same shape as `skillPromotion.ts`/`datasets.ts`: `omadia_user_id` only,
 *  no `sub`/`email` fallback (see the file header). */
function requireSessionCaller(req: Request, res: Response): SessionCaller | null {
  const userId = req.session?.omadia_user_id;
  const principal = typeof userId === 'string' ? parseUserPrincipal(userId) : undefined;
  if (!userId || !principal) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return { userId: userId.trim(), principal };
}

/** 400s (and returns true) when the client tried to name a caller identity
 *  the route takes from the session instead. */
function rejectClientIdentity(res: Response, source: Record<string, unknown>, field: string): boolean {
  if (source[field] === undefined) return false;
  res.status(400).json({
    code: 'credential_ask.identity_from_session',
    message: `${field} is not accepted: the caller identity comes from the session`,
  });
  return true;
}

function samePrincipal(a: Principal, b: Principal): boolean {
  if (a.kind !== b.kind) return false;
  const refA = makePrincipal(a.kind, a.kind === 'user' ? a.userId : a.roleKey);
  const refB = makePrincipal(b.kind, b.kind === 'user' ? b.userId : b.roleKey);
  return refA !== undefined && refB !== undefined && principalRef(refA) === principalRef(refB);
}

const NOT_ACTIONABLE_BODY = {
  code: 'credential_ask.not_actionable',
  message: 'ask is already resolved, has expired, or its credential is no longer askable',
} as const;

export function createCredentialAskRouter(deps: CredentialAskRoutesDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const defaultTtl = deps.defaultAskTtlMs ?? DEFAULT_ASK_TTL_MS;
  const maxTtl = deps.maxAskTtlMs ?? DEFAULT_MAX_ASK_TTL_MS;

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const caller = requireSessionCaller(req, res);
    if (!caller) return;
    const body = asObject(req.body);
    if (rejectClientIdentity(res, body, 'requesterUserId')) return;

    const credentialId = str(body.credentialId).trim();
    const purpose = str(body.purpose).trim();
    const mode = str(body.mode);
    let owner: Principal | undefined;
    if (body.ownerUserId !== undefined) {
      owner = parseUserPrincipal(str(body.ownerUserId));
      if (!owner) {
        res.status(400).json({
          code: 'credential_ask.invalid_input',
          message: 'ownerUserId, when given, must be a non-empty user id',
        });
        return;
      }
    }
    if (!credentialId || !purpose || (mode !== 'once' && mode !== 'standing')) {
      res.status(400).json({
        code: 'credential_ask.invalid_input',
        message: 'credentialId, purpose and mode ("once"|"standing") are required',
      });
      return;
    }
    const requestedTtl = num(body.askTtlMs) ?? defaultTtl;
    const clampedTtl = Math.min(Math.max(requestedTtl, MIN_ASK_TTL_MS), maxTtl);
    // Validated for every mode: a garbage value on a 'standing' ask used to
    // reach the store as an Invalid Date (500 on Postgres), and a non-string
    // was silently dropped into an unbounded standing grant.
    let requestedGrantExpiresAt: Date | undefined;
    if (body.requestedGrantExpiresAt !== undefined) {
      requestedGrantExpiresAt = parseDate(body.requestedGrantExpiresAt);
      if (!requestedGrantExpiresAt) {
        res.status(400).json({
          code: 'credential_ask.invalid_input',
          message: 'requestedGrantExpiresAt, when given, must be a valid date string',
        });
        return;
      }
    }
    if (mode === 'once' && !requestedGrantExpiresAt) {
      res.status(400).json({
        code: 'credential_ask.invalid_input',
        message: 'mode "once" requires a valid requestedGrantExpiresAt',
      });
      return;
    }

    try {
      const ask = await deps.store.createAsk({
        credentialId,
        requester: caller.principal,
        owner,
        purpose,
        mode,
        requestedGrantExpiresAt,
        askExpiresAt: new Date(now().getTime() + clampedTtl),
      });
      res.status(201).json(toAskBody(ask));
    } catch (err) {
      if (err instanceof CredentialAskRejectedError) {
        const code = err.reason === 'owner_mismatch' ? 'credential_ask.owner_mismatch' : 'credential_ask.create_failed';
        res.status(400).json({ code, message: err.message });
        return;
      }
      console.error('[credential-asks] create failed:', err);
      res.status(500).json({ code: 'credential_ask.create_failed', message: 'could not create the credential ask' });
    }
  });

  router.get('/pending', async (req: Request, res: Response): Promise<void> => {
    const caller = requireSessionCaller(req, res);
    if (!caller) return;
    if (rejectClientIdentity(res, asObject(req.query), 'owner')) return;
    try {
      const asks = await deps.store.listPendingForOwner(caller.principal, now());
      res.json({ asks: asks.map(toAskBody) });
    } catch (err) {
      res.status(500).json({ code: 'credential_ask.list_failed', message: errMsg(err) });
    }
  });

  router.get('/mine', async (req: Request, res: Response): Promise<void> => {
    const caller = requireSessionCaller(req, res);
    if (!caller) return;
    if (rejectClientIdentity(res, asObject(req.query), 'requester')) return;
    try {
      const asks = await deps.store.listForRequester(caller.principal);
      res.json({ asks: asks.map(toAskBody) });
    } catch (err) {
      res.status(500).json({ code: 'credential_ask.list_failed', message: errMsg(err) });
    }
  });

  for (const action of ['approve', 'deny'] as const) {
    router.post(`/:id/${action}`, async (req: Request, res: Response): Promise<void> => {
      const caller = requireSessionCaller(req, res);
      if (!caller) return;
      if (rejectClientIdentity(res, asObject(req.body), 'resolvedBy')) return;
      const id = req.params.id as string;
      try {
        const existing = await deps.store.getAsk(id);
        if (!existing) {
          res.status(404).json({ code: 'credential_ask.not_found', message: 'no ask with that id' });
          return;
        }
        if (!samePrincipal(existing.owner, caller.principal)) {
          res.status(403).json({
            code: 'credential_ask.forbidden',
            message: `only the credential owner may ${action} this ask`,
          });
          return;
        }
        const ask =
          action === 'approve'
            ? await deps.store.approve(id, caller.userId, now())
            : await deps.store.deny(id, caller.userId, now());
        if (!ask) {
          res.status(409).json(NOT_ACTIONABLE_BODY);
          return;
        }
        res.json(toAskBody(ask));
      } catch (err) {
        res.status(500).json({ code: `credential_ask.${action}_failed`, message: errMsg(err) });
      }
    });
  }

  router.post('/:id/cancel', async (req: Request, res: Response): Promise<void> => {
    const caller = requireSessionCaller(req, res);
    if (!caller) return;
    if (rejectClientIdentity(res, asObject(req.body), 'requesterUserId')) return;
    try {
      const cancelled = await deps.store.cancel(req.params.id as string, caller.principal);
      if (!cancelled) {
        res.status(404).json({
          code: 'credential_ask.not_found',
          message: 'no pending ask with that id belonging to you',
        });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ code: 'credential_ask.cancel_failed', message: errMsg(err) });
    }
  });

  return router;
}

function toAskBody(ask: CredentialAsk): Record<string, unknown> {
  return {
    id: ask.id,
    credential_id: ask.credentialId,
    requester: principalRef(ask.requester),
    owner: principalRef(ask.owner),
    purpose: ask.purpose,
    mode: ask.mode,
    requested_grant_expires_at: ask.requestedGrantExpiresAt?.toISOString() ?? null,
    ask_expires_at: ask.askExpiresAt.toISOString(),
    status: ask.status,
    created_at: ask.createdAt.toISOString(),
    resolved_at: ask.resolvedAt?.toISOString() ?? null,
    resolved_by: ask.resolvedBy ?? null,
    grant_id: ask.grantId ?? null,
  };
}

function principalRef(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : principal.roleKey;
}
