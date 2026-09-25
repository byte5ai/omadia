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
 *
 * `updatedAt` stays the LOCAL value: a fold is not a sync. Raising it to the
 * server's would hide a turn whose PUT failed (the CLI runtime has no
 * SessionLogger mirror) from the next hydration, which pushes a local copy
 * back only when it is newer or holds turns the server lacks — see
 * `reconcileNewerRemote`.
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
  return { ...local, messages };
}

/**
 * #1071 — fold a server copy into the chat as STORED in localStorage (which
 * another tab may have written after this one loaded). Returns the chat to
 * store, or `null` when there is nothing to write: no new delivery, or the
 * server copy predates a clear the stored chat already records (its
 * `resetAt` is newer than the server copy's) — folding it would bring the
 * cleared deliveries back.
 */
export function foldIntoStored(
  stored: ChatSession,
  remote: ChatSession,
): ChatSession | null {
  if (stored.resetAt !== undefined && (remote.resetAt ?? -Infinity) < stored.resetAt) {
    return null;
  }
  const merged = mergeProactiveFromRemote(stored, remote);
  return merged === stored ? null : merged;
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
 * server `updatedAt`, so "newer" no longer means "ahead". Turns (the
 * non-proactive messages) are compared position by position: a remote turn
 * matches the local one with the same id when that local message is finished
 * and its trimmed content equals the server's, or — for a turn the server's
 * SessionLogger mirrored (`srv-u-…` / `srv-a-…`, see `isMirroredTurn`) — the
 * finished local message with the same role and content, the rule the
 * mirror's own idempotency check (`appendTurnUnlocked`) uses. Only a client
 * PUT swaps those ids for the client's, so on the in-process runtime a turn
 * whose PUT failed sits on the server under `srv-*` ids. Three cases:
 *
 * - Same turns, in order: the server differs only by routine deliveries.
 *   Keep the local copy and fold the deliveries in; the title follows the
 *   server (a rename is the only other thing a newer copy can carry). If a
 *   mirrored turn matched, the server never received the client's copy of
 *   it — ask for a catch-up PUT so the client ids replace the `srv-*` ones.
 * - The server's turns are a proper prefix of the local ones: the browser is
 *   AHEAD — a turn's PUT failed (and was not mirrored), and a delivery then
 *   made the server copy newer. Keep the local copy (its turns exist nowhere
 *   else), fold the deliveries in and ask for a catch-up PUT, exactly the
 *   "backend is behind" healing a chat got before deliveries could bump
 *   `updatedAt`. This includes a server copy with NO turns but a delivery:
 *   the chat's first turn created the routine and its PUT failed. The same
 *   shape is also what a clear on ANOTHER device followed by a delivery
 *   leaves — `clearedElsewhere` tells the two apart through the server's
 *   `resetAt`: a reset this browser did not perform and that is not older
 *   than the local copy's last change means the clear wins (the server copy
 *   is taken, no push), so a stale device cannot resurrect cleared turns
 *   the subscription-CLI tail would replay to the model.
 * - Anything else — a turn from another device, an answer the local copy
 *   only holds partially under either id (a mid-stream reload, or a tab closed
 *   before the debounced local write caught up: the server's full answer must
 *   win), a clear or reset with nothing delivered since (no server messages at
 *   all) — is a real newer state and the server copy wins, as before #1071.
 *
 * Whenever a catch-up PUT is asked for (`pushLocal`), the TITLE stays the
 * local one: the server never received this browser's last write, so its
 * title may be the stale default ("Neuer Chat") the failed turn's PUT would
 * have replaced — and the catch-up would then persist that rollback.
 */
export function reconcileNewerRemote(
  local: ChatSession,
  remote: ChatSession,
): NewerRemoteReconciliation {
  const localTurns = turns(local);
  const remoteTurns = turns(remote);
  const matches = remoteTurns.map((r, i) => matchTurn(r, localTurns[i]));
  const isPrefix = matches.every((m) => m !== 'none');
  const matchedMirror = matches.includes('mirror');
  if (isPrefix && remoteTurns.length === localTurns.length) {
    const merged = mergeProactiveFromRemote(local, remote);
    if (matchedMirror) {
      // The local copy keeps its clock, so a failed catch-up PUT is retried
      // by the next hydration instead of looking settled.
      return { session: merged, pushLocal: true };
    }
    return {
      session: {
        ...merged,
        title: remote.title,
        // In sync: adopt the server's clock so the next load does not re-read.
        updatedAt: Math.max(merged.updatedAt, remote.updatedAt),
        ...(remote.resetAt !== undefined ? { resetAt: remote.resetAt } : {}),
      },
      pushLocal: false,
    };
  }
  const remoteHasDelivery = remote.messages.length > remoteTurns.length;
  if (
    isPrefix &&
    remoteTurns.length < localTurns.length &&
    (remoteTurns.length > 0 || (remoteHasDelivery && !clearedElsewhere(local, remote)))
  ) {
    return { session: mergeProactiveFromRemote(local, remote), pushLocal: true };
  }
  if (remoteTurns.length === 0 && localTurns.length > 0) {
    console.warn(
      `[chat-sessions] server copy of ${local.id} holds no turns; replacing ${String(localTurns.length)} local turn(s) with it`,
    );
  }
  return { session: remote, pushLocal: false };
}

/**
 * The server copy was cleared by a reset this browser did not perform and
 * that happened after the local copy's last change — the local turns
 * predate the clear. A reset this browser performed (it remembers the
 * server's `resetAt`), no reset at all, or one older than the local copy's
 * last change (a turn after the clear whose PUT failed) is not.
 *
 * `resetAt` is the server's clock and `updatedAt` this browser's, so the
 * comparison is only as good as the two clocks agree — it decides only
 * between two devices, where a reset and the other device's last change are
 * normally minutes apart; the same-device case never depends on it.
 */
function clearedElsewhere(local: ChatSession, remote: ChatSession): boolean {
  if (remote.resetAt === undefined) return false;
  if (remote.resetAt === local.resetAt) return false;
  return remote.resetAt >= local.updatedAt;
}

function turns(session: ChatSession): Message[] {
  return session.messages.filter((m) => m.proactive === undefined);
}

type TurnMatch = 'id' | 'mirror' | 'none';

function matchTurn(remote: Message, local: Message | undefined): TurnMatch {
  if (local === undefined) return 'none';
  // Equal ids are not enough: a tab closed right after a turn's PUT can leave
  // a truncated copy of that same message in localStorage (the debounced
  // write lags the stream). The newer server copy must then win, as on main.
  if (remote.id === local.id) return sameContent(remote, local) ? 'id' : 'none';
  return isMirroredTurn(remote) && sameFinishedTurn(remote, local) ? 'mirror' : 'none';
}

/** The local message is finished and says what the server copy says. */
function sameContent(remote: Message, local: Message): boolean {
  return local.streaming !== true && remote.content.trim() === local.content.trim();
}

/** Ids the SessionLogger mirror (`ChatSessionStore.appendTurnUnlocked`)
 *  gives a turn it writes; a client PUT replaces them with the client's. */
const MIRRORED_TURN_ID = /^srv-[ua]-/;

function isMirroredTurn(m: Message): boolean {
  return MIRRORED_TURN_ID.test(m.id);
}

/** A mirrored remote turn stands for the local message at the same position
 *  only when that message is finished and says the same thing — a still
 *  streaming, errored or partial local answer is not the mirrored one. */
function sameFinishedTurn(remote: Message, local: Message): boolean {
  return remote.role === local.role && local.error !== true && sameContent(remote, local);
}

/**
 * #1071 — a chat holding only routine deliveries has no conversation yet
 * (the rule `buildOrchestrator` applies server-side): its first real turn
 * still names the chat and ships the selected agent.
 */
export function hasNoTurns(messages: readonly Message[]): boolean {
  return messages.every((m) => m.proactive !== undefined);
}
