# 0151 — A high or critical npm advisory blocks the merge; an exception is dated, reasoned, route-checked and expires in 90 days

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from
  `.github/scripts/audit-gate.mjs`, `.github/audit-exceptions.json` and
  `docs/security-architecture.md` §4a; fail-on-outage since 2026-09-29, first exception
  2026-10-04 in #1285, production exceptions 2026-10-28, 90 days for both since 2026-11-23 in #2170)

## Context and Problem Statement

This record is retroactive: it documents a gate that is implemented on main.

Plugins are curated by an operator; the npm dependencies of the kernel, the web-ui and the
desktop shell are not, so they rest on automation. `npm audit --audit-level=high` as a CI step
has three weak points. The npm audit endpoint has had long outages, and the job treated an
endpoint error as a pass until 2026-09-29. Some advisories have no fixed release at all, so a
hard gate would block every PR for weeks. And a gate that is not a required check, or does not
cover a lockfile, blocks nothing. What does the audit gate block, what may be excepted, and
how does an exception end?

## Decision Drivers

- An unknown audit state is not a clean one.
- An exception is a decision with an owner, a reason and an end date, visible in a diff.
- An exception must not silently cover more than the route it was argued for.
- What ships to users counts as production, whatever section of `package.json` it sits in.

## Considered Options

- **A — Hard gate per lockfile, with a scripted exception file: dated, reasoned,
  route-checked against the lockfile, at most 90 days.**
- **B — Hard gate, no exceptions.**
- **C — Advisory only (report, never block), or `--omit=dev` only.**
- **D — Exceptions as npm `overrides` or an ignore list without expiry.**

## Decision Outcome

Chosen option: **A**.

- **Scope.** The `audit (high+critical block)` job runs one leg per directory with its own
  `package.json` and `package-lock.json`: `middleware`, `web-ui`, `desktop`.
  `.github/scripts/audit-scope.test.mjs` fails when a tracked lockfile directory is missing
  from the matrix. Each leg has to be a required check on `main`.
- **A registry error is not a result.** Three attempts (20 s, then 40 s backoff), then the leg
  fails. Only the repository variable `AUDIT_ALLOW_REGISTRY_OUTAGE=true`, set by an admin for a
  confirmed outage, downgrades that to a warning. It never applies once the full tree has
  findings.
- **Exceptions live in `.github/audit-exceptions.json`** and are judged by
  `.github/scripts/audit-gate.mjs`. An entry names the advisory (GHSA id), the package, the
  workspaces, the dependencies in `via` through which the package enters the tree, a reason
  (at least 40 characters) saying why the vulnerable code is not reachable, a `reviewed` date
  not in the future and an `expires` date at most 90 days later (`MAX_EXCEPTION_DAYS`).
- **Two kinds.** A development-tooling exception requires the advisory to be absent from the
  production tree (`npm audit --omit=dev`) and every route to a vulnerable copy to start at a
  devDependency named in `via`. An entry marked `"production": true` may cover an advisory
  that no release fixes within the major a production dependency pins; its `via` names the
  production dependencies every route starts at.
- **Routes come from the lockfile**, resolved the way Node resolves `node_modules`, not from
  the report's `effects` links, which leave dependents out.
- **`electron` is a runtime.** It sits in the desktop's `devDependencies` but its advisories
  count like production ones (`RUNTIME_DEV_DEPENDENCIES`), and Dependabot never ignores its
  majors.
- **Exceptions end by themselves.** An expired entry fails the leg; one within 14 days of
  expiry is announced; an entry or `via` name that matches nothing is flagged for removal, so
  a clean tree goes through the gate too. A malformed entry fails all three legs.
- **Only for advisories nothing fixes.** When a fixed version exists, the dependency moves.
- **Dependabot is the other half.** Weekly (Monday 06:00 Europe/Berlin), one npm block per
  audited directory, at most five open PRs each; dev-tooling patches and minors grouped;
  named majors held for coordinated upgrades (React, TypeScript 7), each with its reason in
  `.github/dependabot.yml`.

### Consequences

- 🟢 **Good:** A CVE-bearing dependency cannot merge unnoticed, and an npm outage cannot pass
  as a clean audit.
- 🟢 **Good:** Every accepted risk is a reviewed JSON entry with an expiry; none outlives a
  quarter without a fresh look.
- 🔴 **Bad:** An upstream outage blocks all merges until an admin sets the override.
- 🔴 **Bad, accepted:** One production exception is live: GHSA-mrhx-c7xc-m3w5 in `zod` 3.x via
  `botbuilder` 4.23.3, renewed 2026-11-23 until 2027-02-21. The entry argues that inbound Bot
  Framework requests never reach the affected array schemas.
- 🔴 **Bad:** Moderate and low advisories are not gated at all.
- ⚪ **Neutral:** A new package directory needs an audit leg, a Dependabot block and, after its
  PR is on `main`, a new required check; a required context that never reports would block
  every open PR.

## Pros and Cons of the Options

### A — Hard gate with scripted, expiring exceptions

- 🟢 Blocks by default; exceptions are narrow and self-ending.
- 🔴 A gate script and its tests to maintain.

### B — No exceptions

- 🟢 Simplest rule.
- 🔴 An unfixable advisory in a linter's dependency stops all work.

### C — Advisory only

- 🟢 Never blocks.
- 🔴 The state before: findings are reported and ignored.

### D — Ignore list without expiry

- 🟢 One line per advisory.
- 🔴 Nothing re-examines it; it covers routes nobody argued for.

## More Information

- Code: `.github/workflows/ci.yml` (job `audit`), `.github/scripts/audit-gate.mjs`,
  `.github/audit-exceptions.json`, `.github/dependabot.yml`.
- Tests: `.github/scripts/audit-gate.test.mjs`, `.github/scripts/audit-scope.test.mjs` (run in
  every leg before the audit).
- Docs: `docs/security-architecture.md` §4a and §11.
- Related draft: [ADR-0149](0149-ci-gates-fail-loud-and-ratchets-only-tighten.md).
