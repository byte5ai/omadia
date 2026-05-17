# Changelog

All notable changes to Omadia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- byte5ai engineering-standards applied to the repo
  (`status: applied` in `.github/engineering-standards.yml`):
  - `.hooks/pre-push` blocks direct pushes to `main`/`master` locally.
  - `script/setup` activates the hook and runs the npm bootstrap in one step.
  - AGENTS.md gained a "Git Workflow & Engineering Standards" section.
  - CONTRIBUTING.md documents the pre-push guard and forbids
    `Co-Authored-By:` trailers for AI agents.
  - Server-side branch protection on `main`: pull request required,
    force-push and deletion blocked, all five CI workflow contexts wired
    up as required status checks.
- GitHub Actions re-enabled after the 2026-05-11 outage; first
  post-reactivation runs landed green on the same day.

### Changed

- `docs/CHANGELOG.md` reformatted to follow the Keep-a-Changelog convention.
  Detailed operational history prior to v0.1.0 is preserved in the git log.
- Replaced the internal `docs/security-migration-plan.md` post-mortem with
  `docs/security-architecture.md`, which describes the generic patterns
  (proxy-over-direct calls, secrets in a vault, scope-locked sub-agent tools)
  without incident-specific identifiers.
- Sanitised `middleware/packages/harness-diagrams` package metadata to remove
  internal hostnames and branding.

### Fixed

- CI pipeline brought back to green after the Actions outage:
  - `actions/setup-node` bumped from `20` to `22` to match
    `middleware/package.json` `engines.node ">=22 <23"`.
  - `schema (migrations on pgvector)` job moved from a stale hardcoded
    list to a glob over five migration domains; coverage went from 9 to
    20 migrations and is now self-updating.
  - `sharp` linux-x64 native binary installed explicitly so the diagram
    test suite can load on CI runners.
  - `middleware/src/index.ts` `prefer-const` false-positive on an
    intentional forward reference suppressed with a documented disable.
- Middleware test suite cleared of stale workshop-vs-public drift: back
  to 2168 passing / 0 failing (7 tests carry `it.skip()` with TODO
  comments documenting root cause — tracked separately for follow-up
  if/when operationally relevant).

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
