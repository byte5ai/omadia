import type { ChatSession, Message } from './chatSessions';

/**
 * #1071 — fold server-written routine deliveries into the local copy of a
 * chat without touching anything else.
 *
 * A scheduled routine created from the web chat appends its output to the
 * persisted session on the server (a `proactive` assistant message). The
 * web UI hydrates once per page load, so without a re-read the delivery only
 * shows after a full reload. The chat page re-reads the active session when it
 * mounts, after hydration, on chat switch and when the tab becomes visible
 * again, folds in the document a PUT answers with, and merges ADDITIVELY:
 * remote proactive messages missing locally are inserted, every other remote
 * difference is ignored — local state stays the source of truth while the
 * app runs.
 *
 * Placement mirrors the server's merge (`mergeServerProactiveMessages`):
 * before the first local USER message that started after the delivery, else
 * at the end — never between a question and its answer.
 *
 * Returns `local` itself when there is nothing to add, so a re-read that
 * finds nothing new causes no state change.
 */
export function mergeProactiveFromRemote(
  local: ChatSession,
  remote: ChatSession,
): ChatSession {
  const localIds = new Set(local.messages.map((m) => m.id));
  const missing = remote.messages.filter(
    (m) => m.proactive !== undefined && !localIds.has(m.id),
  );
  if (missing.length === 0) return local;

  const messages: Message[] = [...local.messages];
  for (const m of missing) {
    const at = messages.findIndex(
      (x) => x.role === 'user' && x.startedAt > m.startedAt,
    );
    if (at === -1) messages.push(m);
    else messages.splice(at, 0, m);
  }
  return {
    ...local,
    messages,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

/**
 * #1071 — hydration: the server copy of a chat is NEWER than the browser's.
 *
 * The server copy only holds what the PUT schema declares (zod strips the
 * rest), so attachments, privacy receipts, routing, persona, follow-up
 * options, … exist only in the browser's copy. A routine delivery bumps the
 * server `updatedAt`; replacing the whole local chat with the server copy on
 * the next page load would drop those fields for good.
 *
 * So when the server copy differs from the local one ONLY by routine
 * deliveries (its non-proactive message ids are exactly the local ones, in
 * order), keep the local copy and fold the deliveries in; the title follows
 * the server (a rename is the only other thing a newer copy can carry). Any
 * other difference — a turn from another device, a clear, a reset — is a real
 * newer state and the server copy wins, as before #1071.
 */
export function reconcileNewerRemote(
  local: ChatSession,
  remote: ChatSession,
): ChatSession {
  const localTurns = turnIds(local);
  const remoteTurns = turnIds(remote);
  const sameTurns =
    localTurns.length === remoteTurns.length &&
    localTurns.every((id, i) => id === remoteTurns[i]);
  if (!sameTurns) return remote;
  const merged = mergeProactiveFromRemote(local, remote);
  return {
    ...merged,
    title: remote.title,
    updatedAt: Math.max(merged.updatedAt, remote.updatedAt),
  };
}

function turnIds(session: ChatSession): string[] {
  return session.messages.filter((m) => m.proactive === undefined).map((m) => m.id);
}
