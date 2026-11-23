# 0032 — The caller of a tool call is named like the author of a message

## Status

Accepted

- **Date:** 2026-11-23
- **Deciders:** Coordinator of the native facilitator rollout (#2043), after the live runs on
  Discord, Slack and Telegram

## Context and Problem Statement

The kernel names a person in a group conversation in two forms:

- **The routing principal** (spec 2042 §5.3, #2055, `channelUserPrincipal`). It is
  `user:<e-mail>` once the address is verified, else `user:<kind>:<id>`, for example
  `user:discord-user:<snowflake>` or `user:telegram-chat:<id>`. Selections, default-agent
  entries and availability are keyed by it.
- **The conversation form** (`user:<channel user id>`, lower-cased). A stored message's
  `author.principalId` (`principalOfChannelUser`), roster participants and `targetedSend`
  use it. `NativeToolCallContext.callerPrincipalId` is documented as this form.

`buildToolCallContext` took `TurnOrigin.principal` first. Teams states the Entra object id
there (the conversation form), so Teams was right. Discord, Slack and Telegram state the
routing principal there, and the tool call carried it.

The live runs of 2026-11-23 showed the consequence. A facilitator keyed the initiator as
`user:discord-user:<id>` and the same person's ballot as `user:<id>`. The protocol named
them twice, the count stayed at "1 of 2", and "everyone voted" never closed a vote.

## Decision Drivers

- One person, one key inside a facilitation. The engine joins initiator, ballots, roster,
  reminders and action items on it.
- The plugin-api contract already names the conversation form for `callerPrincipalId`.
- No channel plugin should have to change: the routing principal on `TurnOrigin.principal`
  is correct for routing.

## Decision Outcome

`callerPrincipalId` is derived from the channel user of the turn:

1. the speaker the channel named;
2. else the channel identity;
3. then the stated `TurnOrigin.principal`, only for a turn without a channel user, such as
   the web chat;
4. then the turn's user id.

One helper, `conversationPrincipal` (`@omadia/orchestrator`), produces the conversation form
for every path that names a person to a facilitation:
- the caller of a tool call (`buildToolCallContext`);
- the author of a stored message and a roster participant (`principalOfChannelUser`).

Engine turns (`agentTurn@2`) already state the author's conversation form and are
unchanged.

### Consequences

- 🟢 **Good:** On every channel the caller of a tool and the author of a message are the
  same principal. The initiator is one participant, and "everyone voted" can be reached.
- 🔴 **Bad:** A plugin that wants the routing principal in a tool call cannot read it from
  `callerPrincipalId`. It has to derive it with `channelUserPrincipal` from `callerUserRef`.
  No plugin does today.
- ⚪ **Neutral:** No plugin-api or channel-sdk change. Teams is unchanged, because its stated
  principal was already the conversation form.

## More Information

- Live findings: byte5ai/omadia-channel-discord#6, byte5ai/omadia-channel-telegram#8.
- Test: `middleware/test/toolCallCallerPrincipal.test.ts`, one case each for Teams, Slack, Discord and
  Telegram.
- Related: ADR 0026 (authorship of spoken contributions), spec 2042 §5.3 (routing principal).
