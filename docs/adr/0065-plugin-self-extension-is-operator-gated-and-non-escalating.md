# 0065 — A plugin may propose to extend itself; the kernel refuses any widening, and an operator can only narrow

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; implemented in #254 (operator-gated, non-escalating
  self-extension) and #255 (agent-authored proposals, standalone-plugin SDK). Recorded
  retroactively.
- **Supersedes:** —

## Context and Problem Statement

A capability plugin meets its own limits at runtime: a row cap, a missing operation, a page
that is cut off. The agent using it cannot finish the task. The fix is usually a small new
tool on top of access the plugin already has. Having an operator rebuild the plugin by hand
for each such case is slow; letting a plugin or an agent change code on its own is how a
system grants itself rights.

This record is retroactive. Under which rule may a plugin's tool set grow at runtime?

## Decision Drivers

- No write access, egress or data source that the plugin does not already hold
  ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md)).
- A human decides; the human must not be able to approve an escalation by accident.
- No second build or install path.
- Every step is on record.

## Considered Options

- **A — Declarative proposals, a kernel escalation guard before the operator, operator
  approval that can only narrow, materialisation through the existing install path**
- **B — Agents generate and hot-load code for a plugin**
- **C — Operator approval alone decides** (escalations are shown and can be approved)
- **D — No self-extension**; every change is a manual Builder session or a new release

## Decision Outcome

Chosen option: **A** (`middleware/src/plugins/selfExtension/`).

- **A limit is signalled, not hidden.** A tool returns a `LimitSignal`
  (`@omadia/plugin-api`: `row_cap`, `page_truncated`, `unsupported_operation`, `rate_limited`,
  `missing_capability`); the result text carries a `[tool-limit:…]` note.
- **A proposal carries no code.** Two forms:
  - *spec* (Builder-made plugins): 1 to 100 JSON patches against the plugin's own `AgentSpec`;
  - *template* (hand-written plugins): the id and params of an `ExtensionTemplate` the plugin
    itself exports as `selfExtend.templates`, each with the sub-surface it `requires`.
- **Escalation guard, before any human sees it** (`escalationGuard.ts`,
  `permissionSurface.ts`). The spec is reduced to its permission surface (`depends_on`, graph
  reads / writes / entity systems, sub-agent calls, models, `network.outbound`, `web_scanner`,
  `external_reads`, privacy class). The proposed surface must be a subset of the current one,
  wildcard-aware; where coverage cannot be proven it counts as a widening. A widening is
  `denied_escalation` and never becomes `pending`. A patch that changes `/id` is `invalid_spec`.
  For a template, `requires` must be covered by the installed manifest's surface.
- **Operator gate** (`operatorGate.ts`): `pending → approved → installed | install_failed`,
  or `denied`. On approval the operator may attach narrowing patches; the result must be a
  subset of the *proposed* surface, else `NarrowingWidensError`.
- **Agents may ask, never decide.** The kernel tool `request_self_extension` submits a
  template proposal as `pending`, at most 5 pending per plugin, and dispatches a notification
  through the notification router. Spec
  proposals come only through the operator routes (an agent turn has no operator identity).
- **Materialisation reuses what exists** (`service.ts`). Spec path: a new draft with the
  approved spec, then `installDraft` (codegen, build, ingest, reactivation). Template path:
  the `ApprovedExtension` is stored in `data/self-extensions.json` (`extensionStore.ts`) and
  replayed into the plugin's own `selfExtend.apply(ctx)` on every activation; the package
  directory stays read-only. New tools run through the same per-call privacy and tool dispatch
  as every other tool.
- **Audit** (`audit.ts`): `proposed`, `denied_escalation`, `invalid_spec`, `approved`,
  `narrowed`, `denied_by_operator`, `installed`, `install_failed`, append-only with a sequence.

### Consequences

- 🟢 **Good:** A plugin can grow new tools without a release; it cannot grow new rights.
- 🟢 **Good:** In the template path the guarantee is structural: `apply()` gets the same
  scoped `ctx` as `activate()`.
- 🟢 **Good:** The operator's decision is small: "is this useful", not "is this safe to grant".
- 🔴 **Bad:** Proposals and the audit trail live in memory. `index.ts` builds
  `new OperatorGate()` without a store or an audit sink, so a restart loses pending proposals
  and the trail; only approved template extensions persist.
- 🔴 **Bad:** The surface vocabulary still names retired concepts (`permissions.subAgents`,
  `permissions.llm`); a new permission dimension that is not added to `PermissionSurface` is
  invisible to the guard.
- 🔴 **Bad:** In the spec path the new tool's code is model-written at build time; the guard
  proves the manifest surface, not what the code does inside it.
- ⚪ **Neutral:** `request_self_extension` is registered as a kernel tool for every agent, not
  granted per agent.

## Pros and Cons of the Options

### A — Guard, then operator, narrowing only

- 🟢 Escalation is impossible to approve; no new install path.
- 🔴 Extensions are limited to what the current surface already allows.

### B — Agent-generated hot-loaded code

- 🟢 No waiting for a human.
- 🔴 Self-granted capabilities; no review, no reproducible artefact.

### C — Operator decides everything

- 🟢 Maximum flexibility.
- 🔴 One click on a long diff grants write access; the operator becomes the only control.

### D — None

- 🟢 Nothing new to secure.
- 🔴 Agents keep failing on structural limits that a ten-line tool would lift.

## More Information

- Related: [ADR-0005](0005-two-phase-confirmation-for-writes.md),
  [ADR-0014](0014-plugins-are-only-the-delivery-form.md),
  [ADR-0016](0016-least-privilege-and-the-agent-envelope.md);
  [ADR-0058](0058-builder-drafts-owner-scoped-and-installed-through-the-upload-ingest.md).
- Paths: `middleware/src/plugins/selfExtension/`, `middleware/src/routes/selfExtension.ts`,
  `middleware/packages/plugin-api/src/{selfExtend,limitSignal}.ts`.
- Tests: `middleware/test/selfExtension/{escalationGuard,permissionSurface,operatorGate,service,routes,requestSelfExtensionTool,extensionStore,limitSignal,audit}.test.ts`.
