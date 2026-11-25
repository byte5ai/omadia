# 0035 — Postgres tests are found by their name; CI guards the name and holds a floor

## Status

Accepted

- **Date:** 2026-11-23
- **Deciders:** Maintainers, step 0 of the memory-ACL test plan; PR #2179 (follow-up docs in
  #2187). Builds on the Postgres floor of #565 and the test-typecheck ratchet of #573.

## Context and Problem Statement

CI runs Postgres suites in one step, `npm run test:pg`. It globs `test/**/*.pg.test.ts` and is
the only step with a test DSN; `npm run test` sets none. A Postgres suite gates on
`probePgTest` and skips itself without a DSN. A Postgres leg in a file named `foo.test.ts`
therefore skipped in `npm test` and ran nowhere, and `PG_TEST_FLOOR` (#565: `ran >= floor`,
`skipped == 0`) could not notice, because it counts only `test:pg`.

Measured against pgvector, 27 Postgres tests in seven memory suites had never run in CI. The
floor stood at 448 while CI already ran 694, so it had 246 tests of slack: a whole suite could
have vanished without a red build.

The memory-ACL plan (ADR-0039) builds its proof on Postgres legs. How does CI make sure a
Postgres test actually runs, and keeps running?

## Decision Drivers

- A test that silently skips is worse than no test: it reads as coverage.
- One CI step with a DSN is cheaper and simpler than a DSN in every step.
- The rule has to be checkable by a script, not by review.

## Considered Options

- **A — Name rule plus guard plus a tight floor.** Postgres tests live in `*.pg.test.ts`; a
  guard fails when a test reaches the Postgres helper without that name; the floor equals the
  measured `ran=`.
- **B — Give `npm test` a DSN in CI**, so every file may hold Postgres legs.
- **C — Keep the convention and the loose floor**, and rely on review.

## Decision Outcome

Chosen option: **A**.

- **Name rule.** A test that needs Postgres is named `*.pg.test.ts`. A suite with both legs is
  split: database-free cases in `foo.test.ts`, Postgres cases in `foo.pg.test.ts`, shared code
  in a non-test module (pattern of `memoryStoreConformance.ts`).
- **Guard.** `npm run test:pg:names` (`scripts/check-pg-test-names.mjs`), a CI step, fails when
  a test file reaches `test/_helpers/pgTestDb.ts` directly or through a helper without the
  `.pg.test.ts` name. Two suites that gate on `DATABASE_URL` alone are deliberately outside CI
  and ignored by the guard.
- **Floor equals the measurement.** `PG_TEST_FLOOR` in `.github/workflows/ci.yml` is the
  `ran=` a fresh database prints (721 at #2179). A PR that adds Postgres tests raises it to its
  new `ran=`; a PR that folds tests together lowers it and says why. `skipped` must be 0.
- **A failed setup fails.** A suite gates on `probePgTest`; it does not turn a failed
  migration into a skip.
- **Same family.** The test/scripts typecheck ratchet (`npm run typecheck:test`, #573) is the
  other gate of this kind: it measures known errors and fails on any new one. Both are
  ratchets that only move in the direction of more checking.

### Consequences

- 🟢 **Good:** A Postgres test either runs in CI or breaks CI; it cannot be skipped unseen.
- 🟢 **Good:** The floor turns a vanished suite into a red build instead of slack.
- 🔴 **Bad:** Mixed suites split into two files with a shared module; more files per topic.
- 🔴 **Bad:** Every PR that touches Postgres tests edits `ci.yml`, and parallel PRs conflict on
  the floor line.
- ⚪ **Neutral:** Local runs on a reused database can still fail where a fresh CI database
  passes (#2185); CI is the reference. Known test-infrastructure bugs: #2185, #2186.

## Pros and Cons of the Options

### A — Name rule, guard, tight floor

- 🟢 Checkable by script; one DSN step stays.
- 🔴 Floor maintenance on every Postgres change.

### B — DSN for every test step

- 🟢 No naming rule.
- 🔴 Every unit run needs a database; slower and harder to run locally; the floor would have to
  count all steps.

### C — Convention and review

- 🟢 No work.
- 🔴 It already failed: 27 tests never ran.

## More Information

- Rule: `middleware/test/README.md`, "Postgres tests must be named `*.pg.test.ts`".
- Docs: `docs/middleware-agent-handoff.md` §14.
- Related: [ADR-0039](0039-memory-access-verified-by-oracle-and-canary-sweep.md).
