# START HERE — Multi-Orchestrator Runtime

Orientation note for a fresh session opening this worktree. Read this first,
then `spec.md`.

## What this is

A complete GitHub Spec Kit feature package for turning the single, process-global
`Orchestrator` into a **multi-tenant runtime** — N named "Agent" instances in
one process, each with its own plugin set, channel bindings, memory scope, and
privacy profile; hot-reloadable; operator-managed via UI.

## Status

- **Implementation-ready.** Authored, clarified, `/speckit-analyze`-checked,
  and re-baselined against codebase reality — all 2026-05-21. P1 (US1–US3) was
  re-scoped after the existing plugin lifecycle was discovered; see the revision
  note in `spec.md`.
- **Worktree**: `~/sources/odoo-bot-multi-orchestrator`, branch
  `001-multi-orchestrator-runtime` (off `main` @ `483ff18`).
- **No implementation has started.** This package is spec-only.
- `CLAUDE.local.md` was copied into this worktree manually (it is gitignored and
  not shared between worktrees) — it carries the single-repo setup, where
  `omadia-byte5-plugins` lives, and byte5 identity. Keep it.

## Artifacts & reading order

1. `spec.md` — the WHAT: 9 prioritized user stories (US1–US9), 21 functional
   requirements, 8 measurable success criteria, edge cases, key entities.
2. `plan.md` — the HOW: technical context, constitution check, real monorepo
   paths, P1/P2/P3 phasing.
3. `research.md` — 7 resolved design decisions (D1–D7) with rejected
   alternatives, plus 4 clarifications resolved 2026-05-21 (C1–C4).
4. `data-model.md` — DB schema (4 tables + `LISTEN/NOTIFY`), the 2-field
   manifest extension, runtime structures.
5. `contracts/plugin-lifecycle.md` — the existing `activate`/`close` /
   `PluginContext` lifecycle (referenced, not redefined) + the `multiInstance` /
   `privacyClass` manifest extension.
6. `tasks.md` — 46 tasks (T001–T046) grouped by user story with a dependency
   graph.
7. `../../.specify/memory/constitution.md` — the Omadia engineering constitution
   the plan is checked against.

## Clarifications — resolved 2026-05-21

The four open questions (Q1–Q4) are resolved and folded into the spec, data
model, and tasks. Detail in `research.md` §"Clarifications — resolved
2026-05-21" (C1–C4):

- **C1** — `force-invalidate` is two-mode: `drain` (default, bounded by the
  per-turn timeout) and `kill`.
- **C2** — unmatched channel key → configurable `fallbackAgentId`, else
  hard-reject; onboarding seeds a bare-LLM fallback Agent (FR-021).
- **C3** — privacy profile stays a `strict`/`default` enum, recorded but not
  yet enforced; modelled for a later extensible profile table.
- **C4** — `drain` keeps the session-store entry, `kill` discards it.

A `/speckit-analyze` consistency pass was run; all findings were remediated.

## Recommended next actions for this session

Clarification, analysis, and the P1 re-baseline are done — the spec package is
implementation-ready.

1. Begin implementation with **US1** (extend the plugin manifest with
   `multiInstance` / `privacyClass`) — small and foundational. Work `tasks.md`
   top-down (T001 → …).
2. **US3** (per-Agent `Orchestrator` construction) is the structural unlock for
   US4 — it can run in parallel with US1/US2.

## Scope guard rails

- **Knowledge-Graph ownership / ACL** is being built in a separate worktree
  (`docs/plans/kg-acl-refactor.md`). Do NOT redesign KG visibility here — this
  feature only consumes its scoping output.
- **Azure AD bot registrations** are an operational task done outside the
  codebase; the operator provides distinct bot identities.
- **Per-record / per-user memory ACL** is explicitly deferred — visibility here
  is coarse-grained (plugin enabled ⇒ its `permissions.memory` scope visible).
