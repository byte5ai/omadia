# Dev Platform → Installable Plugin

Extraction plan for epic #470's Dev Platform, including its navigation surface.

Status: phase 1 shipped, remainder proposed
Owner: byte5
Related: epic #470, PR #496, #497, #529

> This plan was adversarially reviewed twice (GPT-5.4 via codex, and an
> architecture pass) before implementation. Both reviews found the same
> inverted premise about plugin authentication; §3 reflects the corrected
> version, not the original. Numbers below are measured, and the ones the
> reviews disputed were re-measured — where a review was itself wrong, the
> footnote says so.

---

## 1. Goal

Turn the Dev Platform from a hard-wired core subsystem into an **installable,
uninstallable plugin** — one that brings its own backend, its own database schema, its
own configuration, and **its own menu entries** — without regressing behaviour, security
posture, or the operator experience.

Success is binary and observable:

- With the plugin **not installed**, `middleware` boots with zero dev-platform code
  paths, no `dev_*` tables required, no `DEV_*` config required, and **no Dev Platform
  entry in the navigation**.
- With the plugin **installed and active**, the Dev Platform works exactly as it does
  today, and its menu entries appear — contributed by the plugin, not hardcoded in the
  shell.

---

## 2. Current state

| Surface | Size |
|---|---|
| `middleware/src/devplatform/**` | 54 files, 14,498 LOC |
| `middleware/src/routes/devPlatform*.ts`, `devRunnerApi.ts`, `devRunnerJobPolicyRoute.ts` | 7 files, 2,733 LOC |
| `middleware/src/routes/devWebhooks.ts`, `src/conductor/devJobStepEffect.ts` | 2 files, 394 LOC |
| `middleware/sidecars/dev-runner-daemon/` | 30 files (dockerode) |
| `middleware/packages/dev-runner-shim/` | 21 files, zero deps |
| `middleware/test/devplatform/**` | 54 files |
| `web-ui/app/admin/dev-platform/**` | 20 files, 3,163 LOC |
| `web-ui/app/_components/devjobs/**` + `_lib/useDevJobEvents.ts` | 7 files, 890 LOC |
| Database | 9 tables, 14 indexes, migrations `0022`–`0030` |
| Config | **41** `DEV_*`/`FLY_*` keys — 37 in the `config.ts` dev-platform block plus 4 elsewhere (`DEV_WEBHOOKS_ENABLED`, two webhook rate limits, `DEV_JOB_DEFAULT_BUDGET_USD`) |
| i18n | **281** keys — `adminDevPlatform.*` (269) + `chat.devJob.*` (9) + `admin.index.cards.devPlatform.*` (2) + `nav.devPlatform` (1), of 3,131 total |

### The coupling cut-line

Only **nine** core files reference dev-platform — the boundary is already almost clean.

| Core file | Coupling |
|---|---|
| `middleware/src/index.ts` | 15 imports, ~210 lines of wiring in two gated blocks (webhook router; main block) |
| `middleware/src/config.ts` | 41 schema keys, boot-refusal hook `devPlatformBootRefusals`, post-processing |
| `middleware/src/auth/publicPaths.ts` | 2 exemptions `:28-35` |
| `middleware/src/conductor/runExecutor.ts`, `awaitStore.ts` | dev-job-shaped port API (`DevJobStepPort`) — core-owned, devplatform-free by design |
| `middleware/src/platform/pluginContext.ts` | `ctx.devJobs` gating `:747-754`, `DevJobsHostService` |
| `middleware/packages/plugin-api/src/pluginContext.ts` | published `DevJob*` types |
| `middleware/src/plugins/manifestLoader.ts` | `permissions.devJobs` key |
| `middleware/src/plugins/builder/githubAppAuth.ts` | `import { mintAppJwt } from '../../devplatform/githubApp/appJwt.js'` `:1` — **the one true leak** |
| `middleware/src/services/ssrfGuard.ts` | comment only |

**Database is clean**: zero foreign keys cross the boundary in either direction. Two soft
links exist, both unconstrained text: `dev_jobs.conductor_await_id` (migration `0024:21`)
and `dev_repo_plugin_grants`, which keys operator grants to plugin ids — the latter
matters for uninstall (§6).

**Dependencies are clean**: `middleware/package.json` has zero dependencies that exist
only for dev-platform. `dockerode` lives in the sidecar's own package; the GitHub clients
are hand-rolled `fetch` by house style.

**Layering is not clean**: `wireDevPlatform.ts:37,45,50,51` imports *up* into
`src/routes/`, which imports back *down* into `src/devplatform/*` (23 times). Circular by
layer, resolved only by ESM hoisting. This must be untangled before the code can move.

---

## 3. The crux: the capability gaps

The plugin API cannot express what the Dev Platform needs. This is the real work; moving
files is the easy part.

| # | Gap | Status |
|---|---|---|
| **G1** | **No plugin could contribute a navigation entry.** `Nav.tsx` was a frozen `const NAV` literal; nothing in the frontend read plugin state to build menus. | **Closed** — see §5 |
| **G2** | **A plugin cannot opt a route prefix *out* of authentication.** See below — this is the inverse of what it first appears to be. | Open |
| **G3** | **A plugin router cannot receive a raw request body.** The GitHub webhook receiver needs untouched bytes for HMAC and is mounted *before* `express.json` on purpose. Plugin routers mount at boot flush, after it. | Open |
| **G4** | **No kernel mechanism for plugin-owned SQL.** `onMigrate` is *config* migration only. | Open (softer than it looks) |
| **G5** | **No plugin-declared external services.** No `services:`/`image:` in the manifest; sidecars are operator-managed compose overlays. | Won't fix — see below |
| **G6** | **`publicPaths` is a frozen literal.** A plugin cannot contribute an auth exemption, and core cannot revoke one on uninstall. | Open — **blocks P2** |

### G2 is the inverse of the obvious reading — and it is a trap

The tempting diagnosis is "plugin routers get no authentication": `pluginRouteRegistry.ts`
mounts the router bare, and `pluginContext.ts` says auth "remains the plugin's
responsibility". Both true, and both misleading.

`middleware/src/index.ts` mounts `app.use('/api', requireAuth, createChatRouter(...))`,
and `pluginRouteRegistry.mountAll(app)` runs **later** in the same file. Express runs that
middleware for every `/api/*` request regardless of which router finally answers, so **any
plugin router registered under `/api` is already session-gated.** No existing plugin
noticed because they all register outside `/api` (`/diagrams`, `/documents`, `/p/...`).
`publicPaths.ts` states this in-source, and records the exact bug it was written to
prevent — epic #470's own runner router 401'ing in production while its e2e test passed
against a bare `express()` app.

The consequences for this plan are sharp:

- Adding an `auth: 'session'` option is defence-in-depth, not a new capability.
- Adding an `auth: 'none'` option that a plugin can self-declare would be a **security
  regression** — today the exemption list is a core-owned, reviewed constant.
- **A naive P2 that "deletes the 2 exemptions from `publicPaths.ts`" takes production
  down.** Runners phone home with a `djr_` job token and no session cookie; without the
  exemption `requireAuth` 401s them before the plugin router ever sees the request, and
  every job in flight dies. Same for the GitHub App install callback.

So the real gap is **G6**, and it must be solved as a declarative, install-time,
operator-consented grant (a manifest `permissions.public_paths[]` surfaced in the install
dialog and revoked on deactivate) — never a runtime escape hatch on `RoutesAccessor`.

### G3: not via `express.json`'s verify hook

An early draft proposed capturing raw bytes in `express.json`'s `verify` callback. That is
unsound: `verify` only fires when the body parser's `type` matcher accepts the request,
and the webhook deliberately uses a route-local `express.raw({ type: '*/*' })`. Widening
the global matcher to compensate would force non-JSON traffic through the JSON parser, and
would silently raise the webhook's deliberate 512 KB limit to the global 10 MB on an
unauthenticated, internet-facing endpoint.

The correct mechanism is a `rawBody: true` flag that makes the **registry** mount a
route-local raw parser ahead of the plugin router at its own prefix. No interaction with
global body parsing at all.

### G4 is softer than it looks

There is already a working precedent for plugin-owned migrations:
`harness-knowledge-graph-neon` reads its own `database_url` secret, builds its own
`pg.Pool`, and runs its own bundled `src/migrations/*.sql`, with a `copy-sql-assets` build
step and a `Dockerfile` line to ship the SQL next to the compiled migrator.
`harness-memory-postgres` does the same.

G4 therefore needs the existing pattern formalised into a shared helper plus a `pgPool`
capability so the plugin can reuse the core pool — not a new kernel subsystem.

**Do not renumber the migrations.** Ledgers key on filename. `0022`–`0030` are already
recorded in `_multi_orchestrator_migrations`; a plugin-local ledger renumbered to
`0001`–`0009` would see nine unknown names and **re-execute all of them against live
tables**. `CREATE TABLE IF NOT EXISTS` survives that; `0025`'s
`DROP CONSTRAINT` → `ADD CONSTRAINT` does not. Keep the filenames and ship a one-time
ledger handoff that seeds the plugin ledger from the existing rows — filename stability is
what makes that a `SELECT … INSERT` rather than a fragile name-mapping table.

### G5 is honestly out of scope

A ZIP cannot ship a container. The dev-runner daemon, docker-in-docker, and egress proxy
stay **operator-provisioned** via `docker-compose.dev-platform.yaml`, documented in the
plugin's localised `setup.guide`, with the plugin refusing to activate (clear error, not a
crash) when `DEV_RUNNER_DAEMON_URL` is unreachable.

---

## 4. Architecture decision

### 4.1 What the plugin owns

`@omadia/plugin-dev-platform` at `middleware/packages/harness-plugin-dev-platform/`, as a
**built-in package** (`kind: extension` — capability resolution only exists in
`ToolPluginRuntime`, which handles `tool`/`extension`/`integration`). It owns
`src/devplatform/**`, all dev-platform routers including `devRunnerApi.ts` and
`devWebhooks.ts`, its own migrations, its config, and its nav contribution.

`devRunnerApi.ts` belongs in the plugin: it has zero core dependencies and is versioned
with the **shim**, not with core (`RUNNER_PROTOCOL_VERSION`). A protocol whose counterpart
is a separately-deployed artifact belongs with the artifact that defines it. Core keeps
only the *decision* that its prefix is unauthenticated (G6).

The LLM proxy stays inside this plugin. It is already generic by injection, and it has
exactly one consumer; extracting a package for one consumer is speculative generality.

### 4.2 What stays in core

- `DevJob*` types in `@omadia/plugin-api` — a published, versioned contract that
  third-party plugins consume via `ctx.devJobs`.
- `DevJobStepPort` / `devJobStepEffect.ts` — core-owned conductor port interfaces, already
  devplatform-free by design.
- `mintAppJwt` — moves **out** of devplatform into `src/platform/githubAppJwt.ts`, closing
  the `builder/githubAppAuth.ts:1` leak. It is generic GitHub App JWT minting.

**Unresolved contract question, and it must be answered before any code moves.** Making
dev-platform a plugin inverts `ctx.devJobs` from always-available to
available-if-installed. Two gates govern it and **they are not connected**: exposure is
gated on `permissions.devJobs` alone, while activation *ordering* comes only from manifest
`requires`. Worse, `dynamicAgentRuntime` calls `topoSortByDependsOn(eligible, catalog)`
with no capability edges at all — capability ordering exists **only** in
`ToolPluginRuntime`. So topo-sort does not save this, and a consumer plugin either fails
to activate in a way that never self-heals, or defers its failure to the first production
request. Decide explicitly: does `permissions.devJobs` imply `requires: devJobs@1`, and is
`DevJobsAccessor` optional-by-value or optional-by-presence? Then version `plugin-api`
accordingly. Keeping the types while silently making the runtime optional preserves the
type signature and breaks the contract — invisibly to `tsc`.

### 4.3 The UI: a two-tier contract

A ZIP cannot ship React into an ahead-of-time-compiled Next.js app — the extension
allowlist has no `.tsx`, and `web-ui` is built once at image build time. But dev-platform
is not going to be a ZIP: it is a **built-in package**, which ships inside the middleware
image and goes through the same activation pathway. For that tier, "the React stays
compiled into web-ui" is not a compromise, it is the correct design — both halves ship in
the same image and are versioned together.

So write the tiering down instead of hedging:

| Tier | Who | UI mechanism | Nav |
|---|---|---|---|
| 1 — built-in package | ships in the image | React compiled into web-ui, runtime-gated on the plugin being active | absolute in-app path |
| 2 — uploaded ZIP | third party | iframe of plugin-served HTML (`admin_ui_path`, `/p/:path*`, shared theming) — already exists | `/p/<id>/...` path |

One nav mechanism serves both. A nav API that only served tier 1 would be a feature flag
with extra steps.

Constraint worth preserving: the dev-platform pages are already pure `'use client'`
components talking to `/bot-api/...` — effectively a SPA. **No dev-platform page may
become a server component**, so a future tier-2 port stays mechanical rather than a
rewrite.

Rejected: a workspace package for the pages (adds monorepo plumbing for modularity a
directory and a lint rule already give), an iframe rewrite of these pages (throws away
3,163 LOC of Lume React and 281 i18n keys for an internal operator surface), Next.js
multi-zone (a second deployment, no installability gain), module federation (not viable
with App Router + RSC), and a separate optional web-ui build (two images in lockstep).

### 4.4 Nav contribution design (G1 — shipped)

Extends the existing `UiRouteCatalog` rather than adding a third parallel catalog beside
it and `admin_ui_path`. Nav entries are a **separate registration** on that catalog, not a
field on `UiRouteDescriptor`, because the two `path` semantics differ: a uiRoute descriptor
is relative to the plugin's `/p/<pluginId>` mount, a nav entry is an absolute in-app path.
Folding them together would make one of the two fields a lie.

Labels are **resolved server-side for the requested locale** and the browser never sees
the per-locale map. The alternative — a client fetch of pre-resolved strings — puts the
shell on two i18n clocks: on a locale switch, next-intl's server-rendered labels flip
immediately while fetched labels lag, rendering a half-German nav. Fetching in the root
layout instead means correct-on-first-paint, no hydration shift, and one clock.

Every field is validated as untrusted input, because it renders inside the shell's own
trusted header: `href` confined to single-slash in-app paths (blocking `//host`,
`/\host`, and schemes), labels length-capped and screened for control and
bidirectional-formatting characters (Trojan-Source spoofing of adjacent core entries).

---

## 5. Shipped in this PR (phase 1)

Delivered standalone value with **no dev-platform code moved** — deliberately, so the
riskiest steps are not coupled to the visible win.

1. **Nav contribution API, end to end.**
   `UiRouteCatalog.registerNav()` + `listNav(locale)` with full validation;
   `ctx.uiRoutes.registerNav()` on the plugin contract;
   `GET /api/v1/ui/navigation` (session-gated, `no-store`);
   `fetchNavEntries()` fetched server-side in the root layout;
   `mergeNav()` in `Nav.tsx` merging static and contributed entries.

   Merge rules: a plugin entry joins the cluster it names; an entry with an unknown or
   absent cluster is promoted to top level rather than silently swallowed by version skew;
   plugin entries sort among themselves and never reorder static items; **an entry
   colliding with a static href is dropped** so a plugin cannot shadow a core destination.

2. **Dev Platform is the first consumer.** Its menu entry is now registered from the
   existing `DEV_PLATFORM_ENABLED` block and removed from `Nav.tsx`'s literal. Turn the
   feature off and the entry — and the `/admin` grid card, via a new `requiresNavHref`
   flag — are gone, with no frontend rebuild. When the plugin package lands, this call
   becomes `ctx.uiRoutes.registerNav(...)` inside its `activate()` and nothing about the
   shell changes.

3. **Fixed a live bug found while mapping the extraction.**
   `ToolPluginRuntime.deactivate()` stopped jobs and disposed UI routes but **never called
   `pluginRouteRegistry.disposeBySource()`** — though it held the dependency and threaded
   it into every plugin context. `DynamicAgentRuntime` did. Express cannot unmount, so a
   deactivated tool plugin's routers stayed live and, because Express matches
   first-mount-wins, kept serving after uninstall and shadowed later mounts at the same
   prefix after a hot-upgrade.

   This is a prerequisite, not a drive-by: the success criterion "with the plugin not
   installed, no dev-platform code paths" is **unverifiable** while routers outlive their
   plugin. The regression test fails 3/4 without the one-line fix.

Tests: 29 catalog, 11 route, 4 disposal (middleware, `node:test`), 12 merge (web-ui,
vitest). Full suites green — middleware 4,890 pass / 0 fail, web-ui 331 pass.

---

## 6. Remaining phases

Reordered from the original draft: the visible deliverable moved first (done), and the
single irreversible step moved last.

| Phase | Content | Observable outcome |
|---|---|---|
| **P2a** | Decide the `ctx.devJobs` contract (§4.2) and version `plugin-api`. Add capability edges to `dynamicAgentRuntime`, or document why agent plugins are excluded. | A written, versioned contract — before any code depends on it |
| **P2b** | Break the `wireDevPlatform ↔ routes` cycle; move `mintAppJwt` to `src/platform/githubAppJwt.ts`; collapse the 41 config keys into one namespaced object. | `index.ts` wiring reduced to one `assembleDevPlatform(cfg)` call |
| **P3** | **G6** dynamic `publicPaths` via manifest-declared, operator-consented grants + **G2** `auth: 'session'` composed *inside* the disposed guard + **G3** route-local raw parser + **G4** `pgPool` capability and shared `runPluginMigrations`. | Any plugin can own routes, exemptions, raw bodies, and tables |
| **P4** | Create the package, move the code, relocate 54 tests. **Do not delete the `publicPaths` exemptions until P3's mechanism is proven on the live runner phone-home path.** | Dev Platform installs and uninstalls |
| **P5** | Migration ownership handoff (no renumbering) + `copy-sql-assets` + `Dockerfile` line, tested against a database restored from a production snapshot. Its own PR, its own rollback story. | Plugin owns its schema |

**Config is not 41 `setup.fields`.** The keys are four different things and only one
belongs in a manifest form: platform-injected env (`FLY_APP_NAME` is a probe, not a
question), deployment facts belonging to the compose overlay G5 already leaves to the
operator, cross-field safety interlocks, and ~12–15 genuine operator-policy knobs
(budget, retention, concurrency, allowed models). Only the last group becomes
`setup.fields`. The interlocks — `SUBSCRIPTION_MODE` without `_ACK`, `UNSAFE_LOCAL`
without `LOCAL_UID` — cannot be expressed in a flat field list, and shipping them as two
independent optional booleans would **silently delete a boot-time safety refusal**. They
become activation refusals in `activate()`, which is strictly better than today: one
misconfigured plugin no longer takes the host offline.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| **Deleting `publicPaths` exemptions kills in-flight jobs** | P4 is explicitly blocked on P3's dynamic mechanism being proven live. Called out in §3 |
| **Migration handoff is irreversible** | Moved to last, no renumbering, ledger seed, snapshot-restored test, own PR |
| **Wire paths are load-bearing** | **Invariant: no phase may change `/api/v1/dev-runner`, `/api/v1/admin/dev-platform`, `/api/webhooks/github`, or `RUNNER_PROTOCOL_VERSION`.** Deployed runner images phone home to literal URLs; a rename bricks in-flight jobs with no compile-time signal |
| **`ctx.devJobs` inversion breaks third parties invisibly** | P2a resolves it as a contract decision before implementation |
| **Uninstall data lifecycle is undefined** | Must be decided in P4: what happens to 9 tables on uninstall; who cleans `dev_repo_plugin_grants` when a *granted* plugin is removed; what happens to `running` jobs whose runner still holds a valid token |
| **Secrets are vaulted under core's namespace** | GitHub App private keys, webhook secrets, and the proxy's provider key live under `core:dev-platform`. P4 must re-key into the plugin namespace or grant read access — operator-visible either way |
| **Half-migrated codebase** | Each phase has an observable outcome above. **Abandonment checkpoint: after P3, the platform capabilities stand alone and dev-platform stays in core with no partial-move debt.** Half-moved is the only genuinely bad end state |
| **SSE is not horizontally scalable** | Pre-existing (one in-process `EventEmitter` per job). Flagged, not fixed here |
| **Dead conductor bridge** | `devJobConductorBridge.ts` has no production wiring — only a test imports it. Wire it or delete it in P4; do not carry dead code into a published package |

---

## 8. Out of scope

- Shipping React components inside a plugin ZIP (needs a remote-module system).
- Runtime provisioning of docker sidecars from a manifest.
- Per-role / capability-based navigation gating — no such primitive exists today; every
  logged-in operator sees every entry, and that is unchanged by this work.
- Making the job-event SSE horizontally scalable.
- Plugin package signing (`signature:` is documented but unparsed; `signed` is hardcoded
  `false`).
