import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatSessionStore } from '@omadia/orchestrator';

import { auditActorFromRequest, type AdminAuditLog } from '../auth/adminAuditLog.js';
import type { UserRecord } from '../auth/userStore.js';

/**
 * #1762 follow-up (ADR-0184) — `POST /api/v1/admin/chats/assign-orphans`.
 *
 * Web chats written before chats had owners (ADR-0180) are hidden from
 * everyone on an instance with more than one account. This operator tool
 * gives every such chat to one account:
 *
 *   body `{ userId: <users.id>, dryRun?: boolean }`
 *
 * The owner stamped is that account's session subject (`providerUserId`, the
 * `sub` the chat routes compare), so the account sees the chats on its next
 * list. Only owner-less, readable chats change; the call is idempotent. A
 * dry run counts and changes nothing. A real run writes its `admin_audit` row
 * first and changes nothing when that write fails.
 */

const BodySchema = z.object({
  userId: z.string().uuid(),
  dryRun: z.boolean().optional(),
});

export interface AdminChatsDeps {
  getStore: () => ChatSessionStore | undefined;
  findUser: (id: string) => Promise<UserRecord | null>;
  audit: Pick<AdminAuditLog, 'record'> | undefined;
}

export function createAdminChatsRouter(deps: AdminChatsDeps): Router {
  const router = Router();

  router.post('/assign-orphans', async (req: Request, res: Response) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'chats.invalid_request', issues: parsed.error.issues });
      return;
    }
    const store = deps.getStore();
    if (!store) {
      res.status(503).json({ code: 'chats.unavailable', message: 'the chat session store is not running' });
      return;
    }
    const { userId, dryRun = false } = parsed.data;
    try {
      const user = await deps.findUser(userId);
      if (!user) {
        res.status(404).json({ code: 'chats.unknown_user' });
        return;
      }
      if (user.status !== 'active') {
        res.status(409).json({ code: 'chats.user_not_active' });
        return;
      }
      const owner = user.providerUserId;
      const preview = await store.assignOrphans(owner, { dryRun: true });
      if (dryRun) {
        res.json({ dryRun: true, wouldAssign: preview.assigned.length, unreadable: preview.unreadable });
        return;
      }
      if (!deps.audit) {
        res.status(503).json({ code: 'chats.audit_unavailable', message: 'no audit log: nothing was changed' });
        return;
      }
      try {
        await deps.audit.record({
          actor: auditActorFromRequest(req),
          action: 'chat.assign_orphans',
          target: `user:${user.id}`,
          before: { orphans: preview.assigned.length, unreadable: preview.unreadable },
          after: { owner: user.id, count: preview.assigned.length },
        });
      } catch {
        console.error('[admin-chats] audit write failed — nothing was assigned');
        res.status(500).json({ code: 'chats.audit_failed', message: 'the audit row could not be written; nothing was changed' });
        return;
      }
      const done = await store.assignOrphans(owner, { dryRun: false });
      console.warn(
        `[security-audit] admin-chats: assigned ${String(done.assigned.length)} owner-less chat(s) to user ${user.id}`,
      );
      res.json({ dryRun: false, assigned: done.assigned.length, unreadable: done.unreadable });
    } catch (err) {
      console.error('[admin-chats] assign-orphans failed:', err);
      res.status(500).json({ code: 'chats.internal_error' });
    }
  });

  return router;
}
