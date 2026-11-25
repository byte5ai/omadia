# 0127 — Work started by a message to a bot runs as that bot's agent, or not at all

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; impersonation fix #986, default-bot resolution added
  afterwards (`channelBotOwnership.ts`); archetype check #2060 (recorded retroactively from
  the code on main)

## Context and Problem Statement

A Conductor workflow can start on a channel event, for example a Teams message to a bot.
Its agent steps name agents by slug. Without a rule, a person who can only reach agent A's
bot could start a workflow whose step runs as agent B, with B's grants and memory. That is
the hidden substitute [ADR-0012](0012-agents-are-virtual-employees.md) forbids and a way
around the envelope of [ADR-0016](0016-least-privilege-and-the-agent-envelope.md).
[ADR-0028](0028-channel-triggered-workflows-start-only-for-the-addressed-agent.md) later
added a router pre-check and names this step rule only as its background. Which authority
does an agent step have when a channel message started the run? This record is retroactive.

## Decision Drivers

- The addressed bot's agent runs, or nothing runs.
- "Unknown origin" must not be treated as "fine": the plugin builds that omitted the bot id
  were the ones that allowed the impersonation.
- Manual, scheduled and webhook runs have no addressed bot and must keep working.
- Inbound and outbound must agree on which agent a bot is.

## Considered Options

- **A — A step-level origin rule keyed on the run's trigger, with one owner resolution for
  both directions**
- **B — Trust the workflow author** (an operator wrote the graph, so any agent may run)
- **C — Rewrite the step to the addressed agent** instead of refusing

## Decision Outcome

Chosen option: **A**.

- **The rule** (`assertChannelOriginAllows`, `realStepEffects.ts`) runs before every agent
  step and has three outcomes: not a channel trigger → allowed; channel trigger with an
  unknown or unattributable bot → refused; channel trigger with a known bot → the step's
  agent must be that bot's agent.
- **The trigger is read from the run,** once per drive (`triggerMetaFor`). A run that
  cannot be read back counts as not channel-triggered; the comment in the executor names
  that as the safe direction because the rule refuses what it cannot attribute.
- **One owner resolution** (`channelBotOwnership.ts`): a provisioned identity
  (`agent_teams_identities`) always wins. The only other bot with an owner is the
  deployment's configured default bot; it resolves through the conversation's binding
  first, then the registry's channel resolution, exactly as chat routes it. A provisioned
  bot whose agent is not active is refused, and so is any other unknown bot key.
- **The same resolution decides who speaks** (`speakingIdentityFor`): an agent posts through
  its own bot, or through the default bot only when that bot resolves to this agent. See
  [ADR-0126](0126-conductor-agent-dialogue-is-relayed-by-the-kernel.md).
- **An agent step is a consultation of that agent on somebody's behalf**
  (`assertArchetypeAllows(agent, 'consultation')`): an archetype that omits consultation,
  such as the facilitator, cannot be run as a workflow step.
- **Second line, not the only one.** The router pre-check of ADR-0028 avoids starting runs
  the rule would refuse; the step rule stays for resumed runs and other start paths.

### Consequences

- 🟢 **Good:** A message to one bot cannot borrow another agent's permissions through a
  workflow.
- 🟢 **Good:** A run started through a bot answers through that bot.
- 🔴 **Bad:** One workflow cannot hand a channel-triggered request from the addressed agent
  to a second agent step; that needs a consultation
  ([ADR-0018](0018-consultation-instead-of-delegation.md)) or a non-channel trigger.
- 🔴 **Bad:** A channel plugin that does not put the bot id in its event payload gets every
  agent step refused.
- ⚪ **Neutral:** Action steps and human steps are not bound by the rule; only agent steps
  carry an agent's envelope.

## Pros and Cons of the Options

### A — Step-level origin rule

- 🟢 Holds for every start and resume path.
- 🔴 Refuses some workflows an operator meant.

### B — Trust the author

- 🟢 Maximum flexibility.
- 🔴 The author decides once; the person who triggers decides every run.

### C — Rewrite to the addressed agent

- 🟢 Never fails.
- 🔴 Runs a prompt written for one agent with another agent's tools and instructions.

## More Information

- Code: `middleware/src/conductor/realStepEffects.ts` (`assertChannelOriginAllows`),
  `channelBotOwnership.ts` (`resolveAddressedBot`, `speakingIdentityFor`), `runExecutor.ts`
  (`triggerMetaFor`), `eventRouter.ts`.
- Tests: `middleware/test/conductorChannelOrigin.test.ts`, `conductorDefaultBot.test.ts`,
  `conductorEventRouterAddressedAgent.test.ts`.
- Related: ADR-0012, ADR-0013, ADR-0016, ADR-0028. Border: channel routing and identities.
