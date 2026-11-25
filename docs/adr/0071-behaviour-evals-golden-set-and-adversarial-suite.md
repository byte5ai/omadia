# 0071 — Model behaviour is gated by evals outside the unit suite: verdict classes and a two-tier adversarial suite

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; #640 (golden-set eval, issue #129; v2 in #639), adversarial
  eval for issue #498 (spike decision "adapt" recorded in `middleware/test/adversarial/README.md`)
- **Supersedes:** —

## Context and Problem Statement

CI's unit tests prove plumbing. They cannot show that the pinned model still classifies known
inputs the same way after a model bump or a prompt edit, or that the injection defenses hold when
attacked. Model output is stochastic, costs tokens, and needs a key that forks do not have. This
record is retroactive.

How is model-dependent behaviour gated without making `npm test` flaky, slow or key-dependent?

## Decision Drivers

- Assertions must be stable despite generation noise.
- `npm test` stays hermetic and key-free; a fork without secrets stays green.
- Deterministic defenses should be read off the wire, not judged by a model.
- Token cost must be bounded and scheduled.

## Considered Options

- **A — Separate eval runners with frozen corpora: assert the verdict class with majority voting;
  split adversarial testing into a deterministic tier and a key-gated behavioural tier with a
  baseline.**
- **B — Assert raw model strings in unit tests** with recorded responses.
- **C — Adopt an external black-box red-team harness wholesale.**

## Decision Outcome

Chosen option: **A**.

- **Golden set** (`middleware/test/golden`). Each corpus entry is a frozen tuple (user message,
  answer, trace fields, fixture evidence, fixture Odoo records, expected status) run through a
  real `VerifierPipeline` with fixture-backed sources (`FixtureOdooReader`; no Postgres, no live
  Odoo, no orchestrator). The assertion target is the verdict **class**, optionally the path that
  produced it (`expected.via`), decided by majority over re-runs. It pins `VERIFIER_MODEL`, the
  model those stages actually run on. `unavailable` is never an expected class.
- **Adversarial suite** (`middleware/test/adversarial`). Tier A runs the real defense against a
  hostile fixture and reads the verdict off the produced artifact; it runs in `npm test` on every
  PR. Tier B is behavioural: a conductor escalates over several turns and a three-juror panel
  scores the transcript, with `findIdentityLeaks` as a hard oracle; it is key-gated and
  runs only in the eval workflow. Outcomes are compared with `baseline.json`; a regression fails.
- **Runners live outside the test glob.** `npm run eval:golden` and `npm run eval:adversarial`
  are `*.eval.ts`, not `*.test.ts`. Without `ANTHROPIC_API_KEY` they skip with a notice and exit
  0. The pure harness parts have key-free unit tests.
- **Schedule.** `golden-eval.yml` runs on push to main, on dispatch and weekly (Mondays 06:00
  UTC); a running eval is not cancelled by the next commit. `adversarial-eval.yml` has the same
  triggers, offset by a day (Tuesdays) so the two token-spending jobs do not collide.

### Consequences

- 🟢 **Good:** A model or prompt change that shifts verifier behaviour fails a named corpus entry.
- 🟢 **Good:** Most adversarial coverage is free and runs on every PR.
- 🔴 **Bad:** The golden set evaluates the verifier on frozen answers. A regression in the agent
  itself (it stops calling a tool) is out of scope until a full-turn eval exists (#639, gap 3).
- 🔴 **Bad:** The model-dependent evals trigger on push to main and on a schedule, not on pull
  requests; a regression is found after the merge.
- 🔴 **Bad:** A repository without the key reports green without having measured anything.
- ⚪ **Neutral:** A new defense or verifier path should add a corpus entry and, for the adversarial
  suite, a baseline line.

## Pros and Cons of the Options

### A — Class assertions, two tiers

- 🟢 Stable, cheap, honest about what is measured.
- 🔴 Coverage is as good as the corpus.

### B — Raw strings

- 🟢 Runs in the unit suite.
- 🔴 Recorded responses do not detect drift of the live model.

### C — External harness

- 🟢 Ready-made methodology.
- 🔴 Black-box scoring cannot read the wire-level guarantees, and every trial costs tokens.

## More Information

- Code and docs: `middleware/test/golden/README.md`, `goldenRunner.ts`, `goldenModel.ts`,
  `fixtureOdooReader.ts`, `corpus/*.jsonl`; `middleware/test/adversarial/README.md`,
  `adversarialRunner.ts`, `adversarialModel.ts`, `baseline.json`, `corpus/*.jsonl`;
  `.github/workflows/golden-eval.yml`, `.github/workflows/adversarial-eval.yml`.
- Tests: `middleware/test/goldenRunner.test.ts`, `goldenModel.test.ts`,
  `adversarialRunner.test.ts`, `adversarialModel.test.ts`.
- Related: ADR-0029 (facilitator acceptance matrix), ADR-0035, ADR-0039,
  [ADR-0070](0070-answer-verifier-evidence-bound-verdicts-and-enforce-delivery-gate.md).
- Border: CI / testing, privacy (the wire oracles).
