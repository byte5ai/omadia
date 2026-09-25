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
 * Outcome of reconciling a NEWER server copy with the browser's copy.
 * `pushLocal` asks the caller to PUT `session` back: the browser holds
 * turns the server never received (a fire-and-forget PUT failed), and the
 * server's merging PUT keeps the deliveries it already has.
 */
export interface NewerRemoteReconciliation {
  session: ChatSession;
  pushLocal: boolean;
}

/**
 * #1071 — hydration: the server copy of a chat is NEWER than the browser's.
 *
 * The server copy only holds what the PUT schema declares (zod strips the
 * rest), so attachments, privacy receipts, routing, persona, follow-up
 * options, … exist only in the browser's copy. A routine delivery bumps the
 * server `updatedAt`, so "newer" no longer means "ahead". Three cases, keyed
 * on the non-proactive (turn) message ids:
 *
 * - Same turns, in order: the server differs only by routine deliveries.
 *   Keep the local copy and fold the deliveries in; the title follows the
 *   server (a rename is the only other thing a newer copy can carry).
 * - The server's turns are a NON-EMPTY proper prefix of the local ones: the
 *   browser is AHEAD — a turn's PUT failed, and a delivery then made the
 *   server copy newer. Keep the local copy (its turns exist nowhere else),
 *   fold the deliveries in and ask for a catch-up PUT, exactly the "backend
 *   is behind" healing a chat got before deliveries could bump `updatedAt`.
 * - Anything else — a turn from another device, a clear or reset (no server
 *   turns) — is a real newer state and the server copy wins.
 */
export function reconcileNewerRemote(
  local: ChatSession,
  remote: ChatSession,
): NewerRemoteReconciliation {
  const localTurns = turnIds(local);
  const remoteTurns = turnIds(remote);
  const isPrefix = remoteTurns.every((id, i) => id === localTurns[i]);
  if (isPrefix && remoteTurns.length === localTurns.length) {
    const merged = mergeProactiveFromRemote(local, remote);
    return {
      session: {
        ...merged,
        title: remote.title,
        updatedAt: Math.max(merged.updatedAt, remote.updatedAt),
      },
      pushLocal: false,
    };
  }
  if (isPrefix && remoteTurns.length > 0 && remoteTurns.length < localTurns.length) {
    return { session: mergeProactiveFromRemote(local, remote), pushLocal: true };
  }
  return { session: remote, pushLocal: false };
}

function turnIds(session: ChatSession): string[] {
  return session.messages.filter((m) => m.proactive === undefined).map((m) => m.id);
}
