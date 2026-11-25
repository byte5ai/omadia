# 0126 — Agent discussions are relayed by the kernel: the transcript is the bus, the chat a projection

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; #1021 (two agents as their own Teams bots), #1026 (start
  from the chat), #1032 (any number of participants, dynamic length), #1037 (#1018 peer
  gate), #2067 (operator view) (recorded retroactively from the code on main)

## Context and Problem Statement

Two or more agents should be able to discuss a topic visibly in a group chat, each under
its own name. Three facts stood in the way: Microsoft Teams does not deliver one bot's
message to another bot; a Conductor agent step's answer stayed in the run context; and
proactive group posting was scoped to the one agent that owns the conversation's
attachment. How do agents converse in a chat, and who may make them? This record is
retroactive.

## Decision Drivers

- Every utterance appears under the speaking agent's own identity
  ([ADR-0013](0013-speaker-stamping-and-identity-guard.md)), or not at all.
- A granted plugin must not be able to post a conversation into a chat it merely knows the
  id of, or to name who opens it.
- An operator's switch must take effect at the next utterance.
- A discussion must end; cost and context must be bounded.
- A half-silent discussion is worse than one that never started.

## Considered Options

- **A — Server-side relay as a Conductor run: a `say` step publishes, `ctx.transcript`
  carries the dialogue, the floor is the run's own attachment**
- **B — Let bots listen to each other in the channel**
- **C — One agent posts every voice with a `**Speaker:**` prefix**

## Decision Outcome

Chosen option: **A**.

- **`Step.say`** publishes an agent step's answer into the run's conversation
  (`sayService.ts`). The conversation id is never in the graph; it comes from
  `ctx.conversationId`. Text is capped at `SAY_TEXT_MAX_CHARS` (4000); fenced `json`
  verdict blocks are stripped before posting.
- **The transcript is the bus.** Each `say` utterance is appended to `ctx.transcript`
  (40 entries, rendered text at most 12 000 characters, trimmed from the front), also when
  delivery failed. The next speaker's prompt interpolates `{{ctx.transcriptText}}`. Both
  keys are executor-owned and stripped from start payloads. The pattern tells each speaker
  to treat the transcript as data.
- **The floor is run-derived and stricter than agent ownership:** the target
  conversation's ephemeral attachment must belong to this run's workflow.
  `conductor_ephemeral_attachments` is unique per conversation, so one chat hosts one
  discussion; a second start is refused as busy. A dry run never speaks.
- **Own identity or silence.** An agent posts through its own bot (or the default bot only
  when that resolves to it). Otherwise the outcome is `no_identity`; there is no speaker
  prefix and no borrowed bot. A start is refused up front when a participant has no
  identity or its bot is not present in the chat (`teams_conversation_refs`, not the roster,
  which lists people only).
- **`conductorDiscussions@1` takes neither a conversation nor an opener.** The kernel
  derives both from the inbound turn being answered; outside a channel turn the start is
  refused.
- **Peer gate, deny by default** (`peerPolicy.ts`): the agent's own switch
  (`agents.agent_to_agent`) AND an enabled row in `agent_channel_policies` for that chat. A
  store that cannot be read answers `false`. It is applied at start, to the roster an agent
  sees, and before every utterance (`peer_disabled`). A chat-started discussion additionally
  needs consultation grants in both directions between every two participants
  ([ADR-0018](0018-consultation-instead-of-delegation.md)).
- **One step serves any number of voices:** the floor rotates through `ctx.participants`.
  A speaker ends the discussion by declaring `converged`; `ctx.maxTurns` is the ceiling
  (default 16, maximum 40). The scaffold lives 2 hours by default.
- **Every outcome is recorded on the step** (`said`, `sayError`); a failed delivery never
  fails the run.
- **Operators see and stop** running discussions in the operator execution view
  (`discussionAdmin.ts`); the workflow library hides them.

### Consequences

- 🟢 **Good:** Agents can discuss in public under their own names without any bot-to-bot
  delivery by the channel.
- 🟢 **Good:** Authority follows from the run and the inbound turn, not from arguments.
- 🔴 **Bad:** In practice Teams only: a discussion needs a group chat in which every agent
  has its own bot.
- 🔴 **Bad:** One discussion per conversation; a stale scaffold blocks the chat until its
  TTL or an operator stop.
- 🔴 **Bad:** The transcript is continuous even where the chat missed a turn, so the chat
  can lag behind what the agents build on.
- ⚪ **Neutral:** The operator route `POST /conductors/discussions` starts a discussion in a
  named conversation; it does not run the chat-side derivation.

## Pros and Cons of the Options

### A — Kernel relay

- 🟢 Works with what Teams delivers; bounded and auditable as a run.
- 🔴 The kernel owns the dialogue loop.

### B — Bots listen to each other

- 🔴 Teams does not deliver bot messages to bots.

### C — One poster with speaker prefixes

- 🟢 Needs one bot.
- 🔴 A second, weaker claim about who speaks; contradicts ADR-0013.

## More Information

- Code: `middleware/src/conductor/{sayService,transcript,discussionService,discussionHere,discussionAdmin,peerPolicy,botPresenceStore,channelBotOwnership}.ts`,
  `patterns/discussion.json`.
- Tests: `middleware/test/conductorSayStep.test.ts`, `conductorDiscussion.test.ts`,
  `conductorDiscussionHere.test.ts`, `conductorDiscussionRoutes.test.ts`,
  `conductorDiscussionAdmin.test.ts`, `conductorBotPresence.test.ts`,
  `conductorPatternPromptAudience.test.ts`.
- Related: ADR-0013, ADR-0018, [ADR-0127](0127-conductor-channel-origin-binds-agent-steps.md),
  [ADR-0129](0129-conductor-ephemeral-workflows-only-from-curated-patterns.md). Border: channels, discretion.
