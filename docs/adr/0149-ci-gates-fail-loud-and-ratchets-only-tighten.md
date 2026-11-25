# 0149 — A CI check that asserts nothing fails; debt is held by ratchets that only tighten; token-spending evals stay off pull requests

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from `.github/workflows/ci.yml`,
  `golden-eval.yml`, `adversarial-eval.yml` and the scripts they call; issues #565, #566,
  #573, #605, #640, #764, #1017, #129, #498)

## Context and Problem Statement

This record is retroactive: it documents the shape of the test and CI strategy on main.

The repository has more than 1,300 middleware test files, a web-ui suite, a desktop suite,
sidecars in other languages and LLM-behaviour evals. Several times a required check was green
while it tested nothing: Postgres suites that skipped themselves without a database (#565), an
eval that passed on an empty evaluation (#640), workspace package suites no workflow ran
(#764), loopback tests that skipped in a sandbox (#1017). Other gates could not be switched on
at once because of existing debt (type errors in tests, hardcoded UI strings). Some checks
cost real model tokens. What makes a check count, how is existing debt gated, and which checks
run on a pull request?

## Decision Drivers

- A green check must mean something ran and held.
- A red run must mean a real failure, or people learn to re-run.
- Debt that cannot be paid in one PR must still not grow.
- Fork PRs get no secrets and must not spend money.

## Considered Options

- **A — Layered suites, each with a guard against running empty; committed ratchets for debt;
  deterministic checks on PRs, token-spending evals on `main`, cron and dispatch.**
- **B — One `npm test` with every dependency (database, API key) in every step.**
- **C — Soft gates: `--passWithNoTests`, allow-failure jobs, review catches the rest.**

## Decision Outcome

Chosen option: **A**.

- **Layers, each run where its dependency exists.**
  - Unit and route tests: `npm run test` in `middleware` (`node:test` through `tsx`, no
    database), `vitest` in `web-ui` (jsdom), `node --test` in `desktop` against a stubbed
    `electron` on Node 24.
  - Postgres: `npm run test:pg`, serial, on a real pgvector service container
    ([ADR-0035](0035-postgres-tests-are-found-by-name-and-held-by-a-floor.md)).
  - Schema: a separate job applies every migration to pgvector and applies them a second time
    as an idempotency check.
  - Workspace packages, the updater sidecar (`npm run test:updater`) and the Python
    PII-detector sidecar are named steps, because they sit outside the main glob.
  - Images: `build.yml` builds both Dockerfiles on PRs that touch them, without pushing.
- **A check that could pass empty is made to fail.** The Postgres step fails on `skipped > 0`
  or `ran < PG_TEST_FLOOR`. `OMADIA_EXPECT_LOOPBACK=1` turns a loopback skip into a failure.
  The prompt-PII eval fails on an empty evaluation. A package with a test script and no test
  files is left out of the step rather than run with `--passWithNoTests`.
  `desktop-apps.yml` takes `require_release` so a missing release fails instead of attaching
  nothing.
- **Same conditions everywhere.** `--test-concurrency=4` is pinned for the unit suite (#605),
  because a core-count default made local and CI runs differ and produced a different flaky
  failure on each run. `npm run test:filetimes` fails when a test file uses more than half of
  the file-scoped `--test-timeout` (#566); a fraction, not a committed duration, because the
  same suite measured 36 s locally and 172 s on the runner.
- **Ratchets hold debt.** A ratchet commits a number and only moves toward more checking:
  `middleware/test-typecheck-baseline.json` (per-file type-error counts in `test/` and
  `scripts/`, `npm run typecheck:test`; `--update` can only lower a count),
  `PG_TEST_FLOOR`, `web-ui/scripts/i18n-literal-ceiling.json`, the per-locale floors of the
  prompt-PII eval. Raising a baseline is a hand edit that shows in the diff.
- **A ratchet that reached its goal is removed.** The core-decoupling ratchet of epic #470
  peaked at 3,448 counted references, reached 0 and was deleted on 2026-08-21.
- **Generated artifacts are drift-checked:** `plugin-ui:css:check`, `manifest:i18n:check`,
  the compose overlay render and "overlay images are pullable" steps.
- **Behavioural evals are not PR checks.** `golden-eval.yml` (#129, verifier verdict classes on
  a frozen corpus) and `adversarial-eval.yml` (#498, multi-turn manipulation scenarios against
  a committed `baseline.json`) spend Anthropic tokens. They run on pushes to `main`, a weekly
  cron (Monday and Tuesday 06:00 UTC) and manual dispatch, are never cancelled by a newer
  commit, and skip with a notice when `ANTHROPIC_API_KEY` is absent. The deterministic
  adversarial tier runs inside `npm test`.

### Consequences

- 🟢 **Good:** The silent-skip family (#565, #640, #764, #1017) now ends in a red build.
- 🟢 **Good:** Gates could be switched on against existing debt without a 130-file cleanup PR.
- 🔴 **Bad:** Ratchet files (`ci.yml` floor line, baselines, ceilings) are edited by many PRs
  and conflict between parallel branches.
- 🔴 **Bad:** A behavioural regression is found after the merge, on `main`, not before it.
- 🔴 **Bad, accepted:** The two evals are the exception to "a skip fails": without the secret
  they stay green by design, so a repository that lost the key gets no signal from them.
- 🔴 **Bad:** The kernel's suite runs on Node 22 only, although the desktop app runs the kernel
  on Electron's Node 24.
- ⚪ **Neutral:** The middleware job needs 25 minutes of budget; the unit suite alone takes 9 to
  10 minutes on the runner.

## Pros and Cons of the Options

### A — Layers with empty-run guards and ratchets

- 🟢 Each green means something; debt is bounded.
- 🔴 Many small scripts and numbers to maintain.

### B — Everything in one step

- 🟢 One command.
- 🔴 Every unit run needs a database and a key; forks could not run it.

### C — Soft gates

- 🟢 Never blocks.
- 🔴 The permanently-green no-op this repo found repeatedly (#565, #640, #764, #1017).

## More Information

- Code: `.github/workflows/ci.yml`, `build.yml`, `golden-eval.yml`, `adversarial-eval.yml`;
  `middleware/scripts/check-test-typecheck.mjs`, `check-test-file-durations.mjs`,
  `check-pg-test-names.mjs`; `middleware/test-typecheck-baseline.json`;
  `middleware/test/golden/`, `middleware/test/adversarial/`.
- Docs: `middleware/test/README.md`.
- Related: ADR-0035, [ADR-0029](0029-facilitator-acceptance-matrix-and-ci.md),
  [ADR-0039](0039-memory-access-verified-by-oracle-and-canary-sweep.md),
  [ADR-0151](0151-dependency-audit-gate-with-dated-exceptions.md),
  [ADR-0159](0159-web-ui-i18n-plain-json-catalogs-and-ratchets.md).
