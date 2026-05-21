---
description: "Task list for the Privacy Shield v4 — Data-Plane Boundary feature"
---

# Tasks: Privacy Shield v4 — Data-Plane Boundary

**Input**: Design documents in `/specs/001-privacy-shield-v4/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/dataset-store-and-digest.md, contracts/shape-classifier.md,
contracts/verb-api.md

**Tests**: Test tasks ARE included — the spec and the Omadia Constitution make
test-green a non-negotiable gate (the on-the-wire confidentiality harness, the
SC verification, boot smoke tests).

**Organization**: Grouped by user story (US1–US9) so each ships as an
independently testable increment in priority order. US numbers map to the
handoff §8 GitHub issues: US1→#v4-1, US2→#v4-2, US3→#v4-3, US4→#v4-7,
US5→#v4-4, US6→#v4-5, US7→#v4-6, US8→#v4-8, US9→#v4-9.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: may run in parallel (different files, no dependency)
- **[Story]**: owning user story
- File paths are repo-relative.

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Create the v4 module sub-tree at
  `middleware/packages/harness-plugin-privacy-guard/src/v4/` (`datasetStore.ts`,
  `shapeClassifier.ts`, `digest.ts`, `verbs/`, `materializer.ts`,
  `pseudonym.ts`, `types.ts` — empty stubs + barrel) and wire it into the
  package's build.
- [ ] T002 [P] Add the v4 feature flag (config flag, default **off**) and a
  `isV4Enabled(agentId)` accessor; document the flag in the privacy-guard
  `manifest.yaml` / config schema.
- [ ] T003 [P] Confirm Node 22.12.0 toolchain (`.nvmrc`), `node:test`, and
  ESLint resolve for the new `v4/` sub-tree.
- [ ] T004 [P] Build the multi-shape test fixture set under
  `harness-plugin-privacy-guard/src/v4/fixtures/` — incl. the live
  `hr.leave` shape, an all-sensitive shape, an empty result, a non-tabular
  result, and a fresh never-before-seen shape (for SC-004).

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: the design review is the blocking prerequisite — no v4 code is
written until the three contract documents are signed off.

- [ ] T005 Design-review sign-off (handoff Phase 0) on
  `contracts/dataset-store-and-digest.md`, `contracts/shape-classifier.md`, and
  `contracts/verb-api.md` — Digest format, Classifier rules, Verb API surface.
- [ ] T006 Author the v4 contract types in
  `harness-plugin-privacy-guard/src/v4/types.ts` (`Dataset`, `DatasetSchema`,
  `FieldClassification`, `Digest`, `FieldDigest`, `VerbInvocation`,
  `VerbResult`, `RenderDirective`, `PseudonymMap`) and export them from the
  package `index.ts` as its public API surface.

**Checkpoint**: contracts frozen and types published — US1–US9 may begin.

---

## Phase 3: User Story 1 - Tool Results Are Interned, Never Serialized to the LLM (P1) 🎯 MVP foundation

**Goal**: A turn-scoped Dataset Store; `internToolResult` stores real rows
server-side behind a `datasetId`; `finalizeTurn` drops them.

**Independent Test**: Intern multi-shape fixtures; confirm `{ datasetId, digest }`
returned, rows retrievable server-side, `finalizeTurn` drops every dataset.

- [ ] T007 [US1] Implement the `DatasetStore` (`intern`/`put`/`get`/
  `finalizeTurn`) as turn-scoped state inside the privacy-guard plugin instance
  — no module-scope state — in `src/v4/datasetStore.ts`.
- [ ] T008 [US1] Implement `internToolResult`: parse `rawResult` into
  `{ rows, schema }`, handle non-tabular shapes, register the `Dataset`.
- [ ] T009 [US1] Implement the intern-time size bound (reuse the
  `MAX_OUTPUT_CHARS`-style limit); set `provenance.truncated` + `Digest.truncated`
  (C4).
- [ ] T010 [US1] Test: intern each fixture shape; assert rows retrievable via
  `get`, `finalizeTurn` drops every dataset, truncation flags set for an
  over-bound result, non-tabular result interned without error (US1 acceptance
  scenarios 1–4).

**Checkpoint**: raw tool results land server-side behind a `datasetId`.

---

## Phase 4: User Story 2 - Deny-by-Default Shape Classifier (P1)

**Goal**: Every field classified `safe-cleartext` / `sensitive-masked` from JSON
shape + column statistics alone; unknown ⇒ masked.

**Independent Test**: Classify the multi-shape fixture set; assert the allowlist
S1–S5, free text/unique strings masked, unknown shapes masked, Presidio booster
one-way.

- [ ] T011 [US2] Implement column value statistics (`distinctCount`,
  `cardinalityRatio`, `uniquePerRow`, `valueShape`) in `src/v4/shapeClassifier.ts`.
- [ ] T012 [US2] Implement the `safe-cleartext` allowlist S1–S5 incl. the S5
  vs. masked-name disambiguation by value shape, per
  `contracts/shape-classifier.md`.
- [ ] T013 [US2] Wire the detector booster: call the existing PII detectors
  (in-package regex + the `privacy.detector@1` registry) as a **one-way**
  value-level hint — a hit forces `sensitive-masked`, a miss never promotes (D4).
- [ ] T014 [P] [US2] Make the thresholds (`ENUM_MAX_DISTINCT`,
  `ENUM_MAX_RATIO`, `INLINE_VALUES_MAX_ROWS`) configuration, not constants; tune
  defaults against the `hr.leave` fixture (resolves the §5 NEEDS CLARIFICATION).
- [ ] T015 [US2] Test: each allowlist row S1–S5 positive; free text / unique
  human names / mixed-type / unknown shape all `sensitive-masked`; Presidio
  booster one-way both directions (US2 acceptance scenarios 1–5, SC-005).

**Checkpoint**: every field of any shape gets a deny-by-default verdict.

---

## Phase 5: User Story 3 - The LLM Receives a Digest Instead of Raw Tool Output (P1)

**Goal**: With the v4 flag on, the `tool_result` the LLM receives is the
identity-free Digest.

**Independent Test**: Dispatch a tool with the flag on in `dispatchTool` and
`LocalSubAgent.dispatch`; capture the `tool_result`; assert it is the Digest and
carries no raw row.

- [ ] T016 [US3] Implement `Digest` assembly from a `Dataset` +
  classifications in `src/v4/digest.ts` — uphold invariants I1–I4
  (identity-free, shape-bounded, truncation surfaced, handles-not-content).
- [ ] T017 [US3] Wire the boundary into `harness-orchestrator/src/privacyHandle.ts`
  — route tool results through `internToolResult` when the v4 flag is on.
- [ ] T018 [US3] In `harness-orchestrator/src/orchestrator.ts` `dispatchTool`,
  emit `{ datasetId, digest }` as the `tool_result` (flag on); leave the v2/v3
  path untouched (flag off).
- [ ] T019 [P] [US3] Apply the same boundary in
  `harness-orchestrator/src/localSubAgent.ts` `dispatch` for sub-agent tools.
- [ ] T020 [US3] Call `finalizeTurn` once per turn at the existing v2
  tokenize-map teardown seam.
- [ ] T021 [US3] Test: flag on ⇒ `tool_result` is the Digest, raw rows absent;
  flag off ⇒ v2/v3 path unchanged (SC-009); sub-agent dispatch interned on the
  same boundary (US3 acceptance scenarios 1–4).
- [ ] T022 [US3] Boot smoke test: dev server + log monitor + a request that
  triggers a tool call; confirm the Digest reaches the LLM and the turn completes.

**Checkpoint**: 🎯 G1 is observable end-to-end — the LLM no longer receives raw data.

---

## Phase 6: User Story 4 - On-the-Wire Confidentiality Is Proven, Not Hoped (P1)

**Goal**: An automated harness inspects every LLM-bound payload and asserts zero
identity values.

**Independent Test**: Run the HR-Urlaubsranking turn under the harness; it
collects every LLM-bound payload and fails if any real-name-set value appears.

- [ ] T023 [US4] Implement the on-the-wire harness: intercept every LLM-bound
  payload (system prompt + messages + `tool_result`s) at the Anthropic SDK call
  seam; collect them per turn.
- [ ] T024 [US4] Implement the assertion: given a dataset's real-name set, fail
  if any value appears in any collected payload; report the offending payload +
  value.
- [ ] T025 [US4] Wire the harness as a CI gate (`__tests__/onTheWire.*`) over
  the multi-shape fixtures and the HR-Urlaubsranking turn.
- [ ] T026 [US4] Test: a deliberately-leaking change makes the harness fail and
  name the leak; the clean v4 path passes for every fixture shape (US4 acceptance
  scenarios 1–3, SC-003, SC-006).

**Checkpoint**: confidentiality is a verified property, not an aspiration.

---

## Phase 7: User Story 5 - Server-Side Verb API for Sort, Rank, Group, Aggregate (P1)

**Goal**: `filter/sort/group/aggregate/top_n/select/count/join` run server-side
on real datasets; the LLM composes them as tool calls.

**Independent Test**: Compose `sort` → `top_n` over the `hr.leave` dataset;
compare to a trusted reference over the raw rows — identical ranking.

- [ ] T027 [US5] Implement the bounded predicate grammar + evaluator
  (`eq/ne/lt/lte/gt/gte/in/between/and/or/not`) with validation P1–P4 in
  `src/v4/verbs/predicate.ts`.
- [ ] T028 [P] [US5] Implement `filter`, `select`, `count` in `src/v4/verbs/`.
- [ ] T029 [P] [US5] Implement `sort`, `top_n` (order-critical) in
  `src/v4/verbs/`.
- [ ] T030 [P] [US5] Implement `group`, `aggregate`, `join` (identity-critical;
  keys restricted to `safe-cleartext` fields / handles) in `src/v4/verbs/`.
- [ ] T031 [US5] Build the verb registry + expose verbs to the LLM as
  individual tool calls; each returns a `VerbResult` registered via
  `DatasetStore.put` (`src/v4/verbs/index.ts`).
- [ ] T032 [US5] Test: each verb against fixtures; composition chains resolve;
  predicate over a `sensitive-masked` field rejected; `group`/`join` on a masked
  key rejected; `sort` → `top_n` equals a trusted reference (US5 acceptance
  scenarios 1–5, SC-007).

**Checkpoint**: G2 holds — the LLM composes; trusted code executes.

---

## Phase 8: User Story 6 - Materializer Renders the Final Answer from Ground Truth (P1)

**Goal**: A render directive `{ datasetId, columns, format }` is filled
server-side from the real dataset into the channel output.

**Independent Test**: Drive the HR-Urlaubsranking turn; the channel answer shows
real complete names with correct ranks; the on-the-wire harness still reports
zero identity values.

- [ ] T033 [US6] Generalize
  `middleware/src/plugins/routines/routineTemplateRenderer.ts` from pre-defined
  routine templates to ad-hoc render directives — without breaking the routine
  path (`routineOutputTemplate.ts` shared primitives).
- [ ] T034 [US6] Implement the Materializer in `src/v4/materializer.ts`:
  resolve `datasetId` via `DatasetStore.get`, render real values of `columns`
  (incl. `sensitive-masked`) into the channel-bound output.
- [ ] T035 [US6] Implement render-directive validation: reject an unknown
  `datasetId`, an unresolved column, or a format that does not fit the shape
  (FR-019).
- [ ] T036 [US6] Wire the final-answer path so the LLM emits PII-free prose +
  a render directive and the Materializer produces the channel output (real PII
  never passes back through the LLM).
- [ ] T037 [US6] Test: directive renders real values server-side; routine path
  still green; unknown datasetId/column rejected; on-the-wire harness still
  zero-leak for the rendered turn (US6 acceptance scenarios 1–4).

**Checkpoint**: 🎯 MVP — the HR-Urlaubsranking case produces a real, correct,
leak-free answer end-to-end. The P1 §Success-Criteria shape is met.

---

## Phase 9: User Story 7 - Pseudonym Projection for Individual-Level Prose (P2)

**Goal**: A gated projection replaces `sensitive-masked` fields with stable
realistic pseudonyms for per-person prose; resolved back at materialization.

**Independent Test**: Request an answer needing per-person prose; the LLM sees
stable pseudonyms, none equal a real different person, the Materializer resolves
them to real names.

- [ ] T038 [US7] Scope the actual demand from real HR/agent transcripts
  (resolves research C6) before building — size the projection to real need.
- [ ] T039 [US7] Implement `PseudonymMap` + the projection in
  `src/v4/pseudonym.ts`: stable per-individual pseudonyms drawn through the
  deny-by-default filter, fake pool drawn against the dataset's real-name set
  (C5).
- [ ] T040 [US7] Gate the projection — released only when an operation
  explicitly needs individual-level prose; off by default (FR-022).
- [ ] T041 [US7] Resolve pseudonyms back to real names in the Materializer at
  render time; never leak fake or real values to the LLM wire.
- [ ] T042 [US7] Test: stable pseudonyms, no collision with the real-name set,
  Materializer resolves them, projection stays off when not needed; on-the-wire
  harness zero-leak (US7 acceptance scenarios 1–5).

**Checkpoint**: individual-level prose is supported without weakening the wire.

---

## Phase 10: User Story 8 - HR Agent Cut-Over and Acceptance Run (P2)

**Goal**: The HR agent runs on v4; the acceptance case is measured against the
§Success Criteria.

**Independent Test**: Flag on for the HR agent; ask "Wer hat dieses Jahr den
meisten Urlaub?"; verify SC-001/SC-002 (answer) and SC-003 (wire).

- [x] T043 [US8] Inbound user PII — RESOLVED (research C7): the user's own
  chat message is user-disclosed input and is NOT masked; no v4-native inbound
  masker is built. No code change.
- [ ] T044 [US8] Flip the v4 feature flag on for the HR agent.
- [ ] T045 [US8] Acceptance run: "Wer hat dieses Jahr den meisten Urlaub?" —
  verify real complete names, correct ranks, no duplicated / no invented people
  (SC-001, SC-002).
- [ ] T046 [US8] Acceptance run: the on-the-wire harness reports zero identity
  values for the turn (SC-003); a fresh un-annotated tool is interned +
  classified by construction (SC-004).
- [ ] T047 [US8] Boot smoke test of the full HR agent v4 deployment shape
  (dev server + log monitor + the Urlaubsranking request).

**Checkpoint**: v4 is proven live on the failure of record.

---

## Phase 11: User Story 9 - Remove v2/v3 Tokenization Machinery (P3)

**Goal**: Delete the v2 `selfAnonymization` machinery and v3 stable-id
tokenization; adapt the Privacy Receipt. `ensureWellFormedParams` is kept.

**Independent Test**: Remove the code; run the full middleware suite + a boot
smoke test; confirm green and the Privacy Receipt renders v4 fields.

**Execution plan (pre-recon 2026-05-21) — leaves-first, build green per stage.**
⚠️ All-or-nothing: a partial removal leaves the v2 (flag-off) path broken —
there is no safe half-way state. Run the stages back-to-back in one pass.

1. **Orchestrator → v4-only**: delete the 5 v2 post-loop steps and the 4
   `apply*` method defs (`applyOutputValidator` / `applyEgressFilter` /
   `applyAntiSelfAnonymization` / `applyPostEgressScrub`, ~lines 1188–1488);
   the v2 calls in `dispatchTool` + `LocalSubAgent.dispatch` (`processToolInput`,
   `applyStableIdPrepass`, `processToolResult`); the direct `messages.create`
   v2 path (`applyPrivacyOutboundToParams` / `restorePrivacyInResponse`); drop
   now-dead imports/helpers (`collectEgressSlots`, `orphanPlaceholderCheck`, …).
2. **`streaming.ts`**: strip v2 from `streamMessageEvents`; keep
   `ensureWellFormedParams`.
3. **`privacyHandle.ts`**: drop the 9 v2 methods from `PrivacyTurnHandle` plus
   `applyPrivacyOutboundToParams` / `restorePrivacyInResponse` /
   `streamingTokenBoundary`; keep `ensureWellFormedParams` + the v4 methods.
4. **`plugin-api`**: remove the v2 methods from the `PrivacyGuardService`
   interface (`privacyReceipt.ts`).
5. **`service.ts`**: v4-only rewrite — keep the v4 store/verb/render methods +
   `finalizeTurn`; delete the ~1000 lines of v2 transform logic + helpers.
6. **Delete files**: `selfAnonymization.ts`, `stableIdTokenization.ts`,
   `tokenizeMap.ts` (verify each v2-only — also assess `egressFilter.ts`,
   `policyEngine.ts`, `spanHelpers.ts`); adapt `receiptAssembler.ts` →
   `PrivacyReceiptV4`; update `index.ts` exports.
7. **Channel tendril**: `finalizeTurn` then returns `PrivacyReceiptV4` —
   adjust every channel receipt renderer (Teams Adaptive-Card, Web inline
   disclosure) that consumes the `PrivacyReceipt` shape.
8. **Flag**: remove `PRIVACY_SHIELD_V4` — v4 becomes unconditional
   (`featureFlag.ts` deleted; `isV4Enabled` call sites dropped).
9. Full build + full `node:test` suite + boot smoke test green; update specs.

Decisions in force: research **C7** (no inbound masker — user input is
user-disclosed) and **C8** (this runs after the intensive live test).

- [ ] T048 [US9] Delete the v2 stream-tokenization path: `processToolResult`
  tokenize path, `processInbound` restore, `streamingTokenBoundary`
  (`harness-orchestrator/src/streaming.ts` and privacy-guard `service.ts`).
- [ ] T049 [US9] Delete `selfAnonymization.ts` in full — Phase A.0/A.1/A.2,
  `restoreSelfAnonymizationLabels`, `restoreOrScrubRemainingTokens`, the
  Mitarbeiter-/Employee-/Person-/Platz-/Rang-pattern restorers.
- [ ] T050 [US9] Delete v3 stable-id: `stableIdTokenization.ts`,
  `tokenizeMap.ts`, `applyStableIdTokenization`, `applyStableIdPrepass`,
  `tokenForStableId`, the `piiFields` annotations and Odoo helpers.
- [ ] T051 [US9] Remove or simplify the now-redundant Output-Validator
  token-leak retry path; document what validation remains.
- [ ] T052 [US9] Adapt `receiptAssembler.ts` — the Privacy Receipt reports
  datasets interned, fields masked per classification, and verbs executed,
  instead of token counts (FR-028).
- [ ] T053 [US9] Verify `ensureWellFormedParams` (surrogate hardening, PR #118)
  is still present and wired — it is orthogonal and explicitly retained.
- [ ] T054 [US9] Test: full middleware suite + boot smoke test green after
  removal; Privacy Receipt renders v4 fields (US9 acceptance scenarios 1–5,
  SC-010).

**Checkpoint**: no dead blocklist code remains; v4 is the only privacy path.

---

## Phase 12: Polish & Cross-Cutting Concerns

- [ ] T055 [P] Structured-logging audit across interning, classification, verb
  execution, and materialization seams (FR-029).
- [ ] T056 [P] Update `docs/harness-platform/` and the Notion architecture
  subpages for the Data-Plane Boundary; mark the v4 handoff superseded-by-spec.
- [ ] T057 Run the full §Success-Criteria sweep SC-001…SC-010 end-to-end.
- [ ] T058 Cut over remaining agents from v4-flag-off to v4-flag-on, one at a
  time, each with its own acceptance run.

---

## Dependencies & Execution Order

### Phase / Story dependencies

- **Setup (P1) → Foundational (P2)**: strictly sequential — no v4 code before
  the contract sign-off (T005) and published types (T006).
- **US1 → US2 → US3**: the Digest (US3) needs the classifier (US2), which needs
  the store (US1). Sequential.
- **US4** lands with **US3** — the harness needs a wire payload to inspect; it
  must be green before US5 builds further on the boundary.
- **US5 (Verb API)** depends on US1 (datasets) + US3 (digests for verb outputs).
- **US6 (Materializer)** depends on US5 (it renders a verb-chain output) and
  US1 (`DatasetStore.get`).
- **US7** depends on US2 (classifier) + US6 (resolves at materialization);
  T038 transcript-scoping gates the rest of US7.
- **US8** depends on the full P1 chain US1–US6 + US4's harness.
- **US9** depends on **US8** passing acceptance — removal is safe only once v4
  is proven on the failure of record.

### Priority cascade

- **P1 (MVP)**: US1 → US2 → US3 ∥ US4 → US5 → US6 — the HR-Urlaubsranking case
  produces a real, correct, leak-free answer.
- **P2**: US7 → US8 — individual-level prose + the live cut-over.
- **P3**: US9 — delete v2/v3.

### Parallel opportunities

- T002–T004 (setup) are independent — parallel.
- T028–T030 (verb groups) are different files — parallel.
- T014 (threshold tuning) runs alongside the rest of US2.
- T019 (sub-agent wiring) is parallel with T018 once T017 lands.
- Polish T055/T056 are parallel.

## Implementation Strategy

1. **Contracts first**: Setup → design-review sign-off → publish types. Nothing
   is written against an unsigned contract.
2. **MVP**: US1 → US2 → US3 ∥ US4 → US5 → US6. Stop, run the §Success-Criteria
   shape against the HR-Urlaubsranking case, demo.
3. **Cut-over**: US7 → US8. Flip the flag for the HR agent, measure live.
4. **Cleanup**: US9. Delete v2/v3 only after US8 is green.
5. The v4 feature flag stays **off in production** until the full US1–US6 chain
   is in place; SC-009 keeps the flag-off path green throughout P1–P2.
