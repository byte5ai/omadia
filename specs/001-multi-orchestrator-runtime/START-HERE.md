# START HERE — Multi-Orchestrator Runtime

Orientation note for a fresh session opening this worktree. Read this first,
then `spec.md`.

## What this is

A complete GitHub Spec Kit feature package for turning the single, process-global
`Orchestrator` into a **multi-tenant runtime** — N named "Agent" instances in
one process, each with its own plugin set, channel bindings, memory scope, and
privacy profile; hot-reloadable; operator-managed via UI.

## Status

- **DRAFT.** Authored 2026-05-21. The design is settled; wording is open to
  review.
- **Worktree**: `~/sources/odoo-bot-multi-orchestrator`, branch
  `feat/multi-orchestrator` (off `main` @ `483ff18`).
- **No implementation has started.** This package is spec-only.
- `CLAUDE.local.md` was copied into this worktree manually (it is gitignored and
  not shared between worktrees) — it carries the single-repo setup, where
  `omadia-byte5-plugins` lives, and byte5 identity. Keep it.

## Artifacts & reading order

1. `spec.md` — the WHAT: 9 prioritized user stories (US1–US9), 20 functional
   requirements, 8 measurable success criteria, edge cases, key entities.
2. `plan.md` — the HOW: technical context, constitution check, real monorepo
   paths, P1/P2/P3 phasing.
3. `research.md` — 7 resolved design decisions (D1–D7) with rejected
   alternatives, plus **4 open clarification questions** (see below).
4. `data-model.md` — DB schema (3 tables + `LISTEN/NOTIFY`), extended manifest,
   runtime structures.
5. `contracts/plugin-lifecycle.md` — the frozen `plugin-api` contract:
   `Plugin`/`PluginScope` interfaces, manifest JSON Schema, builder-ready gate.
6. `tasks.md` — 60 tasks (T001–T060) grouped by user story with a dependency
   graph.
7. `../../.specify/memory/constitution.md` — the Omadia engineering constitution
   the plan is checked against.

## Open clarification questions (resolve before locking the plan)

From `research.md` §"Open Questions":

- **Q1** — `force-invalidate`: end sessions immediately, or drain with a grace
  period? (Affects US6.)
- **Q2** — unmatched inbound channel key: hard reject, or a configurable
  fallback Agent? (Affects US7 / FR-015.)
- **Q3** — privacy profiles: is `strict` / `default` enough, or is a
  named/extensible profile set needed? (Affects US4 / US9.)
- **Q4** — session TTL: does `force-invalidate` also clear the session-store
  entry, or only re-bind the snapshot? (Affects US6.)

## Recommended next actions for this session

1. Answer Q1–Q4 with the operator (or run `/speckit-clarify`, which is installed
   as a skill in a fresh session and will work through `spec.md` interactively).
2. Fold the answers into `spec.md` / `research.md`.
3. Optionally run `/speckit-analyze` for a cross-artifact consistency check.
4. Begin implementation with **US1** (freeze the `plugin-api` contract) — it
   blocks every other story. ⚠️ US2 (Agent Builder conditioning) is
   time-critical: the Builder runs in a parallel worktree and must be re-pointed
   at the frozen contract before it emits further plugins.

## Scope guard rails

- **Knowledge-Graph ownership / ACL** is being built in a separate worktree
  (`docs/plans/kg-acl-refactor.md`). Do NOT redesign KG visibility here — this
  feature only consumes its scoping output.
- **Azure AD bot registrations** are an operational task done outside the
  codebase; the operator provides distinct bot identities.
- **Per-record / per-user memory ACL** is explicitly deferred — visibility here
  is coarse-grained (plugin enabled ⇒ namespace visible).
