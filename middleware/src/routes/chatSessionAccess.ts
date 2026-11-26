import type { Request } from 'express';
import type { ChatSessionStore } from '@omadia/orchestrator';
import { chatSessionOwnedBy } from '@omadia/orchestrator';

// Session claims (`req.session`) come from requireAuth's augmentation.
import '../auth/requireAuth.js';

/**
 * #1762 (ADR-0180) — web chats belong to the account that created them.
 *
 * The owner key is the session's `sub` (`users.id`): present on every
 * authenticated session, unlike `omadia_user_id`, and never taken from the
 * request body or a header. A request without one owns no chat.
 */
export function chatViewer(req: Request): string | undefined {
  const sub = req.session?.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : undefined;
}

/**
 * The owner of chats written before #1762 (no `ownerUserId`): the instance's
 * only account, or `undefined` once there is more than one, which hides those
 * chats from everyone. Resolved per request, because an instance can grow a
 * second account at any time.
 */
export type LegacyChatOwner = () => Promise<string | undefined>;

/** Accounts at most this old are reused, so a list or a turn does not query the users table every time. */
const SOLE_ACCOUNT_CACHE_MS = 30_000;

/**
 * {@link LegacyChatOwner} from the users table: the account's id when the
 * table holds exactly one. A failed lookup resolves to nobody (fail closed).
 */
export function soleAccountLegacyOwner(
  listAccounts: (limit: number) => Promise<readonly { id: string }[]>,
  now: () => number = Date.now,
): LegacyChatOwner {
  let cached: { at: number; owner: string | undefined } | undefined;
  return async () => {
    if (cached && now() - cached.at < SOLE_ACCOUNT_CACHE_MS) return cached.owner;
    try {
      const accounts = await listAccounts(2);
      const owner = accounts.length === 1 ? accounts[0]?.id : undefined;
      cached = { at: now(), owner };
      return owner;
    } catch (err) {
      console.warn(
        '[chat-sessions] could not resolve the owner of legacy chats, hiding them:',
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  };
}

/**
 * May `req` use the chat `sessionId` (a turn, a steer, an agent command)?
 * True when no such chat is stored yet (the web client PUTs it right after),
 * or when the caller owns it. A chat of another account answers like a
 * missing one at the caller.
 */
export async function mayUseChatSession(
  req: Request,
  store: ChatSessionStore | undefined,
  sessionId: string,
  legacyOwner: LegacyChatOwner | undefined,
): Promise<boolean> {
  if (!store) return true;
  const session = await store.get(sessionId);
  if (!session) return true;
  return chatSessionOwnedBy(session, chatViewer(req), await legacyOwner?.());
}
