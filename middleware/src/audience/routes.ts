/**
 * #575 phase 2 — the operator surface for audience-floor grants.
 *
 * The floor was switched on by #734 but had nowhere durable to read grants
 * from, and no way for an operator to see or change them. That combination is
 * worse than it sounds: because the floor fails closed, "I cannot see the
 * grants" and "there are no grants" produce the same observable behaviour —
 * every tool refused, no context recalled — with no way to tell them apart.
 * This router exists so that state is inspectable before it is enforced.
 *
 * ## Everything here is operator-gated
 *
 * Mounted behind `requireAuth`, like every other `/api/v1/admin/*` router.
 * Issue #669 is the reason that is stated rather than assumed: `/api/dev/*`
 * shipped unauthenticated because a single `publicPaths` entry made a whole
 * subtree public, and nobody noticed until it was audited.
 *
 * ## Writing a grant is not the same as enabling enforcement
 *
 * These endpoints are available whenever a Postgres grant store exists. They do
 * NOT switch the floor on — that is `AUDIENCE_FLOOR_ENABLED`. The separation is
 * deliberate: an operator must be able to seed and review a grant table BEFORE
 * enforcement begins, because enabling the floor against an empty table shuts
 * every room at once.
 */

import { Router, type Request, type Response } from 'express';

import { makePrincipal, type Principal } from '@omadia/channel-sdk';

import type { PostgresGrantStore } from './postgresGrantStore.js';

export interface AudienceGrantRoutesDeps {
  readonly store: PostgresGrantStore;
  /** Who is making the change, for the `granted_by` trail. */
  readonly actor: (req: Request) => string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Only `user:` principals are accepted.
 *
 * `resolveCapabilities` refuses a `role:` principal outright — a role is an
 * indirection over holders, not a subject with entitlements — so a direct grant
 * to one would be stored and then never read. Rejecting it at the boundary
 * turns a silently-inert row into a 400 that says which endpoint to use
 * instead.
 */
function parseUserPrincipal(userId: string): Principal | undefined {
  const trimmed = userId.trim();
  if (trimmed.length === 0) return undefined;
  return makePrincipal('user', trimmed);
}

export function createAudienceGrantRouter(deps: AudienceGrantRoutesDeps): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const [direct, roles] = await Promise.all([
        deps.store.listDirectGrants(),
        deps.store.listRoleGrants(),
      ]);
      res.json({ direct, roles });
    } catch (err) {
      res.status(500).json({ code: 'audience.grants_list_failed', message: errMsg(err) });
    }
  });

  router.post('/direct', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const principal = parseUserPrincipal(str(body.userId));
    const capability = str(body.capability).trim();
    if (!principal || !capability) {
      res.status(400).json({
        code: 'audience.invalid_input',
        message: 'userId and capability are required (role grants use /roles)',
      });
      return;
    }
    try {
      await deps.store.grantToPrincipal(principal, capability, deps.actor(req));
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(500).json({ code: 'audience.grant_failed', message: errMsg(err) });
    }
  });

  router.delete('/direct', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const principal = parseUserPrincipal(str(body.userId));
    const capability = str(body.capability).trim();
    if (!principal || !capability) {
      res.status(400).json({
        code: 'audience.invalid_input',
        message: 'userId and capability are required',
      });
      return;
    }
    try {
      const removed = await deps.store.revokeFromPrincipal(principal, capability);
      // 404 rather than a cheerful 200: an operator revoking a capability needs
      // to know the grant was not there, because the usual cause is a
      // mis-spelled id and the room's behaviour will not change.
      if (!removed) {
        res.status(404).json({ code: 'audience.grant_not_found', message: 'no such grant' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ code: 'audience.revoke_failed', message: errMsg(err) });
    }
  });

  router.post('/roles', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const roleKey = str(body.roleKey).trim();
    const capability = str(body.capability).trim();
    if (!roleKey || !capability) {
      res.status(400).json({
        code: 'audience.invalid_input',
        message: 'roleKey and capability are required',
      });
      return;
    }
    try {
      await deps.store.grantToRole(roleKey, capability, deps.actor(req));
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(500).json({ code: 'audience.grant_failed', message: errMsg(err) });
    }
  });

  router.delete('/roles', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const roleKey = str(body.roleKey).trim();
    const capability = str(body.capability).trim();
    if (!roleKey || !capability) {
      res.status(400).json({
        code: 'audience.invalid_input',
        message: 'roleKey and capability are required',
      });
      return;
    }
    try {
      const removed = await deps.store.revokeFromRole(roleKey, capability);
      if (!removed) {
        res.status(404).json({ code: 'audience.grant_not_found', message: 'no such grant' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ code: 'audience.revoke_failed', message: errMsg(err) });
    }
  });

  return router;
}
