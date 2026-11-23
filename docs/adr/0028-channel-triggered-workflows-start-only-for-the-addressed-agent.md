# 0028 — Channel-triggered workflows start only for the addressed agent

## Status

Accepted

- **Date:** 2026-11-21
- **Deciders:** Owner (byte5: fix the live finding of 2026-11-21); implemented by stream G3

## Context and Problem Statement

Live finding on Fly, 2026-11-21: every message to "Mona (Test)", an agent with its own Teams bot,
started an enabled workflow subscribed to a Teams event. Its step `agent-4` is configured for the
platform agent `fallback`. The step-level origin rule (`assertChannelOriginAllows`, from the
impersonation fix: work started by a message to a bot runs with that bot's permissions only)
refused the step every time ("addressed to Agent 'mona-test' … configure this step for
'mona-test'"). Each mention produced one failed run, and any step before `agent-4` had already
run.

The workflow itself is correct for the deployment's default bot, which resolves to `fallback`.
Its trigger has no filter on the addressed bot, so it also matched messages to every other bot.
Should the kernel start a run that its own rule will refuse?

## Decision Drivers

- The origin rule stays absolute: the addressed bot's agent runs, or nothing runs.
- A run that cannot succeed should not start, and must not run its earlier steps.
- An operator should see why a workflow did not start.

## Decision Outcome

- `ConductorEventRouter` resolves the addressed agent of a channel event (`botId` in the payload,
  same owner resolution as the step rule: provisioned identity, else the configured default bot
  through conversation binding and fallback). A matching workflow whose agent steps run as any
  other agent is not started; the router logs the workflow, the addressed agent and the step
  agents, and returns it in `skippedWorkflows`.
- Non-channel events, channel events without `botId` and bots that resolve to no active agent are
  unchanged: the run starts and the step rule refuses it with its precise reason.
- The step-level rule stays as the second line (resumed runs, other start paths).

### Consequences

- 🟢 **Good:** messages to an agent's own bot no longer produce failed runs of workflows meant for
  another bot; no partial runs.
- 🔴 **Bad:** a workflow with a branch that never reaches its foreign agent step is not started
  either. Such a workflow needs a trigger per bot or steps for the addressed agent.
- ⚪ **Neutral:** no migration, no contract change.

## More Information

- Kernel: `middleware/src/conductor/eventRouter.ts`, `middleware/src/conductor/channelBotOwnership.ts`,
  `middleware/src/conductor/realStepEffects.ts` (step rule).
- Test: `middleware/test/conductorEventRouterAddressedAgent.test.ts`.
