# HANDOFF — Phase A done · before Phase B (Agent self-service polish)

**Date**: 2026-05-26
**Worktree**: `~/sources/odoo-bot-multi-orchestrator` (git worktree of
`~/sources/odoo-bot` on branch `001-multi-orchestrator-runtime`).
**Branch**: `001-multi-orchestrator-runtime`
**Status**: US1–US9 + Phase A + boot perf fix shipped. Both Fly apps
on the new code. **Next: Phase B (UX/UI hardening).**

Read after `HANDOFF-2026-05-26-feature-complete.md` (the US1–US9 close-out)
and `spec.md` (Phase A spec).

---

## Where we are

Phase A is deployed:

- `https://odoo-bot-middleware.fly.dev` — v224+ (per-deploy bumps), routes
  every chat turn through `OrchestratorRegistry` via the new
  `resolveAgentForRequest()`.
- `https://odoo-bot-harness.fly.dev` — Agent picker in the chat header,
  empty-config CTA, 503-recovery banner, /operator/agents dashboard.

### Commit chain on `001-multi-orchestrator-runtime`

```
135c062  perf(boot): gate backfillGraph behind BACKFILL_AT_STARTUP env (default off)
2166e45  feat(chat): TA01–TA09 — chat surface routes via the multi-orch registry
847eb5e  docs(specs): Phase A spec — chat routes via registry
084c121  fix(web-ui): inline botApi + forwardCookieHeader in operator agents client
3952789  fix(orchestrator): default reloadBus LISTEN to disabled — kg pool too small
d27f992  fix(orchestrator): branch notify_agents_changed by TG_TABLE_NAME
c683543  fix(orchestrator): rename platform_settings → multi_orchestrator_settings
806d42d  fix(orchestrator): migration runner path off-by-one in Docker layout
d0e9a1f  chore: merge origin/main into 001-multi-orchestrator-runtime
f4593f5  chore(orchestrator): i18n + feature-complete handoff
01062ae  feat(orchestrator): US9 — operator dashboard for Agent CRUD + ops
a6c26e5  feat(orchestrator): US7+US8 — channel routing + per-Agent memory scope
0765d5c  feat(orchestrator): US5+US6 — hot-reload diff + session config snapshots
4cde36d  feat(orchestrator): US4 — multi-orchestrator registry from DB config
f808313  docs(specs): handoff before US4 — full session state captured
9662377  feat(builder): US2 — emit + validate multi_instance / privacy_class
e6e8eb0  feat(orchestrator): US3 — parameterize Orchestrator construction per Agent
fc94248  feat(plugins): US1 — plugin manifest multi-instance + privacy class
```

### Live runtime state

- **Registry** holds 1 Agent (`slug=fallback`, auto-seeded). Re-`apply`
  via CLI or the operator UI to add more.
- **`/api/v1/operator/agents/*`** — CRUD + drain/kill + reload + the new
  `GET /enabled` (Phase A chat picker).
- **`/api/chat` + `/api/chat/stream`** — accept optional `agentSlug`,
  pin via US6 snapshot on the first turn, reject 409 on mismatch,
  412 when no fallback, 503 when slug not active.
- **`/api/chat/sessions/:id/re-snapshot`** — clear the pinned snapshot
  (used by the TA08 recovery banner).
- **Boot time** is now <2 min (was ~12 min). `backfillGraph` is the
  default-OFF env-gate landed in `135c062`. Re-enable with
  `BACKFILL_AT_STARTUP=1` only for fresh KG corpus imports.

### Test verification

```
node --import tsx --test 'test/**/*.test.ts'
# 2583 pass / 0 fail / 2 skipped
```

Phase A coverage:
- `test/chatRouterAgentRouting.test.ts` (8/8) — the four routing
  branches + mismatch + unavailable + snapshot capture.

---

## Phase B — Agent self-service polish

Two top-line goals from the operator after the Phase A walkthrough:

### B1. Fallback Agent should ship with EVERY installed plugin by default

The auto-seeded fallback Agent today has zero plugins (intentional in
US7 onboarding — minimum-privilege). The operator finding: this leaves
the chat surface useless on day-1 if the operator hasn't manually
attached plugins, AND it makes the fallback's behaviour silently
degrade as the platform installs new plugins.

**Phase B contract:**
- First-boot onboarding (in `registry/onboarding.ts`) attaches EVERY
  currently-installed plugin to the fallback Agent on creation.
- The wizard introduced in B3 below offers a "Reset fallback to
  all-plugins" button so an operator who pruned the fallback can rehydrate.
- Plugin-install flow (`@omadia/store` package install path) adds
  newly-installed plugins to the fallback automatically — operator
  can opt-out per install.

**Where to wire it:**
- `middleware/packages/harness-orchestrator/src/registry/onboarding.ts`
  — add a `pluginCatalog` param + after `createAgent`, loop and
  `upsertAgentPlugin` for each catalog entry.
- The catalog is `PluginCatalog` from
  `middleware/src/plugins/manifestLoader.ts`. The orchestrator plugin's
  `activate()` doesn't have it today — needs to be plumbed via either
  (a) a new service `pluginCatalog@1` published by the kernel before
  toolPluginRuntime, OR (b) injected into `ensureFallbackAgent`'s caller
  in `middleware/src/index.ts` after the catalog is loaded.

**Cleanest path**: option (a). The `pluginCapabilities@1` service the
spec already references is the natural home — extend it from
`isMultiInstance/isInstalled/getMemoryScope` to also expose
`listInstalled(): string[]`. The orchestrator plugin then reads that
inside `ensureFallbackAgent`.

### B2. Header nav reorganisation — logical clusters + submenus

Today's flat `Nav.tsx` has 9 tabs:

```
Chat · Store · Builder · Memory · Memories · Graph · Routines · Admin · System
```

The new `/operator/agents` is currently NOT in the nav (you have to
type the URL). The privacy operator surface lives at `/operator/privacy`
and was also never in the nav. As features land, the flat layout
becomes unworkable.

**Proposed cluster shape** (subject to operator review — this is the
first sketch, not a final IA):

```
Chat
Agents ▾                      ← NEW cluster, dropdown
  ├ Overview        (/operator/agents — current page)
  ├ Memory          (/memory)
  ├ Memories Browser (/memories)
  └ Graph           (/graph)
Plugins ▾                     ← NEW cluster
  ├ Store           (/store)
  └ Builder         (/store/builder)
Automation
  └ Routines        (/routines — flat for now)
Admin ▾                       ← NEW cluster
  ├ Settings        (/admin)
  ├ System          (/system)
  └ Privacy         (/operator/privacy)
```

**Why this grouping:**
- Memory / Memories / Graph are all read surfaces against the KG that
  belongs to an Agent's scope — they naturally cluster under "Agents."
- Store/Builder are both plugin authoring/install surfaces — "Plugins."
- Admin/System/Privacy are all operator-only surfaces — "Admin."
- Chat + Automation stay top-level (they're the primary user surfaces).

**Implementation notes:**
- `Nav.tsx` becomes a list of cluster definitions, each with optional
  `children`. The render switches to a hover/click dropdown for
  clusters with children, keeps the flat link for leaf clusters.
- Active-link detection: longest-prefix-match still works; just
  applied to the deepest matching `children[].href` first, then the
  cluster header gets a "contains-active" subtle style.
- i18n: each cluster + each child gets its own translation key under
  `nav`. Existing `nav.chat / nav.store / nav.builder / ...` keys stay
  for the children; new keys for cluster headers
  (`nav.agentsCluster / nav.pluginsCluster / nav.adminCluster`).
- Mobile: clusters become `<details>` blocks in the hamburger drawer
  (`web-ui/app/_components/MobileNav.tsx` if it exists, else add).

### B3. Agent-config wizard (from the original Phase B spec)

This was the original Phase B from the UX analysis after US9 deploy:
**structured editors instead of textareas**. Specifically:

- Plugin multi-select with `multi_instance` badge, memory-scope
  preview, permissions overview (replaces the `plugins[]` textarea on
  the /operator/agents Agent card).
- Channel binding form with dropdown of installed channel types
  (Teams / Telegram / …) — replaces the `type<TAB>key` textarea.
- Routing tester ("Which Agent handles teams/<key>?") sitting next
  to the binding editor.
- The "Reset fallback to all-plugins" button from B1.
- Plugin-config editor per (Agent × plugin) — uses each plugin's
  `setup_fields` schema (already in the manifest) to render typed
  forms with the right widget per type (string / enum / host_list).

These all live on /operator/agents — they enlarge the existing
dashboard rather than spawning new pages.

---

## What is NOT done (carry-forward intact from prior handoffs)

These remain deferred and unchanged by Phase A:

1. **Per-Agent plugin activation.** Every installed plugin still
   activates once globally during `toolPluginRuntime.activateAllInstalled()`.
   Implications: `SessionConfigSnapshot.toolIds` is still an empty
   placeholder; `ScopedMemoryStore` write-attribution is best-effort;
   the `agent:apply` rule "this plugin is on Agent A, not on Agent B"
   is enforced at the registry level but the underlying runtime
   exposes everything to every Orchestrator. Phase A's chat-router
   pins each session to a specific Orchestrator, which IS an isolated
   instance with its own `ChatSessionStore` + `SessionLogger`. So
   session-state isolation works; tool/permission isolation needs the
   per-(Agent × plugin) PluginContext refactor.

2. **Static byte5 channel webhook handlers** (Teams / Telegram in the
   private `omadia-byte5-plugins` repo) still consume the legacy
   `chatAgent@1` directly. They need their own PR to call
   `services.get('channelResolver@1')`. Until then, channel webhook
   traffic bypasses Phase A and goes to the default Agent.

3. **T043** structured-logging audit, **T044** Notion docs sync,
   **T045** full two-Agent boot smoke, **T046** quickstart end-to-end
   — all still un-done from the original tasks.md Phase 12.

4. **PR push to GitHub.** Nothing has been pushed; everything was
   deployed via local fly worktree. Operator instructed "kein
   rollback" + "skip PR" — that policy may need to change before the
   next phase. The branch has 18 commits ahead of `origin/main`.

---

## Sandbox / deploy reminders

- **Boot smoke**: now feasible because boot is <2 min after `135c062`.
  Recipe: `fly deploy --remote-only` from
  `~/sources/odoo-bot-multi-orchestrator/` (middleware) or `web-ui/`
  (harness). Monitor: `fly logs -a <app> 2>&1 | grep -vE "capture-filter|hook 'on"`.
- **Fly app names**: `odoo-bot-middleware`, `odoo-bot-harness`.
- **Fly configs** live ONLY in `~/sources/odoo-bot` (gitignored;
  copied into the worktree on-demand for deploys).
- **Pool max** on the kg pool is still 5. The reloadBus has LISTEN
  disabled by default for this reason (commit `3952789`). Raising
  pool max is its own ticket; until then keep the LISTEN flag off.
- **Boot order** (post-`135c062`):
  1. plugin runtime activate (≤30s)
  2. registry start + onboarding seed
  3. dynamic agents activate (~15s)
  4. router mounts
  5. app.listen (≤1 min total)

---

## Suggested Phase B order

Smallest-first to keep PRs reviewable:

1. **B1 (default-all-plugins)** — backend-only, ~50 lines, no UI
   churn. Lands the new behaviour for fresh deploys; existing
   fallback Agents stay as-is until the operator hits a "rehydrate"
   button in B3.
2. **B2 (nav reorganisation)** — UI-only, no backend touch. Sets the
   shape for everything else.
3. **B3 (structured editors + wizard)** — biggest single PR;
   benefits from B1+B2 being already merged. Suggest splitting:
   - B3a plugin multi-select with metadata
   - B3b channel-binding form + routing tester
   - B3c plugin-config editor with `setup_fields` schema
   - B3d "Reset fallback to all-plugins" button

The full UX backlog from the post-US9 analysis (Phase C plugin-
config-per-agent, Phase D runtime visibility) waits behind B.

---

## One-liner to resume

```
cd ~/sources/odoo-bot-multi-orchestrator
git log --oneline -8
cat specs/002-chat-routes-via-registry/HANDOFF-2026-05-26-phase-A-done-before-phase-B.md
# Pick a Phase B sub-task and grep for B1 / B2 / B3 above for the
# concrete entry points.
```

The registry is the lever everywhere. Phase B doesn't change its
contract — it just gives the operator better controls to configure it.
