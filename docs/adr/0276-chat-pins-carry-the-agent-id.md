# 0276 — A web chat's agent pin carries the agent id; a pin whose slug now names another agent is refused

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 6, W34; #2314; decision after recommendation, reversible)
- **Supersedes:** —  (closes the first residual listed in [ADR-0218](0218-slug-keyed-agent-state-moves-under-the-tombstone-on-delete.md))

## Context and Problem Statement

A web chat pins its agent on the first turn (`SessionConfigSnapshot.agentSlug`); later turns
send no slug and the server routes by the pin. Deleting an agent frees its slug (ADR-0218).
When a new agent takes the slug, an open tab of the deleted agent's chat — kept in the
browser's local storage — reached the new agent with the old transcript, and the header
showed the new agent's name as if nothing had changed. How does the chat notice that its
agent is gone?

## Decision Drivers

- The new agent must never answer in a conversation it did not start.
- The user must see why the chat stopped and how to go on.
- Old pins (no id) and API clients must keep working.

## Considered Options

- **A — Pin the agent id too; refuse a turn whose pinned id differs from the live agent's
  id for that slug with `503 agent_unavailable`, `reason: 'agent_deleted'`**
- **B — Clear every pin of a slug when its agent is deleted** (the chat documents are in the
  memory store, keyed by chat, not by agent: a full scan per delete)
- **C — Client-only check against the agent list** (the list has no ids; a reused slug looks
  the same)

## Decision Outcome

Chosen option: **A**.

- `SessionConfigSnapshot.agentId` is captured with the pin (`snapshotForAgent`). A client PUT
  never carries the snapshot, so it cannot drop or change it.
- `resolveAgentForRequest` (`routes/chat.ts`) compares it with the live agent's id for the
  pinned slug (`agentIdForSlug`). A mismatch answers `503 { error: 'agent_unavailable',
  reason: 'agent_deleted', slug }`; nothing runs.
- The web chat shows its recovery banner with a body for this reason; "Re-bind" drops the pin
  (local and server) and resets the picked agent, "Delete" deletes the chat.
- A pin without `agentId` (before #2314) is not checked; a slug with no live agent keeps the
  existing routing notice.

### Consequences

- 🟢 **Good:** a reused slug no longer inherits open chats of the deleted agent.
- 🔴 **Bad:** pins captured before this change stay unchecked until the chat is re-bound or
  deleted.
- ⚪ **Neutral:** the check sits in the web chat route, the only path that routes by a chat
  pin; `lookupForSession` still resolves by slug for any other caller.
- ⚪ **Neutral:** the other residuals of ADR-0218 (Quality Guard overrides, tuning state) are
  unchanged.

## More Information

`middleware/packages/harness-orchestrator/src/chatSessionStore.ts`,
`middleware/packages/harness-orchestrator/src/registry/index.ts` (`snapshotForAgent`),
`middleware/src/routes/chat.ts`, `web-ui/app/_components/AgentUnavailableBanner.tsx`,
`web-ui/app/_components/StreamRunner.tsx`.
