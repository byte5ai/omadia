# 0323 — Deleting a web chat or a routine purges its conversation history in the graph

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 7, W43; #1753 rest; decision after recommendation, reversible)
- **Supersedes:** [ADR-0244](0244-routine-deliveries-are-context-of-their-chat.md) in part: "Graph
  nodes of the conversation stay (not this decision's purge)"

## Context and Problem Statement

Since ADR-0244, deleting a web chat or a routine removes its markdown transcripts. Its turns stay
in the knowledge graph: `Turn`, `Run`, tool calls, plans, `Fact`s and the `Session` of the
conversation scope, under every agent that answered there. Recall and the graph context of later
turns can still surface content from a chat or routine the user deleted (#1753). The Danger-Zone
purge ([ADR-0120](0120-memory-purge-is-complete-previewed-and-audited.md)) can remove conversation
history by agent or user, not by conversation. What does a deletion take from the graph?

## Decision Drivers

- A deleted conversation should not come back through recall.
- One selection rule for conversation history (ADR-0120): no second, diverging delete.
- Shared nodes (users, channel identities, business entities) and memorable knowledge are not the
  conversation's.
- The deletion is the owner's own action on their own chat or routine, not an operator erasure.

## Considered Options

- **A — Add a conversation filter to `purgeConversationHistory` and run it after the transcripts
  on chat and routine deletion**
- **B — A separate delete-by-scope in each graph backend**
- **C — Keep the graph nodes; hide deleted scopes in recall**

## Decision Outcome

Chosen option: **A**.

- `ConversationHistoryPurgeFilter.conversationScopes` (plugin-api 1.113.0, additive): unqualified
  graph scope keys; a node matches its bare key or `<any agent>::<key>`
  (`matchesConversationScope`; keys never contain `:`). It combines with the other filters and runs
  through the same selection as the Danger-Zone purge (one CTE in Neon, the mirrored rules in
  memory): Turns, Runs, invocations, tool calls, plans and steps, Facts derived only from those
  turns, and the Session once it has no turn left.
- `graphScopeKeysFor(rawScope)` (`@omadia/orchestrator`) yields both key forms a conversation may
  carry (sanitized and injective, since the flag that picks one can change).
- The kernel's `purgeConversationRecords` deletes the transcripts first (the backfill would replay
  them), then the graph history. It runs where the transcripts were already removed: `DELETE
  /api/chat/sessions/:id` for an existing web chat, and routine deletion (`routine:<id>`). A graph
  without the purge is logged, never thrown; a failing purge is logged by the caller and does not
  undo the deletion.
- `MemorableKnowledge` is not touched: promoted knowledge has its own owners and lifecycle.
- **Owner bound for chats.** A web chat id is chosen by the client. The route admits only the
  web chat shapes (`isWebChatSessionId`: UUID or `id-<base36>-<base36>`), and the graph purge of a
  chat also carries the deleting person's omadia user id as `userId`: only their turns of that key
  go (web turns store that id), so a key that collides with another conversation never removes
  someone else's history. Without an omadia user id on the session the graph is left alone. A
  routine's scope (`routine:<id>`) is minted by the server and is purged without an owner.
- **Case-folding guard.** Transcript directories and the sanitized key fold case, chat ids are
  stored case-sensitively. A scope with upper-case letters is purged only by its injective key and
  keeps its transcript directory, so a chat id that is the upper-case form of another chat's id
  never reaches that chat's history. A failing graph purge is logged inside
  `purgeConversationRecords`, so the `chat.delete` audit's `transcriptsPurged` stays true.
- The Neon match is `scope = ANY(keys) OR substring(scope from '::([^:]*)$') = ANY(keys)`.

### Consequences

- 🟢 **Good:** content of a deleted chat or routine no longer reaches recall through its turns.
- 🟢 **Good:** one selection rule for every conversation-history delete.
- 🔴 **Bad:** irreversible, without a preview: the chat or routine deletion is the confirmation.
  The `chat.delete` audit row (ADR-0100) records the deletion, not a node count.
- 🔴 **Bad:** memorable knowledge promoted from the conversation stays.
- 🔴 **Bad:** in a web chat, turns stored without the owner's omadia user id (older turns, a
  session without that claim) stay in the graph.
- 🔴 **Bad:** the match cannot use an index on `scope`; the selection scans the tenant's
  conversation nodes inside the delete request.
- ⚪ **Neutral:** a channel chat has no delete; this applies to web chats and routines only.

## Pros and Cons of the Options

### A — conversation filter on the existing purge

- 🟢 Reuses the ADR-0120 selection and its tests.
- 🔴 One more filter on a contract method.

### B — separate delete-by-scope

- 🟢 Narrow.
- 🔴 A second selection that can drift from the Danger-Zone purge.

### C — hide in recall

- 🟢 Reversible.
- 🔴 The data stays; every read path needs the filter (ADR-0120 rejected soft delete for this).

## More Information

Issue #1753; `middleware/packages/plugin-api/src/knowledgeGraph.ts`,
`harness-knowledge-graph-{neon,inmemory}`, `harness-orchestrator/src/sessionLogger.ts`
(`graphScopeKeysFor`), `middleware/src/plugins/routines/sessionTranscripts.ts`; tests
`middleware/test/conversationPurgeOnDelete.test.ts`, `memoryPurgeKg.pg.test.ts`.
