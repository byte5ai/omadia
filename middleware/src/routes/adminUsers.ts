import { Router } from 'express';
import type { Request, Response } from 'express';

import type { AdminAuditLog } from '../auth/adminAuditLog.js';
import { hashPassword } from '../auth/passwordHasher.js';
import { LOCAL_PROVIDER_ID } from '../auth/providers/LocalPasswordProvider.js';
import type { UserRecord, UserStore } from '../auth/userStore.js';

interface AdminUsersDeps {
  userStore: UserStore;
  audit: AdminAuditLog;
}

/**
 * Admin-UI user management (OB-50). All routes require an `admin`
 * session — mounted under the same `requireAuth` gate as the rest of
 * /api/v1/* in `index.ts`, so this router itself trusts `req.session`.
 *
 * Local-only by design: only `provider = 'local'` rows can be created
 * here (an OIDC row appears via the IdP-callback upsert). Disable / role
 * / display-name edits work for any provider's row though, since those
 * are pure local-state changes.
 *
 * Self-lock-out: an admin can edit their own row but cannot disable or
 * delete themselves. Without that gate a single mistaken click would
 * lock the operator out of their own deployment with no recovery path
 * short of the bootstrap env-vars (which would re-create the same email
 * but lose the audit trail).
 */
export function createAdminUsersRouter(deps: AdminUsersDeps): Router {
  const router = Router();

  // ── GET /admin/users ──────────────────────────────────────────────────────
  router.get('/', async (req: Request, res: Response) => {
    const limit = parseIntQuery(req.query['limit'], 100);
    const offset = parseIntQuery(req.query['offset'], 0);
    const users = await deps.userStore.list({ limit, offset });
    res.json({ users: users.map(toPublicUser) });
  });

  // ── GET /admin/users/:id ──────────────────────────────────────────────────
  router.get('/:id', async (req: Request, res: Response) => {
    const id = readParam(req, 'id');
    if (!id) {
      res.status(400).json({ code: 'admin_users.missing_id' });
      return;
    }
    const user = await deps.userStore.findById(id);
    if (!user) {
      res.status(404).json({ code: 'admin_users.not_found' });
      return;
    }
    res.json({ user: toPublicUser(user) });
  });

  // ── POST /admin/users ─────────────────────────────────────────────────────
  // Creates a local-password user. Only the local provider supports admin-
  // create — for OIDC providers the row is materialised by the callback
  // upsert when the user first logs in.
  router.post('/', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      email?: unknown;
      password?: unknown;
      display_name?: unknown;
    };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName =
      typeof body.display_name === 'string' ? body.display_name.trim() : '';

    if (email.length === 0 || !email.includes('@')) {
      res.status(400).json({ code: 'admin_users.invalid_email' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ code: 'admin_users.password_too_short' });
      return;
    }
    const existing = await deps.userStore.findByEmail(LOCAL_PROVIDER_ID, email);
    if (existing) {
      res.status(409).json({ code: 'admin_users.email_in_use' });
      return;
    }

    const passwordHash = await hashPassword(password);
    const created = await deps.userStore.create({
      email,
      provider: LOCAL_PROVIDER_ID,
      providerUserId: email.toLowerCase(),
      passwordHash,
      displayName: displayName.length > 0 ? displayName : email,
      role: 'admin',
    });

    await deps.audit.record({
      actor: { id: undefined, email: req.session?.email },
      action: 'user.create',
      target: `user:${created.id}`,
      after: toPublicUser(created),
    });

    res.status(201).json({ user: toPublicUser(created) });
  });

  // ── PATCH /admin/users/:id ────────────────────────────────────────────────
  router.patch('/:id', async (req: Request, res: Response) => {
    const id = readParam(req, 'id');
    if (!id) {
      res.status(400).json({ code: 'admin_users.missing_id' });
      return;
    }
    const before = await deps.userStore.findById(id);
    if (!before) {
      res.status(404).json({ code: 'admin_users.not_found' });
      return;
    }

    const body = (req.body ?? {}) as {
      display_name?: unknown;
      status?: unknown;
      role?: unknown;
    };

    const patch: Parameters<UserStore['update']>[1] = {};
    if (typeof body.display_name === 'string') {
      patch.displayName = body.display_name.trim();
    }
    if (body.status === 'active' || body.status === 'disabled') {
      patch.status = body.status;
    }
    if (body.role === 'admin') {
      patch.role = body.role;
    }

    if (patch.status === 'disabled') {
      const isSelf = await isActingOnSelf(req, before, deps.userStore);
      if (isSelf) {
        res.status(409).json({ code: 'admin_users.self_lockout' });
        return;
      }
    }

    const updated = await deps.userStore.update(id, patch);
    if (!updated) {
      // Race: row vanished between findById and update.
      res.status(404).json({ code: 'admin_users.not_found' });
      return;
    }

    await deps.audit.record({
      actor: { email: req.session?.email },
      action: 'user.update',
      target: `user:${updated.id}`,
      before: toPublicUser(before),
      after: toPublicUser(updated),
    });

    res.json({ user: toPublicUser(updated) });
  });

  // ── POST /admin/users/:id/reset-password ──────────────────────────────────
  router.post('/:id/reset-password', async (req: Request, res: Response) => {
    const id = readParam(req, 'id');
    if (!id) {
      res.status(400).json({ code: 'admin_users.missing_id' });
      return;
    }
    const user = await deps.userStore.findById(id);
    if (!user) {
      res.status(404).json({ code: 'admin_users.not_found' });
      return;
    }
    if (user.provider !== LOCAL_PROVIDER_ID) {
      res.status(409).json({ code: 'admin_users.not_local' });
      return;
    }
    const body = (req.body ?? {}) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) {
      res.status(400).json({ code: 'admin_users.password_too_short' });
      return;
    }
    const passwordHash = await hashPassword(password);
    await deps.userStore.update(id, { passwordHash });

    await deps.audit.record({
      actor: { email: req.session?.email },
      action: 'user.reset_password',
      target: `user:${user.id}`,
      // No before/after content — we never log password material, even
      // hashed. Audit row alone tells operators a reset happened, who
      // did it, and when.
    });

    res.json({ ok: true });
  });

  // ── DELETE /admin/users/:id ───────────────────────────────────────────────
  router.delete('/:id', async (req: Request, res: Response) => {
    const id = readParam(req, 'id');
    if (!id) {
      res.status(400).json({ code: 'admin_users.missing_id' });
      return;
    }
    const target = await deps.userStore.findById(id);
    if (!target) {
      res.status(404).json({ code: 'admin_users.not_found' });
      return;
    }
    const isSelf = await isActingOnSelf(req, target, deps.userStore);
    if (isSelf) {
      res.status(409).json({ code: 'admin_users.self_lockout' });
      return;
    }
    const removed = await deps.userStore.deleteById(id);
    if (!removed) {
      res.status(404).json({ code: 'admin_users.not_found' });
      return;
    }
    await deps.audit.record({
      actor: { email: req.session?.email },
      action: 'user.delete',
      target: `user:${target.id}`,
      before: toPublicUser(target),
    });
    res.status(204).send();
  });

  return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

interface PublicUser {
  id: string;
  email: string;
  provider: string;
  display_name: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

function toPublicUser(u: UserRecord): PublicUser {
  return {
    id: u.id,
    email: u.email,
    provider: u.provider,
    display_name: u.displayName,
    role: u.role,
    status: u.status,
    created_at: u.createdAt.toISOString(),
    updated_at: u.updatedAt.toISOString(),
    last_login_at: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  };
}

function readParam(req: Request, key: string): string | undefined {
  const v = (req.params as Record<string, string | string[] | undefined>)[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

function parseIntQuery(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve "is the session-holder the same human as the target row?".
 * Session claims store provider + sub (= providerUserId), so we look up
 * the actor's row and compare ids. Returns false on lookup failure to
 * avoid blocking an admin from acting on others when their own row is
 * orphaned (shouldn't happen, but the safe-default is "let the action
 * through, audit will catch surprise").
 */
async function isActingOnSelf(
  req: Request,
  target: UserRecord,
  store: UserStore,
): Promise<boolean> {
  const claims = req.session;
  if (!claims) return false;
  const actor = await store.findByProviderUserId(claims.provider, claims.sub);
  return actor?.id === target.id;
}
