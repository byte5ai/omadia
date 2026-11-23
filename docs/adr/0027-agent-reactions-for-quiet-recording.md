# 0027 — Agent reactions for quiet recording

## Status

Accepted

- **Date:** 2026-11-20
- **Deciders:** Owner (byte5: close every gap of spec B); implemented by stream F3
- **Supersedes:** the "Quiet recording without a reaction contract" part of
  [ADR 0025](0025-facilitation-contributions-and-decisions.md)

## Context and Problem Statement

Spec B §5.3 and §5.14: "Recording is quiet: a contribution in the announced format gets a
reaction (for example 👍) where the channel supports reactions, otherwise nothing." ADR 0025
recorded that the kernel had no contract for an agent to react, so the facilitator posted
nothing. The owner asked to close the gap per spec. How does an archetype agent set a reaction,
under which authorization, and which channels can?

## Decision Drivers

- A reaction is an action of the agent in a conversation: bounded by the execution scope like a
  post, as its own identity, never through another bot.
- An agent may react only to a message of its own process's conversation.
- Channel parity: the plugin must know whether a channel can, and stay silent where it cannot.

## Decision Outcome

- The kernel offers a reaction contract. `conversationSend@2` has an optional `react({ messageEventId, reaction })`
  (plugin-api 1.82.0): drawn from the execution scope like a post to that conversation
  (action `post`, emission `data`), set as the agent's own identity, and only on a message the
  kernel stored for this process in this conversation (resolved from the stored inbound event,
  never from a platform id the caller names). Channels declare it with
  `supports.reactions` and implement `ConversationSendProvider.react` (channel-sdk 0.3.9);
  `capabilities(channelType).reactions` tells the plugin. The reaction is semantic
  (`acknowledge`); each channel uses its own thumbs-up.
- **Channels:**
  - Teams: Bot Connector `PUT {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}/reactions/like`
    (the route of the Teams SDK's `ReactionClient`; Microsoft Learn "Agent reactions": "agents
    can attach one or more different reactions to any message in a conversation", rate limit
    two per second). Graph `chatMessage: setReaction` is delegated-only and is not used.
  - Slack: `reactions.add` (`name: +1`, scope `reactions:write`).
  - Discord: `PUT /channels/{channel}/messages/{message}/reactions/👍/@me`.
  - Telegram: `setMessageReaction` with the 👍 emoji (bots set at most one reaction).
- The plugin sets the reaction only where the channel declares it; elsewhere recording stays
  silent, as before. A reaction that fails changes nothing about the contribution.

### Consequences

- 🟢 **Good:** contributors see that their contribution counted, without a public echo.
- 🔴 **Bad:** one more action per contribution on the scope's budget; Teams limits reactions to
  two per second per agent across conversations (a failed reaction changes nothing).
- ⚪ **Neutral:** plugin-api 1.82.0, channel-sdk 0.3.9; channel plugins Teams, Slack, Discord and
  Telegram declare `reactions`.

## More Information

- Kernel: `middleware/src/channels/scopedSendService.ts` (`react`),
  `middleware/src/channels/conversationSendService.ts`.
- Microsoft Learn, "Agent reactions" (Teams): agents can add reactions to messages in Teams chats.
- Slack `reactions.add`, Discord "Create Reaction", Telegram Bot API `setMessageReaction`.
