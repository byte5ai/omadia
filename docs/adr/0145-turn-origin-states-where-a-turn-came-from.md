# 0145 — The channel states where a turn came from; the kernel validates it and an unknown origin reaches no context memory

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; chat-context memory ACL in #881 (epic #860 wave W5, design
  issue #870), fields for native facilitators added in #2092
- **Supersedes:** —

## Context and Problem Statement

Agent memory was isolated per agent but not per chat context: what an agent learned in Teams
team A landed in the agent-wide tree and could be quoted in team B. Closing that needs a typed
statement of where a turn came from. The session scope string could not serve: producers spell
it differently, and the HTTP routes accept one from the caller. This record is retroactive.
Where does that statement live, who may make it, and what happens when it is missing or
malformed? (Border: memory.)

## Decision Drivers

- One contract for every channel; no channel-specific injection point.
- No flag day: channel plugins are versioned independently of the kernel.
- A mapping bug must fail towards less memory, never towards another context's memory.
- A caller-chosen label must never name a memory partition.

## Considered Options

- **A — An optional `TurnOrigin` on `ChatTurnInput`, built by the channel adapter, validated by
  the kernel, mapped by a pure function that fails closed.**
- **B — Derive the context from the session scope string.**
- **C — Let the model or a tool argument name the context.**

## Decision Outcome

Chosen option: **A**.

- **The type.** `TurnOrigin` carries `channelType`, the `ScopeId` of the conversation, an
  optional `container` (`team` or `tenant`), the speaking `principal`, and since #2092 what the
  platform states about the turn: `conversationType`, `channelConversationId`, `messageId`,
  `replyToMessageId` (`middleware/packages/harness-channel-sdk/src/turnOrigin.ts`). The ids are
  opaque to the kernel: never parsed, trimmed or re-cased.
- **Optional, and absence is safe.** A plugin that sends no origin resolves to
  `CONTEXT_FREE_MEMORY_AXES`: the agent-private tier and no context tree, which is what every
  turn had before.
- **A pure mapping.** `memoryAxesForOrigin` translates the origin into the tiers `team`,
  `channel` and `user`. It decides nothing about enforcement; `ScopedMemoryStore` stays the
  backstop. Only channel types in `CONTEXT_MEMORY_CHANNEL_TYPES` get context tiers; adding one
  is a one-line, reviewable change.
- **Keys are injective.** Context keys are built from a JSON tuple of the scope parts, not from
  the formatted session scope, because two structurally different chats can format to the same
  string. A blank identity yields no key instead of a shared bucket.
- **A trust boundary at intake.** `readTurnOrigin` in
  `middleware/src/channels/orchestratorDispatcher.ts` checks the shape of an origin that
  arrives from a plugin. A malformed origin becomes `undefined` (context-free), never a
  partially filled object; an unknown container kind is dropped while the conversation tier is
  kept.
- **HTTP routes state no origin.** `/api/chat` never builds a `TurnOrigin`
  (`middleware/src/routes/chat.ts`): its scope, `sessionId` and `'http-default'` are
  transcript labels supplied by the caller, and deriving a partition from them would let any
  client name another caller's tier.

### Consequences

- 🟢 **Good:** The security decision is testable as a table (`memoryAxesForOrigin.test.ts`).
- 🟢 **Good:** Old channel plugins keep working unchanged.
- 🔴 **Bad:** The kernel trusts an installed channel plugin's statement about container and
  conversation; a plugin that states a wrong team reaches that team's tier.
- 🔴 **Bad:** The web chat and API callers get no team or channel memory until a tenant
  identity is resolved from the authenticated principal and passed as an explicit origin.
- ⚪ **Neutral:** `scope` and `principal` are validated only as "is an object" at intake; the
  mapping's default branch handles unknown kinds.

## Pros and Cons of the Options

### A — Typed origin, validated, fail-closed mapping

- 🟢 One place, pure, additive.
- 🔴 Every channel adapter has to build it to get context memory.

### B — Derive from the session scope string

- 🟢 No contract change.
- 🔴 Shared buckets (`'http-default'`, `'teams-unknown'`) and caller-chosen scopes become
  memory partitions.

### C — Model- or tool-named context

- 🟢 Flexible.
- 🔴 A model argument would decide which memory a turn can read.

## More Information

- Related: ADR-0032 (tool caller principal), ADR-0030 (`replyToMessageId`), ADR-0039, ADR-0040;
  `specs/575-scope-and-identity-foundation/spec.md` (`ScopeId`).
- Rollout switch: `agents.context_memory` (migration `0050`, default `off`), see
  `docs/teams-multi-agent-identities.md` §2.2.
- Tests: `middleware/test/memoryAxesForOrigin.test.ts`.
