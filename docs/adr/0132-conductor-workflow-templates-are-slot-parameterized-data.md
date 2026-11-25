# 0132 — Workflow templates are data: slot placeholders in ref fields, three disjoint grammars

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; #429 (#479, bundled catalog and slot mapping), #478
  (templates v2: user templates, review gate, text slots, plugin templates), #1709 (run
  token grammar), #1713 (recorded retroactively from the code on main)

## Context and Problem Statement

Operators should start from proven workflows instead of an empty canvas. A workflow graph
names install-local things: agents, actions, roles, events, channels. A template must carry
the graph without those names, travel between installs and through plugins, and still be
checkable. Graph text fields also carry values that only a run knows. How is a template
represented, and how do install-time and run-time placeholders stay apart? This record is
retroactive.

## Decision Drivers

- A template is validated by the same engine as a workflow.
- A distributed template must not smuggle a reference to something on the target install.
- Templates are data that will be distributed outside the repo, so their texts cannot live
  in the app's message catalogs.
- Substitution must never reinterpret operator prose.

## Considered Options

- **A — A complete graph with `slot:` placeholders in designated fields, a declared slot
  list, structural substitution**
- **B — String templating over serialized JSON**
- **C — Templates as code or generators**

## Decision Outcome

Chosen option: **A**.

- **A `TemplateManifest` is a complete `WorkflowGraph`** plus metadata and a slot
  declaration. Instantiation substitutes a mapping and hands an ordinary graph to the normal
  validate and publish path.
- **Three grammars, kept disjoint:**
  - `slot:<kind>:<key>` in the six ref fields only (agent, action, role principal, human
    channel, `say` channel, trigger event), for the five closed kinds `agents`, `actions`,
    `roles`, `events`, `channels`; resolved once at instantiation.
  - `slot:text:<key>` in the two prose fields `step.prompt` and `human.message` only;
    resolved once at instantiation from the mapping or a declared default.
  - `{{ctx.path}}` / `{{steps.<id>.<field>}}` run tokens; they survive into the workflow and
    are rendered per run. The grammar lives once in `conductor-core/runTokens.ts`, shared by
    authoring-time validation and the runtime.
- **Substitution is a structural walk of designated fields, never a string replace over
  JSON.** Ref values are trimmed before publish.
- **An unresolved run token has a per-field policy** (`runInterpolation.ts`): a visible dash
  in `human.message` (a person reads it), empty in `prompt`, action `input` and `agentId`
  (a model, a machine or a lookup reads it). A new interpolated field must choose its policy.
- **Integrity gate** (`checkTemplateManifest`): metadata present, the graph passes
  structural validation, no duplicate slot keys, every placeholder declared and every
  declared slot used, version an integer of at least 1. In **strict mode**, the import gate
  for plugin and hub sources, any concrete ref left in a ref field is an error.
- **Localization travels with the manifest:** `LocalizedText` is a string or
  `{ en, de?, … }` with `en` required as the fallback.
- **Three sources behind one viewer-scoped catalog:** bundled files, plugin-contributed and
  user-authored templates. On an id collision bundled wins over plugin over user. A broken
  bundled file is skipped with a log line; a CI test over the shipped catalog is the hard
  gate.
- **User templates are versioned append-only** and carry a review status. `shared`,
  `pending` and one's own are visible; another author's `private` template is hidden. Every
  operator can review, because the operator API has one tier. Edits are author-only.
- **Instantiation telemetry is anonymous and append-only;** a workflow keeps its template
  id and version, which yields an informational "update available" hint.
- **Chat only proposes.** The builder agent may suggest at most three visible templates with
  prefills checked server-side; nothing is instantiated from chat.

### Consequences

- 🟢 **Good:** Templates work on any install and are checked before they are offered.
- 🟢 **Good:** Operator prose is never rewritten by a substitution it did not ask for.
- 🔴 **Bad:** Three placeholder syntaxes for a template author to tell apart.
- 🔴 **Bad:** Bundled and user templates may pin install-local refs on purpose; such a
  template does not travel.
- 🔴 **Bad:** With a single operator tier, any operator can approve any pending template.
- ⚪ **Neutral:** Event slots are free text with suggestions
  ([ADR-0042](0042-conductor-event-ids-belong-to-the-sender.md)).

## Pros and Cons of the Options

### A — Slot placeholders in designated fields

- 🟢 Validatable, structural, portable.
- 🔴 A closed set of fields; a new ref field must be added to the walk.

### B — String templating over JSON

- 🟢 Trivial to implement.
- 🔴 A placeholder-looking substring in a prompt gets replaced; values can break the JSON.

### C — Templates as code

- 🟢 Arbitrary parameterization.
- 🔴 Distributed code in the kernel; not checkable before use.

## More Information

- Code: `middleware/packages/conductor-core/src/{template,textSlots,runTokens,localizedText}.ts`;
  `middleware/src/conductor/{templateCatalog,templateStore,templateRoutes,templateHints,runInterpolation}.ts`,
  `templates/*.json`, migration `0006_templates.sql`.
- Tests: `packages/conductor-core/test/{template,templateV2}.test.ts`,
  `middleware/test/conductorTemplateCatalog.test.ts`, `conductorTemplateRoutes.test.ts`,
  `conductorTemplateStore.test.ts`, `conductorRunInterpolation.test.ts`.
- Related: ADR-0042, [ADR-0129](0129-conductor-ephemeral-workflows-only-from-curated-patterns.md),
  [ADR-0131](0131-conductor-pure-engine-decides-the-kernel-performs.md). Border: plugin packaging (ADR-0001).
