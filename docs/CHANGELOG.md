# Changelog

All notable changes to Omadia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- 2026-05-17 — byte5ai engineering-standards bootstrap (PR #31). Repo is now
  on `status: applied` against `byte5ai/engineering-standards`:
  - `.github/engineering-standards.yml` as the explicit marker.
  - `.hooks/pre-push` blocks direct pushes to `main`/`master` locally.
  - `script/setup` enables the hook and runs the npm bootstrap in one step.
  - AGENTS.md gained a "Git Workflow & Engineering Standards" section.
  - CONTRIBUTING.md documents the pre-push guard and forbids
    `Co-Authored-By:` trailers for AI agents.
  - Branch protection on `main` is enforced server-side: PR required,
    force-push and deletion blocked, all four CI workflows (five contexts
    including the `audit` matrix) wired up as required status checks.

  GitHub Actions were disabled on the repo since 2026-05-11 and were
  reactivated as part of this rollout. The first post-reactivation CI run
  surfaced three pre-existing pipeline bugs that had been masked while
  Actions were off — they're fixed in the same wave, see *Fixed* below.

### Fixed

- 2026-05-17 — Three pre-existing bugs in the CI pipeline, surfaced once
  Actions were reactivated:
  - `.github/workflows/ci.yml` pinned `setup-node@v4` to `node-version: '20'`
    in three places, but `middleware/package.json` declares
    `engines.node ">=22 <23"`. `npm ci` failed with `EBADENGINE` in the
    `middleware` and `audit (middleware)` jobs. Bumped to `'22'`.
  - The `schema (migrations on pgvector)` job applied a hardcoded list of
    nine migrations, four of which had moved or been renumbered as the
    knowledge-graph schema grew (`harness-knowledge-graph-neon` now ships
    13 migrations, two more domains were added — `auth/`,
    `profileSnapshots/`, `profileStorage/`). Replaced the array with a
    glob over five migration domains, applied in lexical order. Coverage
    grew from 9 to 20 migrations.
  - `middleware/src/index.ts:398` triggered `prefer-const` because
    eslint's reassignment analysis doesn't trace the forward-reference
    assignment ~1300 lines later in `main()`. Documented the intent and
    suppressed the rule on that one line.

### Changed

- `docs/CHANGELOG.md` reformatted to follow the Keep-a-Changelog convention.
  Detailed operational history prior to v0.1.0 is preserved in the git log.
- Replaced the internal `docs/security-migration-plan.md` post-mortem with
  `docs/security-architecture.md`, which describes the generic patterns
  (proxy-over-direct calls, secrets in a vault, scope-locked sub-agent tools)
  without incident-specific identifiers.
- Sanitised `middleware/packages/harness-diagrams` package metadata to remove
  internal hostnames and branding.

---

## [0.1.0] — 2026-05-11

Initial public release of Omadia — *An Agentic OS*.

### Added

- Middleware kernel with plugin runtime, capability registry, and
  scope-locked sub-agent tools.
- Web UI (`web-ui/`) for operator onboarding, plugin install via ZIP upload,
  and chat sessions.
- Reference plugins: `harness-diagrams`, `harness-memory`, and the
  `agent-reference-maximum` / `agent-seo-analyst` boilerplates.
- Docker Compose deployment recipe.
- AGENTS.md + four-file documentation set
  (`docs/README.md`, `docs/middleware-agent-handoff.md`,
  `docs/CHANGELOG.md`, `docs/security-architecture.md`).

### Notes

- Licence: MIT.
- The full pre-release development history is preserved in the maintainer's
  internal repository and is not part of the public git history.

[Unreleased]: https://github.com/byte5ai/omadia/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/byte5ai/omadia/releases/tag/v0.1.0
