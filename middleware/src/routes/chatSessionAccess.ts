import type { Request } from 'express';
import type { ChatSessionStore } from '@omadia/orchestrator';
import { chatSessionOwnedBy, isCanonicalChatSessionId } from '@omadia/orchestrator';

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
  listAccounts: (limit: number) => Promise<readonly { id: string; status?: string }[]>,
  now: () => number = Date.now,
): LegacyChatOwner {
  let cached: { at: number; owner: string | undefined } | undefined;
  return async () => {
    if (cached && now() - cached.at < SOLE_ACCOUNT_CACHE_MS) return cached.owner;
    try {
      // Every account counts, disabled ones too: a chat must not move to
      // whoever is left active. A page of 2 tells "one" from "more".
      const accounts = await listAccounts(2);
      const owner = accounts.length === 1 && accounts[0]?.status !== 'disabled' ? accounts[0]?.id : undefined;
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

/** What {@link chatSessionUse} decides for a chat id. */
export type ChatSessionUse = 'ok' | 'not_found' | 'non_canonical_id';

/**
 * May `req` use the chat `sessionId` (a turn, a steer, an agent command, an
 * upload)? `ok` when the caller owns the stored chat, or when no such chat is
 * stored yet (the web client PUTs it right after) and the id is canonical. A
 * chat of another account answers `not_found`, like a missing one. A new chat
 * whose id is not lower case answers `non_canonical_id` (#2361, ADR-0330): its
 * transcripts and graph key would fold into the lower-case chat's.
 */
export async function chatSessionUse(
  req: Request,
  store: ChatSessionStore | undefined,
  sessionId: string,
  legacyOwner: LegacyChatOwner | undefined,
): Promise<ChatSessionUse> {
  const session = store ? await store.get(sessionId) : null;
  if (!session) return isCanonicalChatSessionId(sessionId) ? 'ok' : 'non_canonical_id';
  return chatSessionOwnedBy(session, chatViewer(req), await legacyOwner?.()) ? 'ok' : 'not_found';
}

/** The HTTP refusal for a {@link ChatSessionUse} other than `ok`. */
export function chatSessionRefusal(
  use: Exclude<ChatSessionUse, 'ok'>,
  sessionId: string,
): { readonly status: 400 | 404; readonly error: string; readonly message: string } {
  return use === 'not_found'
    ? { status: 404, error: 'not_found', message: `chat session ${sessionId} not found` }
    : { status: 400, error: 'non_canonical_id', message: 'a new chat session id must be lower case' };
}
