# Omadia Constitution

The non-negotiable engineering principles for the Omadia agentic platform
(`odoo-bot` middleware monorepo + `omadia-byte5-plugins`). Every spec, plan,
task list, and pull request is checked against this document.

## Core Principles

### I. Plugin Isolation & Lifecycle

Every plugin is a self-contained unit with an explicit lifecycle. A plugin
MUST NOT hold mutable state at module scope — all runtime state (clients,
caches, timers, listeners, subscriptions) is created inside `init()` and
released inside `dispose()`. A plugin is multi-instance-safe by default: it
must tolerate being instantiated more than once in the same process against
different scopes. Plugins that genuinely cannot (singleton hardware, exclusive
locks) MUST declare `multiInstance: false` with a written justification.

Rationale: the platform runs many orchestrator instances in one process. A
single leaked timer or shared cache silently corrupts a neighbouring tenant.

### II. Contract-First Extensibility

Cross-package contracts (plugin lifecycle, manifest schema, capability names)
live in exactly one package — `plugin-api` — and are the single source of
truth. Consumers import from there; they never re-declare a contract. A
breaking change to a contract requires a SemVer major bump and a written
migration note. The Agent Builder generates code against the frozen contract,
never against an ad-hoc local copy.

### III. Server-Side Business Logic

Validation, resolution, constraint checking, and transitive walks belong on
the server. The frontend stays thin: display and input only — it never
re-computes business truth. An API returns decided answers, not raw material
for the client to assemble.

### IV. Test-Green Gate (NON-NEGOTIABLE)

No change merges unless `typecheck`, `lint`, and the full affected test suite
are green. Beyond static checks, every implementation step is verified with a
real boot smoke test (dev server + log monitor + request) — static checks
alone never count as "done". Tests that pass in isolation but fail in the full
suite are bugs to be fixed, not ignored.

### V. Privacy by Capability

Data visibility is a set operation over the plugins enabled for an
orchestrator, not an ad-hoc authorization check sprinkled through call sites.
If an orchestrator does not have a plugin enabled, it structurally cannot
reach that plugin's data namespaces. Boundaries are enforced by composition,
not by remembering to check.

### VI. Observability & Diagnostics

Dispatch paths, lifecycle transitions (init/dispose/reconfigure), and routing
decisions emit structured logs with enough context (orchestrator id, plugin
id, session id) to reconstruct what happened. Diagnostic logging is added
proactively on new control-flow seams, not retrofitted after an incident.

## Additional Constraints

- **Language**: TypeScript strict mode, no implicit `any`, `unknown` over `any`.
- **Runtime**: Node `22.12.0` (pinned via `.nvmrc`); fresh shells run
  `nvm use` before npm calls.
- **Workspace**: npm workspace under `middleware/packages/*`.
- **Versioning**: every plugin and shared package follows SemVer; manifests
  carry an explicit version.
- **Repos**: `omadia` is the public single source of truth; private customer
  plugins and the marketing site live in separate repos. Privacy is enforced
  via `.gitignore` + repo separation, never via history rewriting.

## Development Workflow

- **Spec-Driven**: non-trivial features follow spec → plan → tasks → implement.
  The spec is authored and reviewed before implementation begins.
- **Slice discipline**: work ships as independently testable, independently
  deployable increments ordered by priority.
- **Code styling**: run `lint:fix` after changes and fix what it reports;
  never edit i18n JSON directly (i18nexus overwrites it).
- **Review**: every PR verifies constitution compliance; unjustified
  complexity is rejected.

## Governance

This constitution supersedes ad-hoc practice. Amendments require a written
rationale, a version bump, and a migration note when they invalidate existing
code. Any deviation in a plan MUST be recorded in that plan's Complexity
Tracking table with the simpler alternative that was rejected and why.

**Version**: 1.0.0 | **Ratified**: 2026-05-21 | **Last Amended**: 2026-05-21
