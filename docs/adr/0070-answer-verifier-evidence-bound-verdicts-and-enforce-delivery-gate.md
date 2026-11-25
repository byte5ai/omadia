# 0070 — The answer verifier binds verdicts to evidence; `enforce` is a delivery gate that fails closed

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; implemented in #1267 (honest states, enforce buffering),
  #1367 (release unconfirmed answers), #1613 (Odoo confirmation), #1407/#1431 (rendered rows are
  system data, disclaimer paragraph removed), #1670 (decision model as first judge)
- **Supersedes:** —

## Context and Problem Statement

An agent's answer can state amounts, dates, record references and totals that no tool result
backs. The answer verifier (`@omadia/verifier`, wrapped by `VerifierService` in
`@omadia/orchestrator`) checks an answer after the turn. This record is retroactive: it writes
down what the code on main decides.

Three questions had to be settled. What may a verdict claim? What does the user receive while
and after the check runs? And what happens when the verifier itself cannot run?

## Decision Drivers

- "The verifier could not check" must never read as "checked and found nothing wrong".
- A refuted answer must not reach the user in `enforce`; an unconfirmed one is not a wrong one.
- The verifier must be calibratable in production without touching delivery.
- Rows the Privacy Shield rendered server-side are system data, not model claims.
- The verifier is optional: an install without it, or without a key, keeps answering.

## Considered Options

- **A — Evidence-bound verdicts; `shadow` observes, `enforce` holds every answer until the
  verdict and withholds on contradiction or an unavailable verifier.**
- **B — Advisory only:** always deliver, attach a badge.
- **C — Strict gate:** deliver only fully confirmed answers.

## Decision Outcome

Chosen option: **A**.

- **Pipeline** (`verifierPipeline.ts`): regex trigger router → claim extractor → hard claims to
  the `DeterministicChecker` (re-query of the source system), soft claims to the
  `EvidenceJudge`; a `decisionModel@1` provider judges all soft claims in one batch first, and a
  contradiction it reports still has to be confirmed by the model (`evidenceDecision.ts`).
  Contradictions found without extraction (failure replay, tool postconditions, missing
  citations) block on every path. The pipeline never throws.
- **Verdict classes are bound to claims.** `approved` requires that the extraction reported no
  coverage gap and every extracted claim (at least one) is `verified`. Anything checked only in
  part is `approved_with_disclaimer`. `skipped` means nothing could be checked; `unavailable`
  means the extraction failed. `VerifierService` re-derives the status from the claims
  (`bindVerdictToClaims`) before it stores, retries or streams it, and the badge is computed
  from the claims, not the status (`verifierVerdicts.ts`).
- **`shadow` (default)** runs and persists; the answer goes out unchanged and the verdict
  follows as a trailing `verifier` event.
- **`enforce` is a delivery gate** (`verifierDelivery.ts`). While the verdict is pending only a
  closed allowlist of liveness, progress and usage events passes (`passesBeforeVerdict`); an
  event type added later is held by default. `approved`, `skipped` and
  `approved_with_disclaimer` release the answer as one `text_delta` plus `done`; `blocked` and
  `unavailable` withhold it and deliver a localized notice with
  `answerSource: 'verifier-blocked'`. A contradiction buys at most one correction retry; the
  non-streaming path may draw a second sample of a borderline answer
  (`verifier_resample_on_borderline`). See [ADR-0075](0075-one-request-runs-each-tool-once-and-records-the-delivered-answer.md).
- **Exceptions, stated in the contract:** control-flow terminals (choice card, MCP input form,
  slot picker, OAuth consent, degraded turn, bare `NO_REPLY`) are released without a verdict. A
  privacy-rendered answer is judged by the prose its model wrote; an answer with no prose is
  released as system data (`systemDataVerdict`). An answer the verifier may not see behind a
  Privacy Shield is never sent to the pipeline and is withheld (`verifierGate`).
- **Always registered, published only when usable.** The plugin always registers; it publishes
  `verifier@1` only with `verifier_enabled=true` and a key for its provider. `enforce` has no
  effect on agents with the subscription-CLI runtime or on routines.

### Consequences

- 🟢 **Good:** A green badge always means "every claim was checked and confirmed".
- 🟢 **Good:** In `enforce`, no model text reaches a client before the verdict.
- 🔴 **Bad:** `enforce` removes live text streaming; the answer arrives in one piece after
  extraction and judging.
- 🔴 **Bad:** An answer whose claims could not be confirmed still goes out in `enforce`; only the
  badge says so. That is deliberate (#1367), and stricter than B, laxer than C.
- 🔴 **Bad:** The trigger router is regex-based; an answer without a strong signal is `skipped`.
  CLI-runtime agents and routines are not gated.
- ⚪ **Neutral:** A claim the model omits from a list below the request limit is beyond what any
  check here can see; the code documents this limit.

## Pros and Cons of the Options

### A — Evidence-bound, shadow/enforce

- 🟢 Honest states; fail-closed where it matters; calibratable.
- 🔴 Latency and one-piece delivery in `enforce`.

### B — Advisory only

- 🟢 No latency, no withheld answers.
- 🔴 A refuted figure reaches the user with a small badge next to it.

### C — Strict gate

- 🟢 Strongest guarantee.
- 🔴 Most answers contain something no check can confirm; the product would withhold routinely.

## More Information

- Code: `middleware/packages/harness-verifier/src/{verifierPipeline,triggerRouter,evidenceDecision,verdictBinding}.ts`,
  `middleware/packages/harness-verifier/manifest.yaml` (setup fields),
  `middleware/packages/harness-orchestrator/src/{verifierService,verifierDelivery,verifierEnforceStream,verifierVerdicts,verifierPrivacyGate}.ts`.
- Tests: `middleware/test/verifierPipelineStates.test.ts`, `verifierVerdictBinding.test.ts`,
  `verifierServiceEnforceRelease.test.ts`, `verifierServiceEnforceStream.test.ts`,
  `verifierHonestWithhold.test.ts`.
- Related: ADR-0013 (the identity guard is independent of this verifier), ADR-0021,
  [ADR-0071](0071-behaviour-evals-golden-set-and-adversarial-suite.md), [ADR-0072](0072-chat-stream-events-done-is-authoritative.md).
- Border: privacy (rendered rows, `verifierPrivacyGate.ts`).
