# 0321 — Routine deliveries reach an open web chat as a signal on a per-chat event stream

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 7, W43; #2354; decision after recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

A routine delivers into a web chat by appending a `proactive` message to the chat document on the
server (`webChatProactiveSender`, [ADR-0244](0244-routine-deliveries-are-context-of-their-chat.md)).
The web UI learned about it only when it re-read the chat: on mount, chat switch, focus,
visibility and a 60-second poll (#1755). In the wave 6 live check a delivery into the chat that
was open did not appear until the page was reloaded (#2354). The web chat had no realtime channel:
turns stream over the request that started them (NDJSON,
[ADR-0146](0146-web-chat-is-a-kernel-route-with-ndjson-and-pinned-sessions.md)), the WebSocket
registry belongs to channel plugins, and SSE was used only by the builder. How does a delivery reach
an open chat at once?

## Decision Drivers

- The delivery should show within a second, like a turn.
- The owner rule of chats ([ADR-0180](0180-web-chats-belong-to-the-creating-account.md),
  `chatSessionOwnedBy`) must hold for the new path as for `GET /sessions/:id`.
- A stream must end with the session that opened it (the builder stream's rule).
- No second copy of the delivery text on a new wire.

## Considered Options

- **A — Per-chat SSE stream of signals; the browser re-reads the chat through the existing GET**
- **B — Per-chat SSE stream that carries the delivered message**
- **C — Shorter poll (e.g. 5 s)**
- **D — A WebSocket for the web chat**

## Decision Outcome

Chosen option: **A**.

- `GET /api/chat/sessions/:id/events` (`chatSessions.ts`, `chatDeliveryEvents.ts`) opens a
  server-sent-events stream only for the caller's own chat; another account's or a missing chat
  answers `404`, a request without a bindable session `401`. The stream is bound to the session
  with `watchStreamSession` (expiry, revocation, a session check per heartbeat, 25 s).
- The web sender calls `onDelivered(sessionId, deliveredAt)` after the delivery is stored; the
  kernel publishes it on the process-local `ChatDeliveryBus`. A failing signal is logged and never
  fails the delivery.
- The event is `event: delivery` with `{ type: 'delivery', sessionId, deliveredAt }` — no text,
  no routine name. The web UI keeps one `EventSource` for the active chat
  (`useProactiveRefresh`) and calls `refreshProactive`, which reads the chat through
  `GET /api/chat/sessions/:id` and folds the delivery in additively, as before.
- The 60-second poll, focus and visibility re-reads stay as the fallback.

### Consequences

- 🟢 **Good:** a delivery into the open chat shows at once; one read path keeps the owner check
  and the stored shape.
- 🟢 **Good:** no delivery text on a second wire; the signal leaks only that something landed in
  the caller's own chat.
- 🔴 **Bad:** one more long-lived connection per open chat tab (through the Next proxy).
- 🔴 **Bad:** the bus is process-local; with several middleware processes a delivery written by
  another process reaches the browser through the poll only.
- ⚪ **Neutral:** while a turn streams in that chat the fold is skipped (unchanged rule); the
  delivery appears with the next re-read.

## Pros and Cons of the Options

### A — signal + re-read

- 🟢 Reuses the owner-checked read and the additive fold.
- 🔴 One extra GET per delivery.

### B — message on the stream

- 🟢 No extra GET.
- 🔴 A second shape of the stored message on a new wire; the fold, clear-epoch and receipt rules
  would need a second input.

### C — shorter poll

- 🟢 No new route.
- 🔴 Not live; a GET every few seconds per open tab for an event that happens a few times a day.

### D — WebSocket

- 🟢 Bidirectional.
- 🔴 Next route handlers cannot upgrade; would need a relay like the canvas socket. Nothing needs
  the back channel.

## More Information

Issue #2354; `middleware/src/routes/{chatDeliveryEvents,chatSessions,builderEventsSession}.ts`,
`middleware/src/plugins/routines/webChatProactiveSender.ts`,
`web-ui/app/_lib/chatProactiveRefresh.ts`; tests `middleware/test/chatDeliveryEvents.test.ts`,
`web-ui/app/_lib/__tests__/chatSessions.proactiveRefresh.test.ts`.
