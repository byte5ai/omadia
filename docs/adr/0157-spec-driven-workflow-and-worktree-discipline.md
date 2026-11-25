# 0157 — Non-trivial work starts from a spec in `specs/`; every commit comes from a worktree and reaches `main` through a squash-merged PR

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from
  `.specify/memory/constitution.md` v1.0.0, ratified 2026-05-21, `AGENTS.md`, `CONTRIBUTING.md`,
  `.hooks/` and `.github/engineering-standards.yml`, decided 2026-05-17)

## Context and Problem Statement

This record is retroactive: it documents a working process that is in force on main.

The repository is developed by a small team together with many coding agents, often several
sessions in parallel on one machine. Two forces follow from that. A larger feature needs a
written target that can be reviewed before code exists. And in a shared clone a parallel
session can switch `HEAD`, so a commit made there has unreliable branch attribution (the
reason `.hooks/pre-commit` prints).
Releases are derived from commit subjects (see
[ADR-0158](0158-tag-only-automated-releases-with-two-phase-publish.md)), so commit hygiene is load-bearing.
How does a non-trivial change start, where does its normative text live, and how does a change
travel from an editor to `main`?

## Decision Drivers

- Intent is reviewed before code, for anything larger than a fix.
- Specs, plans and decisions stay in the repository, next to the code they bind.
- Parallel agent sessions must not corrupt each other's branches.
- `main` stays releasable: every commit on it is a reviewed, squashed PR.

## Considered Options

- **A — Spec-driven workflow with spec-kit scaffolding, a constitution, specs in `specs/`,
  decisions in `docs/adr/`; worktree-only commits and PR-only `main`, enforced by local hooks
  and branch protection.**
- **B — Issues and PR descriptions only; no specs in the repo.**
- **C — Free use of the main clone and feature branches, by convention.**

## Decision Outcome

Chosen option: **A**.

- **Spec → plan → tasks → implement.** The constitution's "Development Workflow" makes this the
  path for non-trivial features, in independently testable slices. The spec-kit scaffolding
  (`.specify/`, version `0.8.6.dev0`, Claude integration) provides templates and scripts.
- **`specs/<number>-<slug>/` holds the normative detail.** Early specs are numbered
  sequentially (`001-…`, `002-…`, `005-…`); later ones carry their issue number
  (`336-…`, `470-…`, `575-…`, `2042-…`, `2043-…`). A spec may hold `spec.md`, `plan.md`,
  `tasks.md`, `data-model.md`, `contracts/`, `acceptance.md`.
- **Division of labour between documents.** A spec says what a feature must satisfy and how it
  is accepted. An ADR records one decision and its trade-off and points at the spec
  (`docs/adr/README.md` does this for ADRs 0012 to 0022). `AGENTS.md` assigns the rest:
  `docs/middleware-agent-handoff.md` for architecture, `docs/CHANGELOG.md` for fixes and
  incidents, `docs/security-architecture.md` for security decisions. A change without its
  documentation update is not finished.
- **The constitution is the checklist for plans and PRs:** plugin isolation and lifecycle,
  contract-first extensibility through `plugin-api`, server-side business logic, the
  test-green gate, privacy by capability, observability.
- **The main clone never receives commits.** Every change lands in a git worktree.
  `.hooks/pre-commit` refuses a commit from the main tree, whatever branch it is on;
  `.hooks/pre-push` refuses a direct push to `main` or `master`. `script/setup` activates both
  (`git config core.hooksPath .hooks`). Bypasses are explicit environment variables
  (`ALLOW_MAIN_TREE_BRANCH=1`, `ALLOW_PUSH_TO_MAIN=1`).
- **PR-only `main`.** Conventional Commit subjects, squash merge by default, the PR title
  becomes the commit subject, at least one maintainer approval, no `Co-Authored-By` trailers
  for AI agents (`CONTRIBUTING.md`).
- **Workflow scripts never merge.** The `scripts/*.workflow.mjs` orchestration scripts do not
  push or merge on their own; opening or merging a PR stays an explicit step of a top-level
  session (`AGENTS.md`).

### Consequences

- 🟢 **Good:** Large changes (multi-orchestrator runtime, Dev Platform extraction, agents as
  virtual employees) have a reviewed text that ADRs and tests can cite.
- 🟢 **Good:** A session whose `HEAD` was moved by another session cannot commit by accident.
- 🔴 **Bad:** The hooks are local and opt-in. A clone that never ran `script/setup` has
  neither; only branch protection on GitHub holds then.
- 🔴 **Bad:** The constitution has drifted since 2026-05-21 and was not amended: it names Node
  `22.12.0` (the repo pins `22.22.3`), the retired `omadia-byte5-plugins` monorepo, and
  "never edit i18n JSON directly (i18nexus overwrites it)", which `web-ui/CLAUDE.md` overrides.
  It still binds as written until someone bumps its version.
- 🔴 **Bad:** Spec directories mix normative text with dated handoff notes, and two specs share
  the number `005`.
- ⚪ **Neutral:** Each worktree has its own `node_modules` and build output; the first build per
  tree costs full time.

## Pros and Cons of the Options

### A — Specs in the repo, worktrees, PR-only main

- 🟢 Reviewable intent; safe parallel sessions.
- 🔴 More documents to keep true; local enforcement is voluntary.

### B — Issues and PRs only

- 🟢 Less ceremony.
- 🔴 Normative text is scattered over issue comments and cannot be cited by a test or an ADR.

### C — Convention only

- 🟢 Nothing to install.
- 🔴 Unreliable branch attribution in a clone several sessions share.

## More Information

- Docs: `.specify/memory/constitution.md`, `AGENTS.md`, `CONTRIBUTING.md`,
  `docs/adr/README.md`.
- Code: `.specify/`, `specs/`, `.hooks/pre-commit`, `.hooks/pre-push`, `script/setup`,
  `.github/engineering-standards.yml`, `.github/PULL_REQUEST_TEMPLATE.md`.
- Related: [ADR-0011](0011-readme-as-landing-page.md) (where documentation detail lives),
  [ADR-0149](0149-ci-gates-fail-loud-and-ratchets-only-tighten.md),
  [ADR-0158](0158-tag-only-automated-releases-with-two-phase-publish.md).
