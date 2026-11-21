# 0028 — Facilitator acceptance matrix and CI

## Status

Accepted

- **Date:** 2026-11-21
- **Deciders:** Owner (byte5: close every gap of spec B); implemented by stream G2 (#2068)

## Context and Problem Statement

Spec B §9 lists 64 acceptance criteria for native facilitators. #2068 asks for an end-to-end
and race acceptance suite: every criterion mapped to an automated test that fails on
regression, with a simulated channel and a fake clock, in CI. By 2026-11-21 most criteria had
tests, spread over some 70 files in `omadia-agent-facilitator` and over the kernel's suite,
but nothing said which test proves which criterion, several criteria had only parts tested,
and the plugin repository had no CI at all: its gates ran only on a developer's machine.
Criteria 23 to 28 cross the kernel/plugin boundary (scopes, grants, process-bound reads),
and criterion 13 asks for a manual check on a real Teams instance.

## Decision Drivers

- A criterion counts only with a test that goes red when the behaviour breaks; a skipped
  test is not a passed one.
- The engine lives in the plugin (ADR 0022), so the end-to-end proof lives there too; the
  kernel proves its contract half in its own suite.
- The mapping must not rot: a renamed or deleted test has to break something.
- `@omadia/plugin-api` is not published to npm; the plugin builds against a kernel checkout.

## Decision Outcome

- **One matrix, in the plugin repository:** `docs/acceptance-matrix.md` in
  `omadia-agent-facilitator` maps each criterion 1 to 64 to its plugin tests and, where the
  criterion crosses a boundary, to the kernel's (`omadia:`) and the Teams channel's
  (`teams:`) tests. The plugin side is end to end on the fake kernel (a simulated channel per
  transport: Teams, Slack, Discord, Telegram), a fake clock and a real Postgres, restarts as a
  new engine on the same database.
- **Criteria 23 to 28:** the plugin tests drive the engine through the kernel contract as the
  fake kernel implements it (inbound event ids, revisions, execution scopes, grants, process
  subscriptions); the kernel's suite (`executionScopes.pg`, `scopedSendService`,
  `processConversationMessages`, `scopedAgentTurnInboundEvent`, the facilitator contract and
  omission suites) proves the kernel keeps that contract. A criterion is green when both
  halves are.
- **A guard against rot:** `scripts/check-acceptance-matrix.mjs` fails when a criterion has
  no row or more than one, a row names no plugin test, a referenced test title no longer
  exists, or a test named after a criterion ("21. ...") is missing from that row.
- **CI for the plugin:** a GitHub Actions workflow checks the plugin out next to
  byte5ai/omadia (sparse: the plugin-api package and the zip extractor the package test
  mirrors), builds `@omadia/plugin-api`, and runs typecheck, build, the matrix check and the
  whole suite on a throwaway Postgres. `FACILITATOR_TEST_REQUIRE_PG=1` turns "Postgres-backed
  tests skipped" into a failed run. A manual run can name a kernel ref to test against an
  unreleased contract.
- **Criterion 13:** the §6.2 contract tests run on the simulated Bot Framework/Graph transport
  in `omadia-channel-teams`; the manual checklist on a real instance
  (`docs/facilitator-live-verification.md` there) is recorded in omadia-channel-teams#43. The
  field scenario in Slack, Discord and Telegram is a plugin test. The two placeholder tests that
  were always skipped (13, and the kernel half of 10) are removed; the matrix points to where
  each is proven.

- **Gaps found are fixed in the plugin, not waived:** writing the missing tests found engine
  behaviour that did not meet §9; each is fixed with its test (criteria 28, 31, 34, 43, 46, 59,
  64; listed in the plugin's `AGENTS.md`). No kernel gap was found: the kernel's half of 23 to
  28 already holds the contract the plugin relies on.

### Consequences

- 🟢 **Good:** every criterion of §9 has a named, red-on-regression test; a pull request in the
  plugin repository runs the gates in CI instead of on trust.
- 🔴 **Bad:** the plugin's CI builds against the kernel's `main` by default, so a breaking change
  to the contract shows up in the plugin's next run, not in the kernel's pull request.
- ⚪ **Neutral:** no kernel code, migration or plugin-api version changes.

## More Information

- byte5ai/omadia#2068; spec `specs/2043-native-facilitators/spec.md` §9.
- Plugin: `docs/acceptance-matrix.md`, `scripts/check-acceptance-matrix.mjs`,
  `.github/workflows/ci.yml`, `AGENTS.md` ("Acceptance matrix and CI").
