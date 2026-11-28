# 0277 — The other agent config writes carry an expected revision, one counter per resource

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 6, W34; #2315; decision after recommendation, reversible)
- **Supersedes:** —  (carries out the "Follow later" part of [ADR-0216](0216-operator-config-writes-carry-an-expected-revision.md))

## Context and Problem Statement

ADR-0216 gave `PUT /api/v1/operator/agents/:slug/identity` an optional `expected_revision`
and a 409 on a stale write. It named the other replace-style agent config writes —
`PUT /:slug/plugins`, `/bindings`, `/model-policy`, `/context-memory`, `/fast-lane`,
`/agent-to-agent`, `/availability` — as follow-up, noting they have no revision yet. Two
tabs editing the same agent's model policy still silently overwrite each other. What is the
token, and how is it checked?

## Decision Drivers

- Same contract as ADR-0216 for clients: optional field, 409, machine-readable body.
- The check must not let two writes based on the same state both pass.
- An edit of one resource must not conflict with an unrelated edit of another.
- No per-resource table changes; the writes go through different stores.

## Considered Options

- **A — One counter per resource in `agents.config_revisions` (jsonb), claimed with a
  conditional `UPDATE` right before the write**
- **B — One counter per agent for all config** (like the identity row: an avatar change
  conflicts with a field save)
- **C — A content hash of the current state as the token** (a read-then-write window)

## Decision Outcome

Chosen option: **A**.

- Migration 0121 adds `agents.config_revisions jsonb NOT NULL DEFAULT '{}'`; a missing key
  is revision 0. Resources: `plugins`, `bindings`, `model_policy`, `context_memory`,
  `fast_lane`, `agent_to_agent`, `availability` (`AGENT_CONFIG_RESOURCES`).
- `ConfigStore.claimConfigRevision(agentId, resource, expected?)` moves the counter by one in
  one statement, only from `expected` when given (`WHERE … = $expected`). It runs after the
  request is validated and right before the first write. Of two writes based on the same
  revision exactly one passes. A write that fails after the claim leaves the counter moved:
  the next stale save then conflicts once more (accepted).
- A mismatch answers **409** `{ error: 'config_revision_conflict', code:
  'operator_agents.config_revision_conflict', message, resource, expected_revision,
  current_revision }` and writes nothing.
- Absent `expected_revision` = unchecked, as in ADR-0216; the claim still moves the counter.
  A present value that is not a non-negative integer is a 400.
- The GETs of the dedicated resources (`/model-policy`, `/context-memory`, `/fast-lane`,
  `/agent-to-agent`, `/peer-channels`, `/plugins`) return `revision`; `GET
  /:slug/config-revisions` returns all of them (bindings and availability have no GET of their
  own); every write returns the new one. `PATCH /:slug/plugins` (one plugin) moves the `plugins` counter unchecked, so a
  replace-style editor opened before it conflicts.
- The web UI sends the field from the four detail panels (model policy, context memory, fast
  lane, agent-to-agent) and shows a localized conflict message.

### Consequences

- 🟢 **Good:** stale tabs no longer silently overwrite model policy, memory scope, fast lane
  or agent-to-agent settings.
- 🟢 **Good:** resources do not conflict with each other.
- 🔴 **Bad:** the content-equal exception of ADR-0216 (an identical write is accepted at any
  revision) is not applied here; an identical stale write gets a 409.
- 🔴 **Bad:** other writers of the same columns (agent creation, onboarding, the canvas,
  templates) do not move the counters, so a form opened before such a write is not warned.
- ⚪ **Neutral:** the dashboard's plugin and binding editors and the availability section do
  not send the field yet (server ready; follow-up in handoff §13).

## More Information

`middleware/migrations/0121_agent_config_revisions.sql`,
`middleware/packages/harness-orchestrator/src/registry/configStore.ts`,
`middleware/src/routes/operatorAgents.ts` (`splitExpectedRevision`, `claimRevision`),
`web-ui/app/_lib/agents.ts` (`revisionField`).
