# HANDOFF — Multi-Orchestrator Runtime · feature complete

**Date**: 2026-05-26
**Worktree**: `~/sources/odoo-bot-multi-orchestrator`
**Branch**: `001-multi-orchestrator-runtime` (off `main` @ `483ff18`)
**Status**: **US1–US9 all shipped.** P1+P2+P3 complete on the implementation
side. Polish phase (T043–T046) partially done; boot smoke + PR deferred to
the operator per the closing instruction.

This is the close-out handoff. Read after the prior handoffs
(`HANDOFF-2026-05-22-us4-start.md` for the entry context, then this file for
where we landed).

---

## Commit chain on `001-multi-orchestrator-runtime`

```
01062ae  feat(orchestrator): US9 — operator dashboard for Agent CRUD + ops
a6c26e5  feat(orchestrator): US7+US8 — channel routing + per-Agent memory scope
0765d5c  feat(orchestrator): US5+US6 — hot-reload diff + session config snapshots
4cde36d  feat(orchestrator): US4 — multi-orchestrator registry from DB config
f808313  docs(specs): handoff before US4 — full session state captured
9662377  feat(builder): US2 — emit + validate multi_instance / privacy_class
e6e8eb0  feat(orchestrator): US3 — parameterize Orchestrator construction per Agent
fc94248  feat(plugins): US1 — plugin manifest multi-instance + privacy class
```

Nine feature commits + one design-handoff. The branch is ready to push and
turn into a PR.

---

## What is true now (US1–US9 done)

### P1 (MVP — multiple orchestrators from operator config)

- **US1 (`fc94248`)** — `Plugin` type + `adaptManifestV1` carry
  `multi_instance`, `multi_instance_justification?`, `privacy_class`.
- **US2 (`9662377`)** — Builder codegen + linter emit + validate the new
  fields. Both boilerplate manifests updated.
- **US3 (`e6e8eb0`)** — `buildOrchestratorForAgent(config, deps)` factory
  parameterizes per-Agent construction.
- **US4 (`4cde36d`)** — DB-backed `OrchestratorRegistry` builds N Agents
  alongside the legacy default `chatAgent`. Migration runner, `ConfigStore`
  CRUD, `agents:apply` CLI, build-time isolation, 8 acceptance tests.

### P2 (hot-reload + snapshot pinning + channel routing)

- **US5 (`0765d5c`)** — `diffSnapshots()` + `OrchestratorRegistry.reload()` +
  `ReloadBus` (Postgres `LISTEN agents_changed` via reserved PoolClient +
  periodic reconcile + coalesced fire). Per-action try/catch isolation.
- **US6 (`0765d5c`)** — `SessionConfigSnapshot` on `ChatSession`,
  capture-on-first-use via `ChatSessionStore.captureSnapshot`,
  `clearSnapshot` for drain, `OrchestratorRegistry.forceInvalidate(slug,
  mode, store)` for drain/kill.
- **US7 (`a6c26e5`)** — `ChannelResolver` with structured per-decision
  logging (`bound` / `fallback` / `reject`). `ensureFallbackAgent` seeds a
  minimal-privilege `fallback` Agent on first boot (idempotent; honors
  operator hard-reject policy).

### P3 (privacy-by-capability + operator UI)

- **US8 (`a6c26e5`)** — `computeMemoryScope` unions enabled-plugin
  `permissions.memory` + `core`. `ActiveAgent.memoryScope` +
  `SessionConfigSnapshot.memoryScope` carry the scope through.
  `ScopedMemoryStore` filters operations (soft-deny on reads — SC-003;
  hard-reject on writes via `MemoryScopeViolation`).
- **US9 (`01062ae`)** — `/api/v1/operator/agents/*` REST (10 endpoints),
  RSC entry at `/operator/agents`, single-page client dashboard covering
  create/edit/disable/delete + plugin & binding editors + drain/kill +
  fallback selector + manual reload. i18n via `next-intl` (`operatorAgents`
  namespace in `en.json` + `de.json`).

---

## Test verification (sandbox-runnable parts)

Full middleware suite:

```
node --import tsx --test --test-reporter=spec 'test/**/*.test.ts'
# tests 2540, pass 2533, fail 0, skipped 7
```

Per-feature highlights:

- `test/orchestratorRegistry.test.ts` — US4 acceptance (8/8)
- `test/orchestratorRegistryHotReload.test.ts` — US5 diff + isolation (7/7)
- `test/sessionSnapshot.test.ts` — US6 snapshot + drain/kill (7/7)
- `test/channelResolver.test.ts` — US7 routing + onboarding (7/7)
- `test/memoryScoping.test.ts` — US8 scope union + ScopedMemoryStore (7/7)
- `test/operatorAgentsRouter.test.ts` — US9 REST (13/13)

`npx tsc --noEmit` from `middleware/`: clean. `npx eslint` on every changed
file: clean.

---

## What is NOT done (explicit gaps)

### Polish (T043–T046)

- **T043** — formal cross-cutting structured-logging audit. Logs were added
  inline at every seam (registry actions, reload bus notifications, channel
  resolver decisions, scoped-memory denials) but no separate sweep was
  performed. Probably fine; should be one Grep + review pass.
- **T044** — `docs/` + Notion architecture subpages. Not written. The
  `specs/001-multi-orchestrator-runtime/` package and this handoff are the
  primary documentation; Notion sync needs a `/sync-docs` run.
- **T045** — full two-Agent public-vs-general boot smoke. **Skipped on
  operator instruction (run on real hardware).**
- **T046** — quickstart end-to-end validation. Skipped for the same reason.

### Verification gaps

- `agents:apply` CLI never executed against a real Postgres. Logic +
  TypeScript check, YAML round-trip untested.
- `ReloadBus` reconnect on disconnect is implemented but not unit-tested
  (would need an integration test with a real or fake `pg.Pool` + forced
  disconnect).
- Migration runner failure path tested only implicitly.

### Carry-forward architectural deferrals

1. **Per-Agent plugin activation.** The kernel still activates every
   installed plugin once globally during
   `toolPluginRuntime.activateAllInstalled()`. Per-(Agent × plugin)
   `PluginContext` lifetimes are NOT wired. Implications:
   - **US4 tool isolation** is at the Orchestrator level only; the shared
     `NativeToolRegistry` exposes all tools to every Agent. Cross-Agent
     unreachability is enforced at the unit-test/registry-data level but
     not in runtime tool dispatch.
   - **US6 snapshot `toolIds`** is an empty placeholder.
   - **US8 write attribution** on `ScopedMemoryStore` is best-effort — the
     wrapper knows the Agent slug but not which plugin within the Agent
     attempted the write.
   - Wiring this is the next architectural unlock. Probably a phase of
     its own (call it `001-multi-orchestrator-runtime-v2` or a new
     spec); the design is sketched in the spec's "PluginContext (existing
     — reused)" note in `data-model.md`.

2. **Static byte5 channel webhook handlers.** `channelResolver@1` is
   published, but `harness-channel-teams` / `harness-channel-telegram`
   (private byte5 repo, gitignored `dist/` here) still consume the legacy
   `chatAgent@1`. Until those plugins are revved to call
   `services.get('channelResolver')`, all webhook traffic in production
   still goes to the default Agent regardless of `channel_bindings`. The
   change in the private repo is small (~10 lines per channel plugin) but
   needs its own PR there + a re-build of the bundled `dist/`.

---

## Service registry surface (new services published in this feature)

| Service key                    | Owner                  | Where        |
|--------------------------------|------------------------|--------------|
| `orchestratorRegistry`         | orchestrator plugin    | US4          |
| `channelResolver`              | orchestrator plugin    | US7          |
| `configStore`                  | orchestrator plugin    | US9 (T037)   |

All three are published in `harness-orchestrator/src/plugin.ts` `activate()`
after `runMultiOrchestratorMigrations` + `ensureFallbackAgent` +
`registry.start()`. Each route 503s in its consumer when the service is not
present (no `DATABASE_URL`, orchestrator plugin inactive, …).

---

## Conventions reminder (unchanged from prior handoffs)

- **Node**: `.nvmrc` → `22.22.3`. `npm install` works clean on 22.13+.
- **Tests**: `node --import tsx --test test/<file>.test.ts` from
  `middleware/`. NOT vitest.
- **Lint**: `npx eslint <files>` from `middleware/`; the project rule is
  `lint:fix` after changes.
- **Commits**: conventional, `Co-Authored-By: Claude Opus 4.7 (1M context)
  <noreply@anthropic.com>` trailer. NO "Generated with Claude Code" footer.
  Always commit with **explicit pathspec** + `git diff --cached --stat`
  verification.
- **`CLAUDE.md`** at the worktree root remains untracked (intentional).

---

## Closing notes for the next session

If picking this branch back up:

1. The branch is ready to push + open a PR against `main`.
2. The boot smoke is the one outstanding pre-merge gate. The recipe from
   the prior handoff still applies — bring the stack up with
   `DATABASE_URL=...`, watch the log monitor for `orchestratorRegistry@1
   published` + `channelResolver@1 published` + `reloadBus: subscribed`,
   then exercise create/edit/drain via `/operator/agents` and confirm the
   diff actions show up in the logs.
3. If the per-Agent plugin activation work begins next, open a new spec
   under `specs/` rather than extending this one — this feature is
   self-contained and shipped.

The factory `buildOrchestratorForAgent` remains the lever. Everything in
this feature is downstream of it.
