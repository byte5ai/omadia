# 0330 — A new web chat id must be lower case

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** W45 cluster lead (wave 8, issue #2361; decision after the recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

A web chat id is chosen by the client and checked only against `[A-Za-z0-9_-]{1,80}`. Without
a debug `scope`, the id is the turn's session scope. The transcript directory
(`sessionTranscriptDir` → `sanitizeScope`) and the default graph key (`graphScopeFor`, with
`OMADIA_INJECTIVE_SCOPE_KEYS` off, [ADR-0162](0162-scope-id-typed-session-scope.md)) both
fold that scope to `[a-z0-9_-]`. A chat `ABC` therefore shares the transcripts and the graph
partition of a chat `abc`, including another account's chat
([ADR-0180](0180-web-chats-belong-to-the-creating-account.md)): recall sees its turns, and its
transcripts land in the same files. The ownership check does not help, because a chat that is
not stored yet is allowed. How does the kernel keep a client-chosen id from landing in another
chat's partition?

## Decision Drivers

- No new chat may share a transcript directory or graph key with an existing chat through case
  folding.
- Chats that already exist with upper-case ids keep working: no data migration, no orphaned
  partitions.
- The web UI mints lower-case ids (`crypto.randomUUID()` or `id-<base36>-<base36>`), so the
  rule must cost it nothing.

## Considered Options

- **A — Refuse a new chat whose id is not lower case (400 `non_canonical_id`).** Stored chats
  keep their id.
- **B — Fold the id to lower case on PUT and on the turn routes.** The kernel stores `abc` when
  the client sent `ABC`.
- **C — Turn on injective scope keys by default.**

## Decision Outcome

Chosen option: **A**, because it closes the collision for every new chat without moving any
stored data, and the web UI already sends lower-case ids.

- `isCanonicalChatSessionId` (`@omadia/orchestrator`): the id grammar plus `id === id.toLowerCase()`.
- `ChatSessionStore.saveFromClient` throws `NonCanonicalSessionIdError` when no chat with the id
  is stored (an unreadable stored file counts as stored). `PUT /api/chat/sessions/:id` answers
  400 `non_canonical_id`.
- `chatSessionUse` (`middleware/src/routes/chatSessionAccess.ts`) replaces `mayUseChatSession`
  for turns (`/api/chat`, `/api/chat/stream`), steering and uploads: `ok`, `not_found` (another
  account's chat, 404) or `non_canonical_id` (a new id with upper case, 400).
- A stored chat with an upper-case id stays readable and writable by its owner.

### Consequences

- 🟢 **Good:** A client can no longer open a new chat in the partition of an existing one by
  changing the case of its id.
- 🟢 **Good:** No migration; stored chats and their graph partitions are untouched.
- 🔴 **Bad (accepted residual):** A new lower-case id can still fold onto a *stored* upper-case
  chat (`abc` next to a stored `ABC`). The web UI never mints upper-case ids, so such chats
  exist only where an API caller created them; finding them would need a case-insensitive scan
  per new chat.
- 🔴 **Bad (accepted residual):** A lower-case id that equals another surface's sanitized scope
  (for example a channel conversation's) still shares its graph key. Closing that needs
  injective scope keys (option C), which stays an operator opt-in under ADR-0162.
- ⚪ **Neutral:** An API caller that sent upper-case `sessionId` values without a stored chat
  now gets 400 and must send lower case. A debug `scope` is not affected.

## Pros and Cons of the Options

### A — Refuse non-lower-case new ids

- 🟢 Explicit at the boundary; the client learns its id is wrong.
- 🟢 Stored data stays where it is.
- 🔴 A breaking change for API callers that used upper-case ids without a stored chat.

### B — Fold to lower case

- 🟢 Nothing is refused.
- 🔴 The stored id differs from the one the client holds; the next GET or PUT by the client's
  id misses, and an upper-case id of an existing chat would be redirected into the lower-case
  one, which is the collision itself.

### C — Injective scope keys by default

- 🟢 Closes every folding collision, not only case.
- 🔴 Switching orphans every existing partition (ADR-0162); needs a migration of graph keys and
  transcript directories.

## More Information

- Issue #2361 (found in the wave 7 lander review of #2360).
- Tests: `middleware/test/chatSessionCanonicalId.test.ts`.
- Related: [ADR-0162](0162-scope-id-typed-session-scope.md),
  [ADR-0180](0180-web-chats-belong-to-the-creating-account.md),
  [ADR-0323](0323-deleting-a-chat-or-routine-purges-its-graph-history.md).
