# 0257 — Recall and curation services resolve only for the boundary implementers; `entityRefBus` is publish-only for plugins

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Maintainers (wave 5, cluster W30), from #2231.
- **Supersedes:** —
- **Refines:** [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md) (its
  residual "other recall and curation services"),
  [ADR-0053](0053-service-access-by-declaration-one-provider-per-capability.md).

## Context and Problem Statement

ADR-0044 bounded `knowledgeGraph@1`, `processMemory@1` and `memoryStore@1`. A later step made
`topicClustering@1` kernel-only. The same providers publish more services, and a plugin that
declares one gets it raw. `KERNEL_ONLY_SERVICE_NAMES` held only `privacyFieldSamples`.

| Service | Provider | What it reads or changes |
|---|---|---|
| `contextRetriever` | orchestrator-extras | recall over turns and memory for a scope the caller names |
| `sessionBriefing` | orchestrator-extras | a session's turns for a scope the caller names |
| `palaiaExcerpt` | orchestrator-extras | excerpts of curated memory |
| `bulkPromotion`, `bulkInconsistencyDetect`, `bulkMergeDetect`, `bulkExcerptMergeDetect` | orchestrator-extras | tenant review jobs over every account's memory |
| `inconsistencyDetector`, `mergeCandidateDetector` | orchestrator-extras | write review nodes for any memory node id the caller names |
| `nudgeProviders` | orchestrator-extras | the queued nudge providers of other plugins |
| `graphLifecycle` | knowledge-graph-neon | graph-wide purge and re-embed |
| `entityRefBus` | knowledge-graph-* | `publish` a ref into the current turn; `beginCollection(turnId)` reads any turn's refs |

An audit on 2026-11-26 checked the kernel packages and the Hub plugin repositories at
`origin/main`:

- Only the orchestrator, a boundary implementer, consumes `contextRetriever`,
  `sessionBriefing`, `palaiaExcerpt`, `nudgeProviders` and `entityRefBus`.
- The kernel's admin routes read the bulk services and `graphLifecycle` through
  `serviceRegistry.get`.
- integration-odoo and integration-confluence consume `entityRefBus` and call only
  `publish`.

Which of these may a plugin resolve?

## Decision Drivers

- A `requires:` line costs an upload nothing (ADR-0044); it must not buy a read across
  users or agents.
- integration-odoo and integration-confluence keep publishing entity refs.
- The orchestrator keeps its recall wiring.

## Considered Options

- **A — Boundary-only names plus a bounded bus.** The recall and curation names resolve
  only for `GRAPH_BOUNDARY_IMPLEMENTERS` (bundled). `entityRefBus` comes in a publish-only
  form for everyone else.
- **B — Kernel-only for everyone,** with the orchestrator moving to the kernel registry.
- **C — Bounded forms per service.**

## Decision Outcome

Chosen option: **A**. It changes no consumer, and none of these services has a call a
plugin needs beyond `publish`.

- **`BOUNDARY_ONLY_SERVICE_NAMES`** (`pluginServiceGrants.ts`): `contextRetriever`,
  `sessionBriefing`, `palaiaExcerpt`, `bulkPromotion`, `bulkInconsistencyDetect`,
  `bulkMergeDetect`, `bulkExcerptMergeDetect`, `inconsistencyDetector`,
  `mergeCandidateDetector`, `nudgeProviders`, `graphLifecycle`.
  - `classifyServiceGrant` answers `kernel-only` for these unless
    `holdsRawGraphServices` (id on the implementer list and `origin === 'bundled'`).
  - The plugin sees `ServiceNotDeclaredError`, as for every kernel-only name. This covers
    `replace` too.
  - An upload claiming an implementer id gets nothing (#789).
- **`entityRefBus@1`** joins `BOUNDED_GRAPH_SERVICE_NAMES`. The bounded form
  (`boundEntityRefBus`) passes `publish`: the bus tags the ref with the calling turn and
  drops it outside one. `beginCollection` throws `GraphServiceRefusedError`
  (`kernel-only`).
- **The implementer list** moved to `graphBoundaryImplementers.ts`, so the grant gate can
  read it without loading the bounded forms. `boundedGraphServices.ts` re-exports it.

### Consequences

- 🟢 **Good:** ADR-0044's last service residual is closed. No plugin resolves a recall or
  curation service, or another turn's entity refs.
- 🟢 **Good:** No consumer changes. The gate test pins every name for an upload, a shadow
  of an implementer id, and the bundled orchestrator.
- 🔴 **Bad:** A future plugin that needs recall must get a bounded form and an ADR first.
- ⚪ **Neutral:** The per-turn helpers from the same provider (`captureFilter`,
  `factExtractor`, `topicDetector`, the status services) work on the input they are given
  and read no other account's data. They stay declarable.
- ⚪ **Neutral:** `provide` stays ungated (ADR-0044's residual): a plugin may still register
  one of these names on a host that has no provider.

## Pros and Cons of the Options

### A — Boundary-only plus bounded bus

- 🟢 No consumer changes; one set to keep.
- 🔴 A second list next to `KERNEL_ONLY_SERVICE_NAMES`.

### B — Kernel-only for all

- 🟢 Simplest rule.
- 🔴 The orchestrator plugin consumes them through `ctx.services`; it would need new wiring.

### C — Bounded forms per service

- 🟢 Keeps the services usable for plugins.
- 🔴 No plugin uses them; code without a caller.

## More Information

- Code: `middleware/src/platform/pluginServiceGrants.ts`, `graphBoundaryImplementers.ts`,
  `boundedGraphServices.ts` (`boundEntityRefBus`).
- Tests: `test/pluginServiceGrantGate.test.ts`.
