# 0180 — A web chat belongs to the account that created it; legacy chats go to the only account or to nobody

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Owner decision of 2026-11-24 ("private knowledge always stays private",
  ADR-0040), applied by recommendation in #1762 (wave 5, W01); reversible.
- **Supersedes:** —

## Context and Problem Statement

Web chat tabs are JSON documents under `/memories/chat-sessions/` (`ChatSessionStore`). They
carried no owner, and the routes under `/api/chat/sessions` only required a login: every
account listed, read, overwrote, reset and deleted every other account's chats, routine
deliveries included, and a chat turn could name another account's `sessionId` and get its tail
replayed to the model. Chats written before an owner existed have no record of who wrote them.
Who may use a chat, and what happens to the existing ones?

## Decision Drivers

- Private knowledge always stays private (ADR-0040); spec 2042 §5.11 / ADR-0019: a message
  reaches only readers who may know it.
- The owner must come from the authenticated session, never from the request body or a header.
- No flag day: a one-person instance must keep its history.
- A rule that cannot tell who wrote a legacy chat must not show it to everyone.

## Considered Options

- **A — Owner stamped on first save; legacy chats belong to the instance's only account,
  otherwise to nobody.**
- **B — Owner stamped on first save; legacy chats stay visible to every account until someone
  writes them.**
- **C — Attribute legacy chats from the knowledge graph** (the users who sent turns in the
  session's graph scope).
- **D — Keep chats shared** and document it (the issue's option B).

## Decision Outcome

Chosen option: **A**.

- **Owner.** `ChatSession.ownerUserId` is the session's `sub` (`users.id`). The server stamps
  it on the first PUT; a body cannot set or change it (`mergeServerProactiveMessages` drops a
  client value) and GET does not return it.
- **Every route checks it.** List shows only own chats; GET, PUT, DELETE, reset and
  re-snapshot of another account's chat answer `404 not_found`, like a missing one. A request
  without an account saves nothing (`401 no_account`) and lists nothing.
- **Turns.** `POST /api/chat`, `/api/chat/stream` and `/api/chat/steer` with another
  account's `sessionId` answer 404 before any agent resolves, so its tail, pinned agent and
  appended turns stay with the owner (`mayUseChatSession`, `routes/chatSessionAccess.ts`). A
  `sessionId` not stored yet is allowed: the web client saves it on create.
- **Routine deliveries.** A web routine is created inside a turn of the chat it delivers into,
  which passed the check above, and an owner never changes; so a delivery reaches only the
  owner's chat. Kernel callers (force-invalidate) keep the unfiltered `list()`.
- **Legacy chats.** A chat without `ownerUserId` belongs to the instance's only account
  (`soleAccountLegacyOwner`, cached 30 s); with two or more accounts, or when the users table
  cannot be read, it belongs to nobody and is hidden, not deleted. Writing it stamps the
  resolved owner, so it stays that account's when a second account appears.

### Consequences

- 🟢 **Good:** An account sees and changes only its own chats; the canary HTTP sweep asserts
  it (`canaryHttp.test.ts`, the `#1762` todo is gone).
- 🟢 **Good:** Single-account instances lose nothing.
- 🔴 **Bad:** On an instance that already has several accounts, chats written before this
  change are hidden from everyone. They stay on disk under `/memories/chat-sessions/`;
  re-assigning them is an operator act outside the API.
- 🔴 **Bad:** The browser's localStorage cache is per browser, not per account: two accounts
  sharing one browser profile still see each other's cached tabs locally until the cache is
  cleared; the server refuses every write to them.
- ⚪ **Neutral:** Deleting an account leaves its chats on disk, owned by an id no one signs in
  with, so they are hidden.

## Pros and Cons of the Options

### A — Stamp, sole-account legacy rule

- 🟢 Fails closed; no migration job.
- 🔴 Multi-account instances lose sight of old chats.

### B — Legacy chats stay shared until written

- 🟢 No one loses history.
- 🔴 The leak stays open for every old chat, and the first writer would take it over.

### C — Attribute from the graph

- 🟢 Accurate where turns were recorded.
- 🔴 The graph keys turns by the knowledge-graph user id, not `users.id`, and drops
  insignificant turns; a wrong attribution hands a chat to the wrong person.

### D — Shared by design

- 🟢 No code.
- 🔴 Contradicts the owner decision of 2026-11-24.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/chatSessionStore.ts`
  (`ownerUserId`, `chatSessionOwnedBy`), `middleware/src/routes/chatSessions.ts`,
  `middleware/src/routes/chatSessionAccess.ts`, `middleware/src/routes/chat.ts`.
- Tests: `middleware/test/chatSessionsOwner.test.ts`, `middleware/test/memoryAccess/canaryHttp.test.ts`.
- Related: ADR-0019, ADR-0039, ADR-0040, ADR-0116.
