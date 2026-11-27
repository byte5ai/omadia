# 0289 — The Linear channel is a third plugin, with one Linear app per agent

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers. Design record for #1031 (wave 6, W36). Nothing is built
  with it; it waits for the owner's confirmation.

## Context and Problem Statement

#1031 asks for Linear as a conversation surface (mention or delegate an omadia agent in an
issue, answer in the thread), as a tool set, and as a tracker for dev-platform. Phase 1 is
built outside core as two public plugins (comment of 2026-11-25 on #1031):

- `byte5ai/omadia-integration-linear` (`kind: integration`, v0.3.2): a personal Linear API
  key in the vault, the typed client as capability `linear.api@2`, requests via `ctx.http`.
- `byte5ai/omadia-plugin-linear` (`kind: tool`, v0.6.0): issue tools granted per agent,
  writes as two-phase previews ([ADR-0005](0005-two-phase-confirmation-for-writes.md)), two
  agent templates.

Open: every read and write acts as the owner of the API key, so Linear shows that person,
not the agent. The channel, events, OAuth identity and the tracker capability are not
started.

The question: how do agents get their own identity in Linear, and how is the channel
delivered?

## Decision Drivers

- One manifest kind per plugin ([ADR-0014](0014-plugins-are-only-the-delivery-form.md)).
- An agent acts under its own identity on every channel; one bot belongs to one agent
  ([ADR-0012](0012-agents-are-virtual-employees.md),
  [ADR-0134](0134-agents-own-bots-on-channels.md)).
- OAuth runs through the kernel's declarative broker; tokens stay in the plugin vault
  ([ADR-0164](0164-declarative-oauth-broker-for-plugins.md)). That broker knows one OAuth
  app and one connection per plugin and setup field, with no agent in its state.
- A plugin reads only its own vault; credentials do not cross plugin boundaries.
- Inbound events are accepted only when authentic; forged or replayed events have no side
  effect.

## Considered Options

- **A — Third plugin, one Linear OAuth app per agent.** `omadia-channel-linear`
  (`kind: channel`) registers an `AgentIdentityProvider`. The operator connects one Linear
  app (OAuth, `actor=app`) per agent; the app's own user is mentionable and assignable in
  Linear, and its writes show the agent.
- **B — One shared Linear app for the instance**, with the agent's name stamped per write
  (`createAsUser`, `displayIconUrl`).
- **C — Keep the personal API key** and add the channel on top of it.

## Decision Outcome

Chosen option: **A** (recommended; owner confirmation pending, including whether Linear is
on the roadmap beyond phase 1).

- **Three plugins, three kinds.** The integration (connection, `linear.api@2`), the tool
  plugin (capability granted per agent) and a new channel plugin. The channel only transports
  for kernel-managed agent identities; it answers on no one's behalf.
- **One Linear app per agent.** Per ADR-0134: the operator enters the agent's Linear app
  client id and secret; the plugin runs the OAuth exchange (`actor=app`), then identifies
  the app user (`identify`), the kernel checks it is free, and the plugin provisions it.
  Mentioning or delegating to that app routes to exactly that agent. Tokens stay in the
  channel plugin's vault.
- **This needs an extension of ADR-0164.** Today's broker holds one OAuth app and one
  connection per plugin and field. Per-agent connections (client credentials and tokens
  keyed by agent, the agent in the signed `state`, the flow started from the agent's
  channel-identity page) are a contract change and get their own ADR before the channel is
  built. Until then the alternative is that the channel plugin runs the exchange itself,
  which ADR-0164 was written to avoid; this record does not choose that.
- **Agent writes stay in the channel plugin.** The tool plugin cannot read the channel
  plugin's tokens. The channel plugin publishes a capability (working name
  `linear.agentActor@1`) that performs a Linear request as the calling agent's app; the
  token never leaves the channel plugin, and the kernel passes the calling agent from the
  tool call context, never from tool input. The tool plugin uses it when the calling agent
  has a Linear app and otherwise falls back to `linear.api@2`; its write preview says whose
  identity the write will carry.
- **Events.** One webhook route per plugin with raw-body access; the signature is verified
  before anything else; duplicates are dropped by delivery id; processing is asynchronous.
  An instance without a public URL runs tools only.
- **Tracker is a separate capability.** A generic tracker contract that dev-platform
  resolves (kind in the capability name, so GitHub, Jira and Linear coexist) is its own
  decision in the dev-platform repository; it is not part of this record.

### Consequences

- 🟢 **Good:** Linear shows which agent acted; mentions reach exactly one agent.
- 🟢 **Good:** Reuses ADR-0134 unchanged.
- 🔴 **Bad:** Needs a per-agent extension of the ADR-0164 OAuth broker (own ADR) and a new
  capability between the channel and tool plugins.
- 🔴 **Bad:** The operator creates one Linear app per agent that should be present in Linear.
- ⚪ **Neutral:** Follow-ups after confirmation: repository `omadia-channel-linear`, OAuth in
  the tool path, tracker contract issue in dev-platform.

## Pros and Cons of the Options

### A — Third plugin, one app per agent

- 🟢 Matches the identity model of every other channel.
- 🔴 Setup effort per agent.

### B — One shared app with stamped names

- 🟢 One OAuth app for the instance.
- 🔴 Linear sees one app user: mentions and delegation cannot address a specific agent;
  routing would fall back to guessing.

### C — Personal API key

- 🟢 Already built.
- 🔴 Every action appears as a human; fails ADR-0012/0134.

## More Information

- Issue: [#1031](https://github.com/byte5ai/omadia/issues/1031)
- Related: ADR-0005, ADR-0012, ADR-0014, ADR-0134, ADR-0164.
