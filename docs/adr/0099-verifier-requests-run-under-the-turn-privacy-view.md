# 0099 — The answer verifier's model requests run under the turn's privacy view, handed over before finalize

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  implemented in #1265, extended in S3-D (#1613) and the verifier fixes named in
  `docs/security-architecture.md` §6e.
- **Supersedes:** —

## Context and Problem Statement

The answer verifier sends model requests after a turn produced its answer: one claim
extraction and one evidence-judge request per soft claim, and in `enforce` mode it can
re-enter the turn. These requests used to run outside the turn's privacy scope: on the
restored answer, with raw knowledge-graph evidence, after the receipt had been written. A
control meant to make answers trustworthy was itself sending real values to a model, and
nothing recorded it.

How do post-turn checks see the answer without widening what the model provider sees?
This record is retroactive.

## Decision Drivers

- The verifier's model must see no more than the turn's model saw.
- The same person must be the same placeholder in claim and evidence, or the judge cannot
  verify.
- The receipt must cover the verifier's requests.
- A masking artefact must never be reported as a contradiction.

## Considered Options

- **A — Hand the unfinalized turn's privacy state over to the verifier (a continuation),
  run every verifier request through it, finalize once afterwards.**
- **B — An in-turn snapshot of the surrogate map** (as fact extraction uses).
- **C — Verify on real values** (status quo before).
- **D — Do not verify shielded turns.**

## Decision Outcome

Chosen option: **A**.

- **Hand-over instead of finalize.** Before every pass it runs, the wrapper calls
  `markPrivacyFinalizeHeld(input)`; the pass returns without a receipt and hands over a
  `PrivacyEgressContinuation` (`privacyEgress.ts`). Every pass that handed over is
  finalized exactly once, after the verifier's requests, also on errors and abandoned
  re-entries. A pass that throws or is cut off finalizes itself and keeps its receipt.
- **Extractor sees the wire view.** `TurnContextValue.wireView`: the prompt as the turn's
  model received it and the answer as the model wrote it, before restore. It is admitted,
  never masked a second time. Claims come back with placeholders and are restored
  server-side (`claimRestore.ts`).
- **Evidence is projected regardless of `mask_user_prompt`.** `projectVerifierText` masks
  claim, context and evidence in one call through the turn's map: identity-shaped C0 spans,
  the deny-list, C1 when wired, and caller-named identity values. Node ids never leave the
  process; snippets are named by per-request handles (`ev-1`, …). Evidence is capped at 3
  snippets × 1200 characters.
- **Never verified.** A server-rendered answer (`answerSource: 'privacy-render'`) and the
  privacy refusal; table cells are system data, only the directive's prose is checked.
- **Contradiction on placeholders is `unverified`.** A contradiction judged on a request
  the shield masked is reported with `cause: 'contradiction_unconfirmed'`; it buys no
  correction retry and cannot stop an answer.
- **Fail closed.** A blocked mask or projection sends nothing. A shield installed but no
  continuation handed back means no verification, and `enforce` withholds the answer. A
  provider without `projectVerifierText` blocks every judge request.
- **Correction hint.** It carries no verifier evidence; if the pass's policy would alter
  it (`maskWouldAlter`), the retry is withheld. A second answer with unresolved
  placeholders (`countUnresolvedSurrogates`) never replaces the first.
- **Receipt.** Verifier spans are booked in `PrivacyReceipt.verifierEgress`, never in
  `maskedPromptSpans`.

### Consequences

- 🟢 **Good:** Switching the verifier on does not widen what a model provider receives.
- 🟢 **Good:** One receipt covers the turn and the checks about it.
- 🔴 **Bad:** The judge is weaker on masked requests: a contradiction found there only
  yields a disclaimer; the deterministic re-query on real values still can stop an answer.
- 🔴 **Bad:** Streaming `done` is held until the verifier finished.
- 🔴 **Bad (open):** spelled-out numbers and dates without a year are not read when
  comparing placeholders by value (`valueLiterals.ts`).
- ⚪ **Neutral:** `verifier_contradictions` stores restored real values server-side, in the
  same trust zone as the session log.

## Pros and Cons of the Options

### A — Continuation

- 🟢 Live detectors and the same map for evidence fetched after the turn.
- 🔴 Complex lifecycle: every pass must be finalized exactly once on every exit path.

### B — Snapshot

- 🟢 Simple.
- 🔴 A snapshot cannot mask evidence fetched later with the live detectors and the same
  map; only an unfinalized turn still has both (§6e).

### C — Real values

- 🟢 Strongest judge.
- 🔴 Sends restored answers and raw graph evidence to a model, unrecorded.

### D — Skip shielded turns

- 🟢 Nothing sent.
- 🔴 No verification exactly where data answers are produced.

## More Information

- Related: [ADR-0095](0095-prompt-masking-wire-substitution-fail-closed.md),
  [ADR-0093](0093-privacy-receipt-only-when-the-shield-acted.md).
- Code: `middleware/packages/harness-orchestrator/src/privacyEgress.ts`,
  `verifierPrivacyGate.ts`, `requestReceipts.ts`;
  `middleware/packages/harness-plugin-privacy-guard/src/verifierProjection.ts`,
  `valueLiterals.ts`; `docs/security-architecture.md` §6e, §7c.
- Tests: `middleware/test/verifierServicePrivacyEgress.test.ts`,
  `verifierServiceStreamPrivacyEgress.test.ts`, `orchestratorPrivacyEgress.test.ts`,
  `verifierPrivacyEgressEndToEnd.test.ts`.
