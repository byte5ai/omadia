import type { ChatMessage, ChatSession } from './chatSessionStore.js';

/**
 * #1071 — reconcile a client's whole-document PUT with the server copy.
 *
 * The web UI hydrates once per page load and PUTs the ENTIRE session after
 * every turn, so a message the server appended in between (a routine's
 * proactive delivery) would be overwritten by the next PUT from any open tab.
 * This keeps every server-written proactive message the incoming document
 * lacks, and strips the marker from any incoming message the server did not
 * write — the marker is trusted only from the server's own copy.
 *
 * Placement: before the first incoming USER message that started after the
 * delivery, else at the end. Inserting before a user message never splits a
 * user/answer pair.
 *
 * An empty `messages` array is NOT a clear. It is also what a rename of a
 * cleared chat, a stale tab's catch-up or a brand-new chat PUTs, and reading
 * it as "clear" silently dropped deliveries the client never saw. Clearing a
 * chat is explicit: `POST /sessions/:id/reset` (`resetMessages`).
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
  const messages = incoming.messages.map((m): ChatMessage => {
    const server = serverProactive.get(m.id);
    // Keep the server's own marker on a delivery the client round-tripped.
    if (server?.proactive) return { ...m, proactive: server.proactive };
    if (!m.proactive) return m;
    const { proactive: _forged, ...rest } = m;
    return rest;
  });

  const incomingIds = new Set(messages.map((m) => m.id));
  const missing = [...serverProactive.values()].filter((m) => !incomingIds.has(m.id));
  if (missing.length === 0 || !existing) return { ...incoming, messages };

  for (const m of missing) {
    const at = messages.findIndex((x) => x.role === 'user' && x.startedAt > m.startedAt);
    if (at === -1) messages.push(m);
    else messages.splice(at, 0, m);
  }
  return {
    ...incoming,
    messages,
    updatedAt: Math.max(incoming.updatedAt, existing.updatedAt, now),
  };
}
