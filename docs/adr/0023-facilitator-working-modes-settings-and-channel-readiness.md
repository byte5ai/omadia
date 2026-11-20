# 0023 — Facilitators: moderation working modes, per-facilitator defaults, readiness per channel

## Status

Accepted

- **Date:** 2026-11-20
- **Deciders:** Owner (byte5); spec author iret77 (review changes of 2026-11-18)
- **Refines:** [ADR-0022](0022-native-facilitators-as-an-archetype-plugin.md) ("identity
  switching" stays omitted; working modes no longer are)

## Context and Problem Statement

Three gaps of #2060 and #2066 against spec 2043:

1. §2.3 allows a facilitator working modes that add moderation methods and forbids
   identity switching; the working-mode routes must accept moderation modes and refuse
   identity replacement. The kernel's facilitator descriptor and the plugin manifest
   omitted `persona_skill` entirely, so every working mode was refused.
2. §7 and §5.6 put default methods and the reminder policy on each facilitator ("configurable
   per facilitator and per facilitation"). They existed only as instance-wide plugin
   settings.
3. The review change of #2066 makes readiness per channel identity: Teams installation and
   RSC are checked only for Teams, and on an instance without Teams configuration a
   facilitator runs in Slack, Discord or Telegram. The operator UI marked every facilitator
   without a Teams identity "not ready".

Plus one optional item of #2088: should the persona bounds move from the kernel's code into
descriptor fields of the archetype?

## Decision Drivers

- A working mode changes how an agent works, never who speaks (AVE §5.2, INV-3).
- Plugin-first: the plugin owns the engine's behaviour; the kernel offers contracts and
  enforces what a plugin cannot own (spec 2043 §0).
- The kernel enforces the facilitator's neutrality, persona bounds included (§0 table, §2.4).
- No Teams-only assumptions (AVE §5.14).

## Decision Outcome

### 1. Working modes for facilitators

- The kernel's facilitator descriptor and the plugin manifest no longer omit
  `persona_skill`. The omission stays in the vocabulary for other archetypes.
- For every agent whose archetype is not `standard`, `POST
  /builder/agents/:slug/persona-skills` refuses (422 `facilitator_contract_violation`,
  findings per rule):
  - identity replacement (`identity_replacement`): identity fields in the skill's frontmatter
    (`persona`, `identity`, `speaker`, `display_name`, `avatar`, …), a new name, a persona or
    speaking as somebody else in its description or body (English and German, deterministic
    pattern list in `workingModeIdentity.ts`), and identity fields in the request itself;
  - for a facilitator, the neutrality contract (the same check as its instructions);
  - tools: a skill with `requires_tools` for an agent whose archetype omits tool grants
    (`working_mode_tools`); the hydration leaves skill-bound tools out for such agents too.
- Editing a skill that an agent holds as such a mode (`PATCH /builder/skills/:id`) runs the
  same checks for every such agent and refuses the edit. The build runs the identity check
  once more (`workingModesKeepingIdentity`) and leaves such a mode out (fail closed, for
  example a file-sourced skill changed on disk).
- Selection is unchanged: the per-turn router picks at most one mode, composed beneath the
  identity; the neutrality block stays inside the identity, above the mode and its
  precedence line.
- A `standard` agent is unaffected (its modes were already composed beneath its identity).

### 2. Per-agent archetype settings

- An archetype descriptor may declare `agent_settings` (manifest
  `archetype.agent_settings`): fields of type `enum` or `number_list`, with en/de labels. The
  kernel reads them strictly (unknown type → manifest refused), stores the values per agent
  (`agents.archetype_settings`, migration 0107), validates them against the fields
  (`GET/PUT /api/v1/operator/agents/:slug/archetype-settings`, audited as
  `agent.archetype_settings_change`) and hands them to the plugin as
  `AgentProfile.archetypeSettings` (plugin-api 1.81.0, optional).
- An unset field means the plugin's instance setting applies; the instance setting stays
  the default. Numbers are bounded by the kernel (at most 10 000); each save fires the
  `agents` notify trigger and so a registry reload, which is acceptable for a rare
  operator action. A value the descriptor no longer declares is not passed on.
- The facilitator declares `default_decision_method`, `default_prioritisation_method`,
  `ranked_points` and `reminder_offsets_hours`. The engine (plugin) overlays them on its
  instance configuration when a facilitation is set up and stores what it started with, so
  a later deadline change keeps the facilitator's reminder offsets. A facilitation can still
  agree on its own method and reminders.
- Older kernels ignore `agent_settings` (the archetype block was never strict about unknown
  keys), so the plugin needs no `compat.core` change; without the profile field it uses its
  instance settings.

### 3. Readiness per channel identity

- The agent list carries `own_identity_channels`: the channel types the kernel routes an
  own identity of the agent on (`ConfigStore.listChannelIdentities`: Teams and the other
  channels' own bots since S7, #2145, migration 0105). The facilitator's page offers both:
  the Teams identity and its own bots on Slack, Discord and Telegram.
- The operator UI calls a facilitator ready when the engine is usable and attached and it
  has an own identity on at least one channel; it names those channels. Teams provisioning
  states are shown only as the reason when no channel is ready.
- Whether it is ready in one conversation (installed there, reads every message, the
  channel's own checks) stays the engine's start check against the kernel's readiness and
  `no_identity` answers; the UI does not guess per conversation.

### 4. Persona bounds stay in the kernel

Spec 2043 §0 lists persona bounds among the kernel's parts and §2.4 says "the kernel
validates the bounds". Nothing in the spec asks for descriptor-declared bounds, and moving
them into a plugin's manifest would let the plugin loosen what the kernel enforces. The
bounds stay in `services/facilitatorContract.ts` (mirrored in the web-ui); #2088's optional
item is not built.

### Consequences

- 🟢 **Good:** Facilitators get moderation methods as working modes without any path to
  speak as someone else or gain tools.
- 🟢 **Good:** Per-agent settings are a generic contract: any archetype plugin can declare
  fields, the kernel validates, stores, audits and shows them; no plugin-specific UI.
- 🟢 **Good:** A facilitator is ready on Slack, Discord or Telegram without Teams.
- 🔴 **Bad:** The identity check is a pattern list; a paraphrase can pass. It still lands
  beneath the identity, whose precedence line and neutrality block hold.
- ⚪ **Neutral:** The field scenario without Teams is covered by the plugin's
  simulated-transport suite and the kernel's identity tables; a live run with real Slack,
  Discord and Telegram bots needs their credentials and is part of the release checklist.

## More Information

- Issues: #2060, #2066, #2088; spec `specs/2043-native-facilitators/spec.md` §2.3, §5.6, §6.4, §7.
- Plugin: `omadia-agent-facilitator` (manifest `agent_settings`, `facilitatorConfig`, field
  scenario `tests/fieldScenarioChannels.test.ts`).
