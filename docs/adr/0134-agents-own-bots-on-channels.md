# 0134 — One bot per agent per channel; its key routes exclusively and its credentials stay in the channel plugin

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** Owner (byte5); Teams identities in #877 (epic #860), own bots on Telegram,
  Discord and Slack in #2145 (stream S7, spec 2042 §5.3)
- **Supersedes:** —

## Context and Problem Statement

ADR-0012 makes agents virtual employees and ADR-0013 stamps every message with its speaker.
On a chat platform the visible sender is not a field of the message: in Teams the display name
and icon come from the app package (`docs/teams-multi-agent-identities.md` §1, "Kein
Namenswechsel pro Nachricht"), and a Telegram, Discord or Slack bot is one account. One shared
bot that answers "as" several agents can therefore not be shown truthfully. This record is
retroactive. How does an agent get an identity of its own on a channel, who holds the bot's
credentials, and how is a message to that bot routed?

## Decision Drivers

- "One identity per agent where the platform allows it" (spec 2042 §5.3, §8 item 20).
- A message to an agent's bot goes to that agent and nobody else, without a model in between.
- Bot tokens are secrets of the channel plugin; the kernel should not become a second vault.
- Teams needs a multi-step provisioning chain; the other platforms need one token.

## Considered Options

- **A — One bot per agent and channel type; the channel plugin runs it, the kernel stores only
  the routing key and routes it exclusively.**
- **B — One shared bot per channel; the agent is named in the message text.**
- **C — The kernel stores bot credentials and hands them to channel plugins at start.**

## Decision Outcome

Chosen option: **A**.

- **The provider contract.** A channel plugin that can run several bots registers an
  `AgentIdentityProvider` (`middleware/packages/harness-channel-sdk/src/agentIdentity.ts`). The
  operator enters credentials for an agent; the plugin says which bot they are (`identify`, no
  side effect), the kernel checks that the bot is free, the plugin starts it (`provision`), and
  the kernel stores `(agent, channel type, key)`.
- **Credentials cross the kernel once.** They go from the operator's request to the plugin and
  stay in the plugin's vault. `agent_channel_identities` has no secret column (migration
  `0105`); the routes never echo, store or audit them, and a plugin's error text is scrubbed of
  every credential value before it is logged or returned
  (`middleware/src/platform/agentChannelIdentityService.ts`).
- **Uniqueness.** `UNIQUE (channel_type, channel_key)`: one bot belongs to one agent.
  `UNIQUE (agent_id, channel_type)`: an agent has one bot per channel.
- **Teams is separate.** A Teams identity is the end of a chain (Entra app, Azure bot, app
  package, tenant catalog, team install) tracked step by step in `agent_teams_identities`
  (migration `0049`); its key `28:<appId>` is derived from that row. A `CHECK` keeps `teams`
  out of `agent_channel_identities`, and routing reads the union.
- **Exclusive routing.** Inbound, the adapter resolves the turn on the bot's key as well as the
  conversation's; `ChannelResolveResult.exclusive` / `match: 'identity'` marks a hit on the
  agent's own bot, and an adapter that probes several keys prefers it over a binding or the
  default (`channelRouting.ts`). Outbound, the answer leaves through the bot that received the
  turn; kernel-initiated posts carry `asChannelKey`, which the provider honours or refuses
  (`supports.asChannelKey`).
- **No fallback identity.** An own-identity send without an identity ends in `no_identity`,
  never in another bot (`middleware/src/channels/ownIdentitySend.ts`). The row outlives a soft
  delete of its agent, so the bot of a deleted agent is refused instead of answered by someone
  else (#2088).

### Consequences

- 🟢 **Good:** Name and avatar in the client are the agent's; the speaker is true on the
  platform, not only in the payload.
- 🟢 **Good:** Rate limits are per bot, so N agents have N budgets on Teams.
- 🔴 **Bad:** Every agent with an identity is one more app registration or bot account an
  operator creates and maintains; Teams provisioning needs Graph application permissions and
  admin consent.
- 🔴 **Bad:** Two identity tables (`0049`, `0105`) with one routing union.
- 🔴 **Bad:** Platform limits remain: bots in Teams never see each other's messages, so
  agent-to-agent coordination stays server-side (ADR-0018).
- ⚪ **Neutral:** Operator routes
  `GET|PUT|DELETE /api/v1/operator/agents/:slug/channel-identities[/:channelType]`; Teams keeps
  `/:slug/teams-identity`.

## Pros and Cons of the Options

### A — One bot per agent, key in the kernel, secret in the plugin

- 🟢 Truthful sender, deterministic routing, one custodian per secret.
- 🔴 Provisioning effort per agent and channel.

### B — Shared bot, agent named in text

- 🟢 No provisioning.
- 🔴 The platform shows one sender for all agents; a name line in the text is what
  `speakerLine()` is for where nothing better exists, not the target state.

### C — Credentials in the kernel

- 🟢 One place to rotate.
- 🔴 The kernel holds platform secrets it never uses; a second copy next to the plugin's vault.

## More Information

- Related: ADR-0012, ADR-0013, ADR-0022, ADR-0023 (readiness per channel identity), ADR-0028;
  [ADR-0135](0135-channel-plugin-contract-and-channel-type-ownership.md).
- Code: `middleware/src/routes/operatorAgentChannelIdentities.ts`,
  `middleware/migrations/0105_agent_channel_identities.sql`,
  `middleware/migrations/0049_agent_teams_identities.sql`.
- Tests: `middleware/test/agentChannelIdentityService.test.ts`,
  `middleware/test/agentChannelIdentities.pg.test.ts`,
  `middleware/test/operatorAgentChannelIdentitiesRouter.test.ts`, `middleware/test/ownIdentitySend.test.ts`.
- Operator guide: `docs/teams-multi-agent-identities.md`.
