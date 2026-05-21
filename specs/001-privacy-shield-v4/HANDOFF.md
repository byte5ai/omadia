# Privacy Shield v4 — Implementation Handoff & Documentation

**Date:** 2026-05-21
**Branch:** `claude/quirky-allen-f0cbea` (worktree of `byte5ai/omadia`)
**Status:** US1–US8 + observability **complete, committed, fully green**.
US9 (v2/v3 removal) **deferred** to a dedicated session — see §12.
**Architecture input:** `docs/harness-platform/HANDOFF-2026-05-21-privacy-shield-v4-data-plane-boundary.md`
(the decision that started this work).

This document is both the full implementation documentation and the
session-to-session handoff. The next session should read this first, then
the spec package in this directory.

---

## 1. What the feature is

Privacy Shield v4 replaces the v2/v3 *detect-then-tokenize* privacy approach
with a **Data-Plane Boundary**. Instead of letting raw tool results flow to the
LLM and trying to scrub PII out, v4 inverts the default:

- **G1 — Confidentiality**: a raw tool result is *never* serialized into an
  LLM-bound message. It is interned server-side; the LLM receives only an
  identity-free **Digest**.
- **G2 — Correctness**: identity-/order-critical work (sort, rank, group,
  aggregate, filter, join) runs in trusted server code via a **Verb API**. The
  LLM *composes* verbs; it never *executes* them. The final answer is rendered
  server-side from ground truth.

Both guarantees are structural, not heuristic. The classifier is generic over
JSON shape + value statistics — zero per-tool annotation.

---

## 2. Status snapshot

- **12 commits** on `claude/quirky-allen-f0cbea` (§3).
- **Regression (2026-05-21):**
  - Full workspace build (`npm run build`): **clean**.
  - Full suite (`npm test`): **2563 pass / 0 fail / 7 pre-existing skips** (2570).
  - Lint (`npm run lint`): **clean**.
  - v4 suite: **92 `node:test` tests across 8 files, all green**.
- v4 (`PRIVACY_SHIELD_V4=on`) and the legacy v2/v3 path (flag off) **coexist**,
  flag-controlled. Flag off ⇒ byte-identical v2/v3 behaviour (SC-009 holds).
- **Not yet done:** live LLM-loop verification (the intensive test, §11) and
  US9 v2/v3 removal (§12). The final PR follows US9.

---

## 3. Commit log

| Commit | Scope |
|---|---|
| `c330030` | Spec-Kit specs + `.specify` toolkit; US1 Dataset Store; US2 Shape Classifier |
| `8169134` | US3 — Digest builder + tool-dispatch wiring |
| `e71cbc8` | US4 — on-the-wire confidentiality harness |
| `42a6036` | US5 — Verb API engine (predicate grammar + 8 verbs) |
| `0a93def` | US6 — Materializer |
| `eb29497` | US5 — verb tool surface (tool specs + dispatch) |
| `cadbaef` | US5/US6 — orchestrator integration (verb tools + render swap) |
| `0e8fbb5` | US7 — Pseudonym Projection |
| `b916d3c` | US8 — HR-Urlaubsranking acceptance scaffold |
| `787eccb` | Observability — structured v4 logs (FR-029) |
| `0e54937` | Decisions C7 (inbound) + C8 (US9 timing) |
| `39bb51c` | Pre-recon'd US9 execution plan in `tasks.md` |

---

## 4. Architecture as built

All v4 logic lives in `middleware/packages/harness-plugin-privacy-guard/src/v4/`:

| Module | US | Responsibility |
|---|---|---|
| `types.ts` | — | Contract types: `Dataset`, `DatasetStore`, `Digest`, `Verb*`, `RenderDirective`, `PseudonymMap`; `MAX_INTERN_CHARS`, `MASKED_PLACEHOLDER` |
| `featureFlag.ts` | — | `isV4Enabled()` — reads env `PRIVACY_SHIELD_V4` |
| `datasetStore.ts` | US1 | Turn-scoped Dataset Store: `createDatasetStore`, `internToolResult`, `parseToolResult` (shape normalization + intern-time size bound), `finalizeTurn` |
| `shapeClassifier.ts` | US2 | Deny-by-default classifier: `createShapeClassifier`; allowlist S1–S5 (number/boolean/ISO-date/low-card-enum/opaque-id); one-way `DetectorBooster` |
| `digest.ts` | US3 | `buildDigest` (identity-free; invariant I1 — masked fields carry only a placeholder + count) + `digestToToolResultText` |
| `onTheWire.ts` | US4 | `findIdentityLeaks` / `assertNoIdentityOnWire` — confidentiality assertion over any LLM-bound payload |
| `verbs/predicate.ts` | US5 | Bounded `filter` predicate grammar; `validatePredicate` (P1/P4) + `evaluatePredicate`; `VerbError` |
| `verbs/index.ts` | US5 | `createVerbEngine` — the 8 verbs: filter, sort, top_n, group, aggregate, select, count, join |
| `materializer.ts` | US6 | `materialize` — renders a `RenderDirective` (table/list/scalar) from real rows |
| `pseudonym.ts` | US7 | `createPseudonymMap`, `projectDataset`, `resolvePseudonyms` — gated individual-prose layer |
| `toolDefs.ts` | US5 | `VERB_TOOL_SPECS` + `RENDER_TOOL_SPEC` (LLM tool specs); `dispatchVerbCall`; `parseRenderDirective` |

Constitution I: every module is pure-functional or holds state only in a
turn-scoped instance (the Dataset Store) — no module-scope mutable state.

---

## 5. Data flow — a v4 turn

```
LLM decides to call a tool
  → tool runs → raw result (string)
  → Orchestrator.dispatchTool → PrivacyTurnHandle.internToolResultV4
  → service: DatasetStore.internToolResult → Shape Classifier
  → Dataset { real rows, schema, provenance } held server-side
  → LLM receives the Digest text as the tool_result block  (NO rows on the wire)

LLM composes v4_* verb tool calls against datasetId
  → Orchestrator.dispatchTool short-circuits v4_* → PrivacyTurnHandle.runV4Tool
  → service: VerbEngine runs the verb on real rows → new Dataset + Digest

LLM emits the final answer: v4_render_answer { datasetId, columns, format, prose }
  → service.runV4Tool → Materializer renders REAL values server-side
  → the rendered text is STASHED per turn; the LLM gets only a PII-free confirmation

turn end (chat + chatStream post-loop)
  → privacyHandle.takeRenderedAnswerV4 → swap the stashed text in as the channel answer
  → the v2 token-path post-processing (validator/egress/scrub) is skipped
  → finalizeTurn drops the turn's datasets + stashed answer
```

No agentic-loop surgery — the design is **stash + post-loop swap**.

---

## 6. Orchestrator integration

The orchestrator never imports the privacy-guard package directly — it goes
through `@omadia/plugin-api` (Constitution II). New surface:

- **`PrivacyGuardService`** (`plugin-api/src/privacyReceipt.ts`) — optional v4
  methods: `internToolResultV4`, `runV4Tool`, `takeRenderedAnswerV4`,
  `v4ToolSpecs`.
- **`service.ts`** implements them — holds `Map<turnId, DatasetStore>` +
  `Map<turnId, renderedAnswer>`, gated by `isV4Enabled()`; dropped in
  `finalizeTurn`.
- **`PrivacyTurnHandle`** (`harness-orchestrator/src/privacyHandle.ts`) —
  delegates the four, baking `(sessionId, turnId)`.
- **`Orchestrator.dispatchTool` + `LocalSubAgent.dispatch`** — when v4 is on,
  the raw tool result is interned and the LLM gets the Digest; `v4_*` tool
  calls short-circuit to the verb/render engine.
- **`buildToolsList`** — offers the 8 verb tools + `v4_render_answer` when v4
  is active.
- **Post-loop (chat) + `done` event (chatStream)** — swap in the
  server-materialized answer; skip v2 post-processing for that turn.

---

## 7. Feature flag

`PRIVACY_SHIELD_V4` environment variable. Truthy: `on` / `true` / `1` / `yes`
(case-insensitive). Default (unset) ⇒ v4 fully inert, v2/v3 path unchanged.
There is no per-agent config layer yet — "v4 for the HR agent" means running
that deployment with the env var set. **After US9 the flag is removed** and v4
becomes unconditional.

---

## 8. Test inventory (92 `node:test` tests, `middleware/test/`)

| File | Tests | Covers |
|---|---|---|
| `privacyV4DatasetStore.test.ts` | 19 | parsing, intern bound, store lifecycle |
| `privacyV4ShapeClassifier.test.ts` | 12 | allowlist S1–S5, masking, booster |
| `privacyV4Digest.test.ts` | 7 | identity-free invariant, summaries |
| `privacyV4Service.test.ts` | 8 | service seam: internToolResultV4 / runV4Tool / v4ToolSpecs end-to-end |
| `privacyV4OnTheWire.test.ts` | 5 | leak detection across system/messages/tool_results |
| `privacyV4Verbs.test.ts` | 14 | all verbs + SC-007 correctness-vs-reference |
| `privacyV4Materializer.test.ts` | 8 | table/list/scalar render, guard rails |
| `privacyV4ToolDefs.test.ts` | 12 | verb tool dispatch, render-directive parse |
| `privacyV4Pseudonym.test.ts` | 7 | stable pseudonyms, no collision, round-trip |
| `privacyV4Acceptance.test.ts` | 2 | full HR-Urlaubsranking path against §SC |

Run them: `node --import tsx --test test/privacyV4*.test.ts` (Node 22.22.3).

---

## 9. Decisions (full rationale in `research.md`)

| # | Decision |
|---|---|
| D1–D9 | Deny-by-default boundary; compose-not-execute; allowlist over blocklist; detector as one-way booster; focused Materializer; turn-scoped store; verbs as tool calls; pseudonyms gated; v4 types in privacy-guard |
| C1–C5 | Turn-scoped datasets; verbs as individual tool calls; bounded predicate grammar; `MAX_INTERN_CHARS` bound; pseudonym collision avoidance |
| C6 | Pseudonym-projection prose coverage — scope from transcripts (open) |
| **C7** | **Inbound user PII**: the user's own message is user-disclosed input — NOT masked. FR-023 superseded; no v4 inbound masker is built. |
| **C8** | **US9 timing**: v2/v3 removal runs as its own focused session. |

---

## 10. Environment notes

- **Node 22.22.3** required. The repo's `.nvmrc` pins 22.12.0, but transitive
  deps (`@eslint/config-array`) need ≥22.13 and `.npmrc` has
  `engine-strict=true` — install/build fail on 22.12.0. Use `nvm use 22.22.3`.
- The middleware boots from this worktree on **`:3979`**, web-ui on **`:3300`**.
- **Worktree limitation:** the private byte5 plugins (`harness-integration-odoo`
  etc.) are **not** in this public-repo worktree — only the SEO agent loads.
  The real HR-agent intensive test must run from the main clone
  (`~/sources/odoo-bot`), which has the private Odoo plugins wired.
- `middleware/.env` was copied from the main clone (gitignored, holds secrets).

---

## 11. How to run the intensive live test (operator step)

From the **main clone** (it has the private Odoo/HR plugins):

```bash
cd ~/sources/odoo-bot
git fetch && git checkout claude/quirky-allen-f0cbea
cd middleware && nvm use 22.22.3 && npm install
PRIVACY_SHIELD_V4=on npm run dev          # v4 path
# (without the env var → v2/v3 baseline, for A/B)
```

Ask the HR agent: **"Wer hat dieses Jahr den meisten Urlaub?"** Verify:

- **SC-001** real, complete employee names — no `«TOKEN»`, no partial names,
  no invented labels ("Platz N").
- **SC-002** correct ranks, no duplicated / no invented people.
- **SC-003** capture an LLM-bound payload from the logs and confirm no real
  name appears (or use `assertNoIdentityOnWire`).
- Watch the `[privacy-guard v4]` structured logs (intern / verb / render).

Test the flag-off path too, to confirm the v2/v3 baseline still works.

---

## 12. US9 — the next focused session

US9 removes the v2/v3 machinery and makes v4 unconditional. It is
**all-or-nothing** — a partial removal leaves the v2 (flag-off) path broken.
The pre-recon'd 9-stage plan is in **`tasks.md` Phase 11**:

1. Orchestrator → v4-only (post-loop steps, `apply*` methods, v2 dispatch calls).
2. `streaming.ts` — strip v2 from `streamMessageEvents`.
3. `privacyHandle.ts` — drop the 9 v2 methods.
4. `plugin-api` — remove v2 methods from `PrivacyGuardService`.
5. `service.ts` — v4-only rewrite (delete ~1000 lines of v2 transform logic).
6. Delete `selfAnonymization.ts` / `stableIdTokenization.ts` / `tokenizeMap.ts`
   (+ assess `egressFilter`/`policyEngine`/`spanHelpers`); adapt
   `receiptAssembler.ts` → `PrivacyReceiptV4`; update `index.ts`.
7. **Channel tendril** — `finalizeTurn` then returns `PrivacyReceiptV4`; adjust
   every channel receipt renderer (Teams Adaptive-Card, Web inline disclosure).
8. Remove the `PRIVACY_SHIELD_V4` flag — v4 unconditional.
9. Full build + suite + boot smoke test green; update specs.

`ensureWellFormedParams` (surrogate hardening, PR #118) is **kept** — orthogonal.

---

## 13. For the next session — start here

1. You are on branch `claude/quirky-allen-f0cbea`. Run `nvm use 22.22.3`.
2. Read this file, then `spec.md` / `research.md` / `tasks.md` / `contracts/`.
3. Recommended order: **the intensive live test (§11) first**, then **US9 (§12)**
   as a single back-to-back pass, then **Polish + the final PR**.
4. Everything through US8 + observability is committed and green — nothing is
   lost; US9 is pure debt-removal.
