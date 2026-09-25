import type { ChatMessage, ChatSession } from './chatSessionStore.js';

/**
 * #1071 — reconcile a client's whole-document PUT with the server copy.
 *
 * The web UI hydrates once per page load and PUTs the ENTIRE session after
 * every turn, so a message the server appended in between (a routine's
 * proactive delivery) would be overwritten by the next PUT from any open tab.
 * This keeps every server-written proactive message the incoming document
 * lacks, and DROPS any incoming message carrying a marker the server copy
 * does not hold — the marker is trusted only from the server's own copy.
 *
 * Dropping (not keeping it as a plain assistant turn) matters: such a
 * message is a delivery the server no longer has — the chat was reset or
 * deleted on another device, or the client forged it. Kept as a plain turn
 * it would outlive the clear it predates, reach the model's replayed tail
 * (`chatSessionTailTurns` skips only marked messages) and count as a turn
 * the browser's copy does not have, so the next hydration would replace
 * that copy wholesale and lose its client-only fields.
 *
 * Placement: before the first incoming USER message that started after the
 * delivery, else at the end. Inserting before a user message never splits a
 * user/answer pair.
 *
 * An empty `messages` array is NOT a clear. It is also what a rename of a
 * cleared chat, a stale tab's catch-up or a brand-new chat PUTs, and reading
 * it as "clear" silently dropped deliveries the client never saw. Clearing a
 * chat is explicit: `POST /sessions/:id/reset` (`resetMessages`).
 *
 * `resetAt` is server-owned: the stored value is carried over, whatever the
 * incoming document says.
 */
export function mergeServerProactiveMessages(
  existing: ChatSession | null,
  incoming: ChatSession,
  now: number = Date.now(),
): ChatSession {
  const serverProactive = new Map<string, ChatMessage>();
  for (const m of existing?.messages ?? []) {
    if (m.proactive) serverProactive.set(m.id, m);
  }
  let dropped = 0;
  const messages: ChatMessage[] = [];
  for (const m of incoming.messages) {
    const server = serverProactive.get(m.id);
    // Keep the server's own marker on a delivery the client round-tripped.
    if (server?.proactive) {
      messages.push({ ...m, proactive: server.proactive });
    } else if (m.proactive) {
      dropped += 1;
    } else {
      messages.push(m);
    }
  }
  if (dropped > 0) {
    console.warn(
      `[chat-sessions] ${incoming.id}: dropped ${String(dropped)} proactive message(s) the stored copy does not hold`,
    );
  }

  const { resetAt: _clientResetAt, ...incomingRest } = incoming;
  const base: ChatSession = {
    ...incomingRest,
    ...(existing?.resetAt !== undefined ? { resetAt: existing.resetAt } : {}),
  };
  const incomingIds = new Set(messages.map((m) => m.id));
  const missing = [...serverProactive.values()].filter((m) => !incomingIds.has(m.id));
  if (missing.length === 0 || !existing) return { ...base, messages };

  for (const m of missing) {
    const at = messages.findIndex((x) => x.role === 'user' && x.startedAt > m.startedAt);
    if (at === -1) messages.push(m);
    else messages.splice(at, 0, m);
  }
  return {
    ...base,
    messages,
    updatedAt: Math.max(incoming.updatedAt, existing.updatedAt, now),
  };
}
