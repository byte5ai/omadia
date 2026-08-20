/**
 * #578 Phase 3 — the HTTP surface for keychain-asks: request a `personal`
 * credential from its owner; approval creates the grant.
 *
 * Not mounted into `middleware/src/index.ts` yet — same deliberate choice
 * phases 1 and 2 made (see their PR descriptions): this is a fully tested,
 * standalone router a future integration step mounts with one line, behind
 * `requireAuth` like every other `/api/v1/admin/*` router (`audience/routes.ts`
 * is the precedent). Keeping it unmounted keeps this phase's blast radius to
 * new files only, consistent with phases 1 and 2, and avoids a merge
 * collision with the parallel #577 session's own changes to `index.ts`.
 *
 * There is deliberately no "list all asks" / operator-wide endpoint here:
 * every read is scoped to a principal (`owner` for the inbox, `requester`
 * for "my asks"), matching the ask's own access model — an owner sees what
 * is addressed to them, a requester sees what they asked for, and nobody
 * else's asks leak into either view.
 */

import { Router, type Request, type Response } from 'express';

import { makePrincipal, type Principal } from '@omadia/channel-sdk';

import type { CredentialAskStore } from '../credentials/asks.js';

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

/** Only `user:` principals are accepted — same reasoning as
 *  `audience/routes.ts`'s `parseUserPrincipal`: a `role:` requester or owner
 *  is an indirection over holders, not a subject that can own a credential
 *  or be the one who approves. */
function parseUserPrincipal(userId: string): Principal | undefined {
  const trimmed = userId.trim();
  if (trimmed.length === 0) return undefined;
  return makePrincipal('user', trimmed);
}

export function createCredentialAskRouter(deps: CredentialAskRoutesDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const defaultTtl = deps.defaultAskTtlMs ?? DEFAULT_ASK_TTL_MS;
  const maxTtl = deps.maxAskTtlMs ?? DEFAULT_MAX_ASK_TTL_MS;

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const credentialId = str(body.credentialId).trim();
    const requester = parseUserPrincipal(str(body.requesterUserId));
    const owner = parseUserPrincipal(str(body.ownerUserId));
    const purpose = str(body.purpose).trim();
    const mode = str(body.mode);
    if (!credentialId || !requester || !owner || !purpose || (mode !== 'once' && mode !== 'standing')) {
      res.status(400).json({
        code: 'credential_ask.invalid_input',
        message: 'credentialId, requesterUserId, ownerUserId, purpose and mode ("once"|"standing") are required',
      });
      return;
    }
    const requestedTtl = num(body.askTtlMs) ?? defaultTtl;
    const clampedTtl = Math.min(Math.max(requestedTtl, MIN_ASK_TTL_MS), maxTtl);
    const requestedGrantExpiresAtRaw = str(body.requestedGrantExpiresAt);
    const requestedGrantExpiresAt = requestedGrantExpiresAtRaw ? new Date(requestedGrantExpiresAtRaw) : undefined;
    if (mode === 'once' && (!requestedGrantExpiresAt || Number.isNaN(requestedGrantExpiresAt.getTime()))) {
      res.status(400).json({
        code: 'credential_ask.invalid_input',
        message: 'mode "once" requires a valid requestedGrantExpiresAt',
      });
      return;
    }

    try {
      const ask = await deps.store.createAsk({
        credentialId,
        requester,
        owner,
        purpose,
        mode,
        requestedGrantExpiresAt,
        askExpiresAt: new Date(now().getTime() + clampedTtl),
      });
      res.status(201).json(toAskBody(ask));
    } catch (err) {
      res.status(400).json({ code: 'credential_ask.create_failed', message: errMsg(err) });
    }
  });

  router.get('/pending', async (req: Request, res: Response): Promise<void> => {
    const owner = parseUserPrincipal(str(req.query.owner));
    if (!owner) {
      res.status(400).json({ code: 'credential_ask.invalid_input', message: 'owner is required' });
      return;
    }
    try {
      const asks = await deps.store.listPendingForOwner(owner, now());
      res.json({ asks: asks.map(toAskBody) });
    } catch (err) {
      res.status(500).json({ code: 'credential_ask.list_failed', message: errMsg(err) });
    }
  });

  router.get('/mine', async (req: Request, res: Response): Promise<void> => {
    const requester = parseUserPrincipal(str(req.query.requester));
    if (!requester) {
      res.status(400).json({ code: 'credential_ask.invalid_input', message: 'requester is required' });
      return;
    }
    try {
      const asks = await deps.store.listForRequester(requester);
      res.json({ asks: asks.map(toAskBody) });
    } catch (err) {
      res.status(500).json({ code: 'credential_ask.list_failed', message: errMsg(err) });
    }
  });

  router.post('/:id/approve', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const resolvedBy = str(body.resolvedBy).trim();
    if (!resolvedBy) {
      res.status(400).json({ code: 'credential_ask.invalid_input', message: 'resolvedBy is required' });
      return;
    }
    try {
      const ask = await deps.store.approve(req.params.id as string, resolvedBy, now());
      if (!ask) {
        res.status(409).json({
          code: 'credential_ask.not_actionable',
          message: 'ask is already resolved or has expired',
        });
        return;
      }
      res.json(toAskBody(ask));
    } catch (err) {
      res.status(500).json({ code: 'credential_ask.approve_failed', message: errMsg(err) });
    }
  });

  router.post('/:id/deny', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const resolvedBy = str(body.resolvedBy).trim();
    if (!resolvedBy) {
      res.status(400).json({ code: 'credential_ask.invalid_input', message: 'resolvedBy is required' });
      return;
    }
    try {
      const ask = await deps.store.deny(req.params.id as string, resolvedBy, now());
      if (!ask) {
        res.status(409).json({
          code: 'credential_ask.not_actionable',
          message: 'ask is already resolved or has expired',
        });
        return;
      }
      res.json(toAskBody(ask));
    } catch (err) {
      res.status(500).json({ code: 'credential_ask.deny_failed', message: errMsg(err) });
    }
  });

  router.post('/:id/cancel', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const requester = parseUserPrincipal(str(body.requesterUserId));
    if (!requester) {
      res.status(400).json({ code: 'credential_ask.invalid_input', message: 'requesterUserId is required' });
      return;
    }
    try {
      const cancelled = await deps.store.cancel(req.params.id as string, requester);
      if (!cancelled) {
        res.status(404).json({
          code: 'credential_ask.not_found',
          message: 'no pending ask with that id belonging to that requester',
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

function toAskBody(ask: {
  id: string;
  credentialId: string;
  requester: Principal;
  owner: Principal;
  purpose: string;
  mode: string;
  requestedGrantExpiresAt?: Date;
  askExpiresAt: Date;
  status: string;
  createdAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  grantId?: string;
}): Record<string, unknown> {
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
