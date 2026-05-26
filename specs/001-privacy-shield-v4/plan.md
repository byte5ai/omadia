# Implementation Plan: Privacy Shield v4 — Data-Plane Boundary

**Branch**: `feat/privacy-shield-v4` | **Date**: 2026-05-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-privacy-shield-v4/spec.md`

## Summary

Replace the detect-then-allow tokenization of Privacy Shield v2/v3 with a
**Data-Plane Boundary**. A tool result is interned into a turn-scoped,
server-held **Dataset Store**; the LLM receives only an identity-free **Digest**.
A deny-by-default **Shape Classifier** decides, from JSON shape + column
statistics alone, which fields are `safe-cleartext` and which are
`sensitive-masked` — unknown fields are over-masked, never leaked. The LLM
composes a server-side **Verb API** (`filter/sort/group/aggregate/top_n/select/
count/join`) over `datasetId`s; it never sees a row. The final answer is a
render directive that a server-side **Materializer** — a generalization of the
existing `routineTemplateRenderer` — fills from ground truth into the
channel-bound output. The whole path is feature-flagged; v2/v3 stay
additive-inactive until the HR-agent cut-over passes, then are deleted.

## Technical Context

**Language/Version**: TypeScript 5.x, strict mode; Node 22.12.0 (pinned `.nvmrc`)
**Primary Dependencies**: existing `harness-*` monorepo packages —
`harness-plugin-privacy-guard` (owns v4 logic), `harness-orchestrator`
(`dispatchTool`, `localSubAgent`, `privacyHandle`, `streaming`), the PII
detectors reachable via the `privacy.detector@1` registry (the in-package
regex detector + the `plugin-privacy-detector-presidio` / `-ollama` plugins),
the Anthropic SDK, and
`middleware/src/plugins/routines/routineTemplateRenderer.ts` (reused as the
Materializer)
**Storage**: in-memory, turn-scoped — the Dataset Store mirrors the v2
tokenize-map lifecycle. **No database** is introduced for v1.
**Testing**: `node:test` (`node --test`, files flat under
`middleware/test/*.test.ts`), the new on-the-wire confidentiality harness
(US4); the live HR-agent acceptance run (US8) is executed by the operator
**Target Platform**: Linux server on Fly.io
**Project Type**: web-service (TypeScript monorepo middleware)
**Performance Goals**: Digest size depends on row count + schema, not row
content length (SC-008); interning bounded by a new `MAX_INTERN_CHARS` limit
**Constraints**: zero identity values on the LLM wire enforced structurally
(SC-003/SC-006); zero per-tool annotation (SC-004); generic over JSON shape — no
domain knowledge anywhere in the classifier
**Scale/Scope**: one privacy plugin reworked; two orchestrator dispatch seams
wired; one renderer generalized; v2/v3 machinery (~5 files) removed at the end

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Compliance |
|---|---|
| I. Plugin Isolation & Lifecycle | The Dataset Store is **turn-scoped runtime state** — created and dropped per turn, held inside the privacy-guard plugin's instance/scope, never at module scope. `finalizeTurn` is the explicit release seam (FR-003). |
| II. Contract-First Extensibility | The Digest format, the `internToolResult` signature, the Verb API surface, and the Render Directive are defined once in `contracts/` and exported from a single owning package (`harness-plugin-privacy-guard`); the orchestrator consumes them through the existing privacy capability seam, never re-declaring them. |
| III. Server-Side Business Logic | **Core driver.** Guarantee G2 *is* this principle: sort, rank, group, aggregate, filter, join run in trusted server code (the Verb API); the LLM composes, never executes. The final answer is materialized server-side from ground truth (FR-013, FR-016). |
| IV. Test-Green Gate | The on-the-wire confidentiality harness (US4) is itself a CI gate; each slice carries an independent test and a boot smoke test; SC-009 keeps the flag-off path green throughout. |
| V. Privacy by Capability | v4 makes confidentiality a **structural property of the boundary** (deny-by-default), not a heuristic detector check sprinkled through call sites — the strongest possible expression of this principle. |
| VI. Observability & Diagnostics | FR-029 requires structured logs on interning, classification, verb execution, and materialization; the Privacy Receipt (FR-028) is the user-facing diagnostic. |

No violations. The Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-privacy-shield-v4/
├── spec.md                          # Feature specification (the WHAT)
├── plan.md                          # This file (the HOW)
├── research.md                      # Resolved design decisions & rejected alternatives
├── data-model.md                    # Entities & in-memory runtime structures
├── contracts/
│   ├── dataset-store-and-digest.md  # internToolResult, Dataset Store, Digest
│   ├── shape-classifier.md          # deny-by-default classification rules
│   └── verb-api.md                  # Verb API surface, predicate grammar, render directive
└── tasks.md                         # Task breakdown by user story
```

### Source Code (repository root)

```text
middleware/packages/harness-plugin-privacy-guard/src/
├── v4/
│   ├── datasetStore.ts        # US1 — turn-scoped store, internToolResult, finalizeTurn
│   ├── shapeClassifier.ts     # US2 — deny-by-default classification
│   ├── digest.ts              # US3 — Digest assembly from a Dataset + classification
│   ├── verbs/                 # US5 — filter/sort/group/aggregate/top_n/select/count/join
│   │   ├── index.ts           #        verb registry + tool-call surface
│   │   └── predicate.ts       #        bounded predicate grammar + evaluator
│   ├── materializer.ts        # US6 — render directive → routineTemplateRenderer
│   ├── pseudonym.ts           # US7 — Pseudonym Projection + server-held map
│   └── types.ts               # contract types (Dataset, Digest, Verb, RenderDirective)
├── regexDetector.ts           # US2 — existing detectors reused as a one-way booster
├── receiptAssembler.ts        # US9 — adapt the Privacy Receipt to v4 fields
├── plugin.ts / index.ts       # US3 — expose the v4 boundary on the privacy capability
├── selfAnonymization.ts       # US9 — DELETED after cut-over
├── stableIdTokenization.ts    # US9 — DELETED after cut-over
└── tokenizeMap.ts             # US9 — DELETED after cut-over (v2/v3 only)

middleware/packages/harness-orchestrator/src/
├── privacyHandle.ts           # US3 — route dispatch through internToolResult when flag on
├── orchestrator.ts            # US3 — dispatchTool: emit {datasetId,digest} as tool_result
├── localSubAgent.ts           # US3 — dispatch: same boundary for sub-agent tools
└── streaming.ts               # US9 — drop the streamingTokenBoundary v2 path

middleware/src/plugins/routines/
├── routineTemplateRenderer.ts # US6 — generalized to ad-hoc render directives
└── routineOutputTemplate.ts   # US6 — shared template primitives

middleware/test/privacyV4-*.test.ts          # node:test unit + integration per slice
middleware/test/privacyV4-onTheWire.test.ts  # US4 — on-the-wire confidentiality harness
```

**Structure Decision**: Single web-service monorepo. All v4 logic lands in a new
`v4/` sub-tree of the **existing** `harness-plugin-privacy-guard` package — the
plugin that already owns the privacy capability — rather than a new package,
because it has exactly one consumer (the orchestrator's privacy seam) and a
separate package would be organisational-only. The v4 contract types
(`Dataset`, `Digest`, `Verb`, `RenderDirective`) are exported from that package's
`index.ts` as its public API surface and imported by the orchestrator through
the existing `privacyHandle` capability seam — a single source of truth, not a
re-declared cross-package contract, so Constitution II holds. The Materializer
is a generalization of the in-tree `routineTemplateRenderer`, not a new
renderer.

## Phasing

Implementation follows the user-story priority cascade in `tasks.md`, which maps
onto the handoff's migration phases:

- **Phase 0 — Design review**: sign-off on the three `contracts/` documents
  (Digest format, Classifier rules, Verb API surface) and on where the v4
  contract types live. No code.
- **P1 (MVP)**: US1 Dataset Store → US2 Shape Classifier → US3 Digest +
  dispatch wiring → US4 on-the-wire harness → US5 Verb API → US6 Materializer.
  End state: the HR-Urlaubsranking case produces a real, correct answer with
  zero identity values on the wire — the §Success-Criteria acceptance shape.
- **P2**: US7 Pseudonym Projection → US8 HR agent cut-over + acceptance run.
  End state: individual-level prose is supported; v4 is proven live on the
  failure of record.
- **P3**: US9 — delete the v2 `selfAnonymization` machinery and v3 stable-id
  tokenization; adapt the Privacy Receipt.

The feature flag (FR-026) stays **off in production** until the entire US1–US6
chain is in place; it is flipped on for the HR agent only at US8. v2/v3 remain
additive-inactive (no behaviour change while the flag is off) through P1–P2 and
are removed in US9.

## Complexity Tracking

> No constitution violations. No entries.
