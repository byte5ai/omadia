# 0146 — The web chat is a kernel HTTP route: NDJSON stream, session pinned to one agent, identity from the session only

## Status

Accepted — refined by [ADR-0180](0180-web-chats-belong-to-the-creating-account.md) (a chat belongs to the account that created it) and
[ADR-0182](0182-web-and-api-turns-carry-an-account-or-key-origin.md) (the route builds a `TurnOrigin` from the session's account)

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively); agent routing per
  `specs/002-chat-routes-via-registry/spec.md` (Phase A) and #2055; server-written messages
  #1071
- **Supersedes:** —

## Context and Problem Statement

The operator web UI chats through `/api/chat` and `/api/chat/stream`, and stores its chat tabs
through `/api/chat/sessions`. Unlike Teams or Telegram this surface is not a channel plugin: it
is kernel code behind the operator session. Several decisions accumulated there: the streaming
format, which agent a tab talks to, whose identity a turn carries, and what counts as a web
chat session at all. This record is retroactive. What are the rules of the kernel's own chat
surface?

## Decision Drivers

- A browser reads the stream with plain `fetch` and a `ReadableStream`; reverse proxies sit in
  between.
- Every turn is served by an agent chosen explicitly or by the platform default, never by an
  unscoped legacy bundle (spec 002).
- Identity must not come from anything the client can set.
- The chat list shows chats a person had in the web UI, nothing else.

## Considered Options

- **A — Kernel routes with NDJSON framing, a per-session agent pin, session-derived identity
  and server-held session documents.**
- **B — Server-Sent Events** for the stream.
- **C — Make the web chat a channel plugin** over `CoreApi.handleTurnStream`.

## Decision Outcome

Chosen option: **A** (`middleware/src/routes/chat.ts`, `middleware/src/routes/chatSessions.ts`).

- **NDJSON, not SSE.** `/chat/stream` answers `application/x-ndjson`, one JSON event per line,
  with `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. The route comment
  gives the reason: easier to parse than SSE, works with fetch plus `ReadableStream`, survives
  any proxy that handles chunked responses. A heartbeat every `CHAT_HEARTBEAT_INTERVAL_MS`
  (2 s) keeps liveness thresholds shared with the Builder stream. The public API channel uses
  the same framing ([ADR-0141](0141-public-api-channel-with-scoped-api-keys.md)).
- **A session is pinned to one agent.** The first turn captures a snapshot with the agent
  slug; later turns reuse it. A request naming a different slug gets `409 agent_mismatch`.
  `/agent …` typed in the chat is handled by the management layer, never as an agent turn, and
  releases the pin (#2055). `POST /api/chat/sessions/:id/re-snapshot` drops it.
- **Identity is the session's.** `mcpUserKey` and the routines principal come from the
  server-side session, not from `resolveUserId`, which falls through to the client-sent
  `x-user-id` header. Without a resolvable identity they stay unset; there is no substitute.
- **No memory context.** The route builds no `TurnOrigin`
  ([ADR-0145](0145-turn-origin-states-where-a-turn-came-from.md)).
- **The channel type is `web`** (`WEB_CHANNEL_TYPE`), backed by the web chat's own proactive
  sender so a routine created in a chat delivers into that chat (#1071).
- **Session documents are server-held and merged.** `PUT /api/chat/sessions/:id` merges and
  keeps server-written proactive messages the body lacks; an empty `messages` array is not a
  clear. The explicit clear is `POST …/reset`, which stamps a server-owned `resetAt`.
- **Only web chats are web chat sessions.** Transcripts the session logger mirrored for canvas,
  routine or other channel scopes are not listed. `isServerMirroredSession` is deliberately
  narrow (a non-web id and every message id prefixed `srv-`); such documents are purged on
  list, never created by the mirror, and a client that pushes one back is refused
  (`ServerMirroredSessionError`).

### Consequences

- 🟢 **Good:** One framing for browser, CLI and API clients; no SSE reconnection semantics to
  maintain.
- 🟢 **Good:** A forged `x-user-id` cannot reach another user's MCP tokens or routines.
- 🔴 **Bad:** The web chat does not pass through `CoreApi.handleTurnStream`, so behaviour added
  there has to be produced a second time in the route (the route comments name #1086 for the
  routines principal).
- 🔴 **Bad:** NDJSON has no built-in resume; a dropped connection loses the live preview and
  the client reloads the stored session.
- 🔴 **Bad:** A pinned session whose agent is deleted surfaces `agent_unavailable` instead of
  falling back (spec 002 FR-A6); the user re-snapshots or drops the session.
- ⚪ **Neutral:** `scope` and `sessionId` in the request stay transcript-bucketing labels.

## Pros and Cons of the Options

### A — Kernel routes, NDJSON, pin, session identity

- 🟢 Simple client, explicit agent, no client-controlled identity.
- 🔴 A second turn entry point next to the channel contract.

### B — SSE

- 🟢 Native `EventSource`, automatic reconnect.
- 🔴 `EventSource` cannot POST a body; the event framing adds parsing for no gain here.

### C — Web chat as a channel plugin

- 🟢 One turn path.
- 🔴 The route resolves a principal the core cannot (the server-side session) and owns the
  session pin; `agent_bound` is synthesized here and not by `handleTurnStream`.

## More Information

- Related: ADR-0006 (background stream surfacing in the UI), ADR-0012.
- Session store: `middleware/packages/harness-orchestrator/src/chatSessionStore.ts`.
- Tests: `middleware/test/chatRouterAgentRouting.test.ts`, `chatRouterAgentCommand.test.ts`,
  `chatSessionsPutMerge.test.ts`, `chatSessionsResetRoute.test.ts`,
  `chatSessionsServerMirrored.test.ts`.
