# 0182 — Web chat, web routines and Public API turns carry an origin built from the account or API key

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Owner decision of 2026-11-24 ("private knowledge always stays private",
  ADR-0040), applied by recommendation in #1774 and #1826 (wave 5, W01); reversible.
- **Refines:** [ADR-0145](0145-turn-origin-states-where-a-turn-came-from.md) ("HTTP routes state no
  origin").

## Context and Problem Statement

ADR-0145 kept `/api/chat` and the Public API without a `TurnOrigin`: their scope labels are
chosen by the caller, and a memory partition named by them would let a client name another
caller's tier. As a consequence every web chat account, every web routine and every API key of
an agent shared one tree, `/memories/orchestrators/<slug>/`, in every context-memory mode: what
account A asked the agent to remember, account B's chat and routines read back, and two API
keys read each other's notes. The memory tab promised separation those turns never got. The
ADR named the way out: an origin resolved from the authenticated principal. Where does it come
from, and what does it map to?

## Decision Drivers

- The partition must come from authentication, never from a caller-chosen label.
- A web chat and an API key's conversation are one-person rooms (spec 2042 §5.11, ADR-0016:
  an API key is its own principal).
- No new memory machinery: reuse the `user` axis and the `members` audience.
- `off` stays what ADR-0116 says it is: one agent-wide tree.

## Considered Options

- **A — A personal-scope origin from the session's canonical user id (web) or the key id (API).**
- **B — Derive the partition from the conversation id** (the ADR-0145 risk).
- **C — A per-account namespacer segment under the agent tree**, independent of the modes.

## Decision Outcome

Chosen option: **A**.

- **Web chat** (`POST /api/chat`, `/api/chat/stream`): `webAccountOrigin(omadiaUserId)` =
  `{ channelType: 'http', scope: { kind: 'personal', userId }, conversationType: 'direct' }`,
  built only from `req.session.omadia_user_id` (`webTurnOrigin`, `routes/chat.ts`); without such
  a session the turn stays context-free. The scope, `sessionId` and `x-user-id` never feed it.
- **Web routines** (`channel = 'web'`): the same origin from `routine.userId`, which the web
  chat stamped from the same session (`routineOrigin`, `routineRunner.ts`). Routines of other
  channels keep running without an origin.
- **Public API**: `apiKeyOrigin(keyId)` = `{ channelType: 'api', scope: { kind: 'personal',
  userId: 'key:<keyId>' }, conversationType: 'direct' }` on `metadata.origin`, never from the
  caller-supplied `conversationId`.
- **Mapping.** `enforce` / `enforce-strict` give each account and each key its own `user` tier;
  `members` gives a one-person audience. A web turn's audience is the session's canonical id
  itself (`isWebAccountTurn` in `turnAudience.ts`, no identity lookup); an API key resolves
  through the `api` channel identity like any channel user.
- **Mode texts and audit.** The memory tab says what each mode does for web accounts and API
  keys; the `[security-audit]` line of `effectiveMemoryScope` names the mode that is set.

### Consequences

- 🟢 **Good:** With any mode but `off`, account B's chats and routines and key B's turns no
  longer read what A stored; the graph boundary of those turns follows the mode as for every
  channel turn (ADR-0040).
- 🔴 **Bad (behaviour change):** Web chat and API turns on `enforce-strict` / `members` agents
  no longer read notes in the agent tree written before this change (as ADR-0116 already
  describes for switching modes); on `enforce` they stay readable, read-only.
- 🔴 **Bad:** `off` agents still share one tree across accounts and keys (ADR-0116). Agents
  created before migration 0099 are `off` until an operator switches them; the mode text now
  says so.
- **Reserved origin types.** `readTurnOrigin` (`orchestratorDispatcher.ts`) drops an origin a
  channel plugin states with `channelType` `http` (the web account room counts its user id as
  canonical without an identity lookup), and accepts `api` only from the Public API channel
  (`@omadia/channel-api`). The turn then runs context-free and a `[security-audit]` line is
  logged.
- ⚪ **Neutral:** The Public API channel plugin is trusted to name the key it authenticated,
  as every channel plugin is trusted for its own origin (ADR-0145).

## Pros and Cons of the Options

### A — Personal origin from the authenticated identity

- 🟢 Reuses the axis, binder, audience and graph boundary; one line per producer.
- 🔴 Does nothing for `off`.

### B — From the conversation id

- 🟢 Separates conversations too.
- 🔴 Caller-chosen; rejected in ADR-0145 for good reason.

### C — Per-account segment under the agent tree

- 🟢 Works in `off` too.
- 🔴 A second partitioning scheme beside the modes; contradicts ADR-0116's `off`.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/webAccountOrigin.ts`, `turnAudience.ts`,
  `middleware/src/routes/chat.ts`, `middleware/src/plugins/routines/routineRunner.ts`,
  `middleware/packages/harness-channel-api/src/{channelKey,chatRouter}.ts`,
  `registry/scopedMemoryStore.ts`; texts `web-ui/messages/{en,de}.json` (`contextMemory`).
- Related: ADR-0016, ADR-0019, ADR-0040, ADR-0116, ADR-0145,
  [ADR-0180](0180-web-chats-belong-to-the-creating-account.md).
