# 0092 — Privacy posture: `guarded` by default, bypass by the tool's owner, one org clamp that fails closed

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  per-plugin mode from Privacy Shield "Slice 2.5", clamp and posture in #1507, #1508,
  #1510, #1535, #1540, PR #1516 / #1537 / #1539.
- **Supersedes:** —

## Context and Problem Statement

The data-plane boundary ([ADR-0094](0094-privacy-shield-data-plane-boundary.md)) turns every tool result
into a digest. Some sources are useless that way (document bodies, pages), and operators
asked for a way to let a trusted source through. An opt-out invites two problems: who may
opt a tool out, and how does an organisation that must not send personal data to a model
make sure nobody does?

This record is retroactive.

## Decision Drivers

- Safe default for every plugin an operator installs and never configures.
- An opt-out is the decision of whoever owns the tool, visible to the user afterwards.
- A compliance officer needs one switch that cannot be undercut in the UI.
- With that switch on, "no shield" must mean "no answer", not "unmasked answer".

## Considered Options

- **A — Per-plugin mode (`guarded` | `bypass` | `per_tool`) as a kernel-synthetic setting,
  resolved by tool owner, plus an absolute env clamp that also fails turns closed.**
- **B — A global on/off switch for the shield.**
- **C — No bypass at all.**
- **D — Per-agent posture** (`agents.privacy_profile`).

## Decision Outcome

Chosen option: **A**.

- **Modes.** Every plugin that contributes tools gets the synthetic setup field
  `_privacy_mode` (default `guarded`) and `_privacy_bypass_scopes` for `per_tool`
  (`plugin-api/src/privacyMode.ts`). An MCP server can be flagged `privacyBypass`.
  `resolveEffectivePrivacyMode` is pure and is the one resolver.
- **Owner decides.** A tool is decided by its own owner (`privacyBypassResolver.ts`): a
  kernel tool by the plugin that registered it; an ownerless native or domain tool
  (`memory`, `query_dataset`, `mcp.*`) is never bypassed; a sub-agent's setting covers only
  its own toolkit tools.
- **Visible.** A bypassed dispatch is recorded on the turn's receipt, and the turn is
  stored `unprotected` ([ADR-0097](0097-unprotected-provenance-for-stored-content.md)).
- **Org clamp.** `OMADIA_PRIVACY_FORCE_GUARDED=true` short-circuits the resolver to
  `guarded` for every plugin, tool and MCP server, and for the MCP-to-knowledge-graph
  ingestion (`isMcpServerBypassInForce`). The UI shows "Locked by org policy".
- **The clamp fails closed.** With it on: uninstalling the last `privacy.redact@1` provider
  is refused (`409 install.privacy_guard_required`); a turn without a running provider is
  refused before the screener or the model see it (`PrivacyShieldRequiredError`); every
  turn on the subscription CLI is refused before the child is spawned
  (`CliChatAgent.refusedByPolicy`); the builder preview chat is refused; memory jobs
  outside a turn refuse without a guard. The instance still boots and the admin UI works,
  so the guard can be repaired.
- **Posture is reported.** `GET /api/v1/admin/runtime/privacy-posture` (authenticated, not
  on the public `/health`) reports the clamp, `shield_active` and the name detector.
- **Not a control.** `agents.privacy_profile` is metadata; no runtime path reads it, and
  the UI labels it "(not enforced)" (#978, migration `0061`).
- **Public MCP endpoint.** It applies no bypass at all and serves no intern-exempt tool
  (`createFailClosedPrivacyGate`).

### Consequences

- 🟢 **Good:** An unconfigured plugin is guarded; a bypass is a recorded operator act.
- 🟢 **Good:** One env var gives an organisation a guarantee the UI cannot weaken.
- 🔴 **Bad:** Without the clamp, an instance with no privacy provider masks nothing and
  runs; the dashboard says so (`shield_active: false`) but nothing stops it.
- 🔴 **Bad:** A bypassed tool's returned `Error:` text reaches the model as returned; only a
  thrown message is withheld under bypass ([ADR-0078](0078-tool-errors-reach-the-model-by-provenance.md)).
- 🔴 **Bad:** Under the clamp, agents on the subscription CLI do not answer at all.
- ⚪ **Neutral:** Making `agents.privacy_profile` enforce anything is a new decision that
  must update `docs/security-architecture.md` §6d.

## Pros and Cons of the Options

### A — Per-plugin mode, owner resolution, env clamp

- 🟢 Granular and auditable; the clamp is absolute and simple to reason about.
- 🔴 Three levels (plugin, tool list, MCP server) to explain.

### B — Global switch

- 🟢 Simple.
- 🔴 One document tool would switch masking off for HR data too.

### C — No bypass

- 🟢 Strongest default.
- 🔴 Document-shaped sources become unusable; operators would remove the guard instead.

### D — Per-agent posture

- 🟢 Matches how operators think about agents.
- 🔴 Would have to survive the sub-agent boundary and reach `AgentRuntimeConfig`; not built
  (§6d names what it would take).

## More Information

- Code: `middleware/packages/plugin-api/src/privacyMode.ts`,
  `middleware/packages/harness-orchestrator/src/privacyPolicy.ts`,
  `privacyBypassResolver.ts`, `mcpPrivacyBypass.ts`, `cliChatAgent.ts`,
  `middleware/src/plugins/installService.ts`, `middleware/src/mcp/publicMcpPrivacy.ts`.
- Docs: `docs/security-architecture.md` §6d, §6f; `docs/trust-and-privacy.md`.
- Tests: `middleware/test/privacyV4Bypass.test.ts`, `runtimePrivacyPostureRoute.test.ts`,
  `test/publicMcp/publicMcpPrivacyGate.test.ts`.
