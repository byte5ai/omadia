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
uninstallable plugin living in its own repository** — one that brings its own backend, its
own database schema, its own configuration, its own UI, and **its own menu entries** —
without regressing behaviour, security posture, or the operator experience.

Success is binary and observable:

- With the plugin **not installed**, `middleware` boots with zero dev-platform code
  paths, no `dev_*` tables required, no `DEV_*` config required, and **no Dev Platform
  entry in the navigation**.
- With the plugin **installed and active**, the Dev Platform works as it does today, and
  its menu entries appear — contributed by the plugin, not hardcoded in the shell.
- **The `omadia` repository contains no reference to the Dev Platform at all.**

### Two constraints added after the first draft

1. **The plugin lives in its own repository** (like `omadia-byte5-plugins` and
   `omadia-plugin-starter`), not in `middleware/packages/`.
2. **Every hardcoded dev-platform part is removed from core** — not gated, not
   feature-flagged: absent.

They sound small. They are not, and they invalidate two decisions in the first draft:

- **The plugin can no longer be a built-in package.** §4.1 previously placed it in
  `middleware/packages/harness-plugin-dev-platform/`, shipping inside the middleware
  image. An own repo makes it a **distributed (tier-2) plugin**, which is a materially
  weaker delivery vehicle — see §4.3.
- **The React pages can no longer stay compiled into web-ui.** §4.3 previously argued
  that was correct *because* both halves shipped in the same image. Under constraint 2
  those 3,933 LOC are hardcoded core references and must go, which resurfaces the
  "a ZIP cannot ship React" problem the first draft had sidestepped.

Concretely: **276 hardcoded items across 18 zones, ≈49,100 LOC across ~200 files.** Full
work-list in `core-decoupling-checklist.md`. Three of those items are not deletions at all
— core has no extension point for them, so a new generic mechanism has to be built first
(H1 public paths, H3 chat tool-card renderers). H2 turned out NOT to need one: the
conductor coupling was dead, so C5 deleted it rather than genericising it.

---

## 2. Current state

| Surface | Size |
|---|---|
| `middleware/src/devplatform/**` | 53 files, 14,520 LOC |
| `middleware/src/routes/devPlatform*.ts`, `devRunnerApi.ts`, `devRunnerJobPolicyRoute.ts` | 7 files, 2,733 LOC |
| `middleware/src/routes/devWebhooks.ts`, `src/conductor/devJobStepEffect.ts` | 2 files, 394 LOC |
| `middleware/sidecars/dev-runner-daemon/` | 30 files (dockerode) |
| `middleware/packages/dev-runner-shim/` | 21 files, zero deps |
| `middleware/test/devplatform/**` | 54 files |
| `web-ui/app/admin/dev-platform/**` | 29 files, 4,344 LOC (PR #529) |
| `web-ui/app/_components/devjobs/**` + `_lib/useDevJobEvents.ts` | 7 files, 884 LOC |
| Database | 9 tables, 14 indexes, migrations `0022`–`0030` |
| Config | **41** dev-platform `DEV_*`/`FLY_*` keys — 37 in the `config.ts` dev-platform block plus 4 elsewhere (`DEV_WEBHOOKS_ENABLED`, two webhook rate limits, `DEV_JOB_DEFAULT_BUDGET_USD`). `config.ts` holds 42 distinct `DEV_*`/`FLY_*` identifiers in total; the 42nd, `DEV_ENDPOINTS_ENABLED`, is generic and stays in core |
| i18n | **281** keys before this PR — `adminDevPlatform.*` (269) + `chat.devJob.*` (9) + `admin.index.cards.devPlatform.*` (2) + `nav.devPlatform` (1), of 3,131 total. Now 280 of 3,130: this PR removed `nav.devPlatform`, since the label ships with the plugin |

### The coupling cut-line

Ten core files reference dev-platform (`runExecutor.ts` and `awaitStore.ts` share a row
below) — the boundary is already almost clean.

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
`src/routes/`, which imports back *down* into `src/devplatform/*` (23 times).

**Corrected after review:** an earlier revision called this "circular by layer, resolved
only by ESM hoisting." It is **not** an import cycle — `wireDevPlatform` is imported only
by `index.ts`, and no route imports back into it. It is a one-way layering inversion.
Untangling it is boundary cleanup that makes the move mechanical, **not** a fix for
hoist-dependent runtime behaviour, and it should not be justified as the latter.

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
| **G6** | **`publicPaths` is a frozen literal.** A plugin cannot contribute an auth exemption, and core cannot revoke one on uninstall. Needs prefix ownership too, not just a grant. | Open — **hard blocker** (H1) |
| **G7** | **A distributed plugin cannot ship a React UI.** The ZIP allowlist has no `.tsx`, and web-ui is built once at image build time. The missing `.css` is **no longer the blocker** — a core-served Tailwind subset removes the need for plugin CSS entirely (§4.3a, measured). | Open — reduced to the JS-bundle question |
| **G8** | **`DevJob*` are published `@omadia/plugin-api` types.** Removing them is a SemVer-major break for every Hub plugin importing them; `api/admin-v1.ts` leaks `dev_jobs` onto the public admin DTO too. | Open — new |
| **G9** | **The conductor hardcodes the `dev_job` step kind and channel type** — 73 refs across `runExecutor.ts`, `awaitStore.ts`, `routes.ts` and all of `devJobStepEffect.ts`. | **No longer a blocker.** The capability is dead with no demand, so the fix is DELETE (~600 LOC), not a generic registry. See `dormant-capabilities.md` §1 |
| **G10** | **The chat renderer hardcodes `tool.name === 'dev_job_start'`** and renders a core-compiled React card for it. | Open — **hard blocker** (H3) |

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

**A grant alone is not sufficient.** `publicPaths` only makes `requireAuth` call `next()`
for a URL; it says nothing about *which* router is entitled to answer it. If plugin A is
granted a prefix and does not handle some subpath, plugin B mounted at the same prefix
receives that request unauthenticated. The grant must therefore be paired with **exclusive
prefix ownership** (register-time collision rejection) or enforced inside a per-entry
dispatcher rather than as a global URL bypass.

Note also that the blanket `/api` gate is not universal: `publicPaths` already exempts
several prefixes, so a plugin registering beneath one of those is unauthenticated today
without declaring anything. Prefix ownership fixes that too.

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

G4 therefore needs the existing pattern formalised into a shared helper plus a permission gate on the existing `graphPool@1`
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

`@omadia/plugin-dev-platform`, in **its own repository** (`byte5ai/omadia-plugin-dev-platform`,
alongside `omadia-byte5-plugins` and `omadia-plugin-starter`), `kind: extension` —
capability resolution only exists in `ToolPluginRuntime`, which handles
`tool`/`extension`/`integration`. It owns `src/devplatform/**`, all dev-platform routers
including `devRunnerApi.ts` and `devWebhooks.ts`, its own migrations, its config, its UI,
and its nav contribution.

The repo also inherits what core currently does *for* it and will stop doing:

- **Its own container images and supply chain.** `dev-runner` and `dev-runner-daemon` are
  built, SBOM'd and keyless-signed by `.github/workflows/publish-images.yml` today; those
  matrix entries and cosign steps leave with the plugin, and the new repo needs an
  equivalent pipeline. `id-token: write` in `auto-release.yml` / `release.yml` exists
  *solely* for that signing and can then be dropped from core.
- **Its own compose overlay** (`docker-compose.dev-platform.yaml`, 193 lines) and the two
  sidecar Dockerfiles.
- **Its own `@omadia/dev-platform-plugin-api`** carrying the `DevJob*` types, so third
  parties that consume `ctx.devJobs` depend on the plugin's contract rather than core's
  (G8).

`devRunnerApi.ts` belongs in the plugin: it has zero core dependencies and is versioned
with the **shim**, not with core (`RUNNER_PROTOCOL_VERSION`). A protocol whose counterpart
is a separately-deployed artifact belongs with the artifact that defines it. Core keeps
only the *decision* that its prefix is unauthenticated (G6).

The LLM proxy stays inside this plugin. It is already generic by injection, and it has
exactly one consumer; extracting a package for one consumer is speculative generality.

### 4.2 What stays in core

- ~~`DevJob*` types in `@omadia/plugin-api` — a published, versioned contract that
  third-party plugins consume via `ctx.devJobs`.~~ **Superseded — §4.1 wins.**
  `implementation.md` §2.5 recorded that §4.1 and §4.2 contradicted each other on this
  point and that the plugin-owned answer is the correct one; C2a (#555) then deleted the
  accessor outright and C2b removed the types from the package. They are core-local in
  `middleware/src/` today and leave with the extraction. There were never any third-party
  consumers — nothing ever provided the backing host service, so every call threw
  (`dormant-capabilities.md` §2).
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

### 4.3 The UI — the decision the own-repo constraint forces (G7)

**This section replaces the first draft's answer.** That draft kept the 3,933 LOC of React
compiled into web-ui and justified it by the plugin being a built-in package. Both halves
of that justification are now gone: the plugin lives in its own repo, and pages compiled
into web-ui *are* hardcoded core references, which constraint 2 forbids.

So the UI has to leave core, and the mechanism has to work for a plugin distributed as a
package. That is a genuinely harder problem, and it is the epic's biggest single risk.

**What a distributed plugin can carry today.** The ZIP extension allowlist
(`zipExtractor.ts:20-41`) is `.yaml .yml .md .json .js .mjs .cjs .map .png .svg .jpg .jpeg
.txt .license .html`. No `.tsx` — expected. But also, verified, **no `.css`**. So today a
plugin cannot even ship a compiled SPA's stylesheet, only inline styles inside a single
`.html`. The existing precedent (`admin_ui_path` → iframe on the plugin's store detail
page) is exactly one hand-written HTML file.

**The options, honestly.**

| Option | Verdict |
|---|---|
| **A. Rewrite as hand-rolled HTML** served from the plugin's router | Fits today's mechanism with no core change. Throws away 3,163 LOC of Lume React, the phase rail, the SSE log pane, and 280 i18n keys. A visible product downgrade for the operator surface. |
| **B. Plugin ships a compiled SPA, served by its own router, embedded via iframe** | **Recommended.** Keeps React, keeps the design system, keeps the components. Needs: `.css` (and probably `.woff2`) added to the allowlist, a static-asset serving path, and the Lume tokens published as a package the plugin can depend on. Costs a bundler in the plugin repo and an iframe boundary. |
| **C. Module federation / RSC remoting** | Not viable with App Router + RSC. Excluded. |
| **D. Optional web-ui build variant** | Two images in lockstep, and the plugin's code would still have to live in core's build. Fails constraint 2. |
| **E. Publish the pages as an npm package web-ui optionally installs** | Keeps React and removes the *source* from core, but core's build must still know the package exists. Weakens constraint 2 to "no source, but a build-time hook". Fallback if B proves too costly. |

### 4.3a Plugins use Tailwind — so they ship no CSS at all

The `.css` gap above is real but it is the **wrong thing to fix**. web-ui is a Tailwind v4
project; if plugin markup is required to use Tailwind utilities, a plugin never needs to
ship a stylesheet — it links one that core serves.

The catch, and it is the whole design: **Tailwind emits only classes it has seen.** v4
detects classes by scanning source files at build time, and a plugin installed at runtime
from another repository is never scanned. So "plugins use Tailwind" only works if core
**pre-generates a documented, finite utility vocabulary**. v4 supports exactly this —
`@source inline(...)` (the replacement for v3's `safelist`, brace-expandable) combined with
`@import "tailwindcss" source(none)` to disable scanning, producing a stylesheet containing
precisely that set.

**Measured, not estimated.** Built with the repo's own `tailwindcss@4.3.3` +
`@tailwindcss/postcss` — see `plugin-tailwind-subset.probe.css`:

| | |
|---|---|
| Vocabulary | layout, flex/grid, spacing 0–12, typography, borders, shadows, `sm:`/`md:`/`lg:`, `hover:`/`focus:`/`disabled:` |
| Colours | **the Lume tokens only** — `bg-accent`, `text-fg-muted`, `border-border`, `text-danger` … verified present |
| Size | 43,199 B raw → **7,704 B gzip** → 5.7 KB brotli |

Three things that makes better, beyond unblocking the extraction:

1. **Plugins inherit the design system by construction.** They get *our* colour names
   wired to the runtime CSS variables, so they follow the active palette and light/dark
   automatically. A plugin cannot hardcode a hex and drift.
2. **It retires a known drift hazard.** `middleware/src/admin-ui/harness-admin-css.ts` is
   345 hand-maintained lines whose own header says "mirror `web-ui/app/_lib/theme.css`;
   keep the two roughly in sync when the design system changes." Generating from the same
   tokens removes the sync obligation instead of restating it.
3. **It is enforceable, cheaply.** Reject `[` in class attributes at package ingest.

**The hard constraint to write into the plugin contract:** no **arbitrary values**
(`w-[137px]`, `bg-[#abc]`). That space is unbounded and cannot be pre-generated, so such a
class silently renders unstyled — the worst failure mode. The documented vocabulary plus an
ingest check is the enforcement; widen the vocabulary from what the ported pages actually
use rather than guessing.

Two implementation notes: the `@theme inline` token bridge currently lives inside
`globals.css:16-48` and must be **extracted to its own file** that both it and the plugin
stylesheet import, or the two drift — the exact failure this is meant to end. And an
iframe is a separate document, so it links the sheet itself; nothing is inherited from the
parent.

**What remains of G7 after this:** only the JavaScript bundle. `.js` and `.map` are already
allowlisted, so a compiled SPA can ship today; what is missing is a static-asset serving
path from the plugin's router. That is a much smaller problem than a styling story.

### Back to the option table

**Recommendation: B**, now materially cheaper than when first written — with §4.3a it is
the only option that satisfies both constraints without a product downgrade. It is also strictly more valuable than a one-off fix — it is the
mechanism *any* third-party plugin needs to ship a real UI, which is currently the
platform's weakest extension point.

Two properties make B cheaper than it looks: the dev-platform pages are already pure
`'use client'` components talking to `/bot-api/...` — effectively a SPA already — and the
nav API shipped in phase 1 already supports pointing an entry at a `/p/<pluginId>/...`
path, so discovery and placement are solved. **No dev-platform page may become a server
component** in the meantime, or the port stops being mechanical.

**The chat card (H3) is not covered by B.** `DevJobChatCard` renders *inside* the core
chat transcript, not in an iframe, and `chat/page.tsx:1025` hardcodes
`tool.name === 'dev_job_start'`. An iframe per tool call is not acceptable there. Options:
a declarative card schema the plugin returns and core renders generically, or accept that
the rich card degrades to a plain `ToolRow` for out-of-repo plugins. **This needs a
decision before P4** — it is the one place where "no hardcoding" and "no downgrade" may
genuinely conflict.

**Cross-image skew still applies and gets worse.** middleware, web-ui and now the plugin
are three separately versioned artifacts. The nav entry only appears when the plugin is
active, which narrows it, but a compatibility signal (minimum core version in the manifest,
checked at install) is now required rather than optional.

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

Tests: 48 catalog, 11 route, 6 disposal (middleware, `node:test`), 13 merge + 12 parse
(web-ui, vitest). web-ui 344 pass / 0 fail.

### Known limitations of what shipped

Surfaced by two adversarial review passes (GPT-5.4, then GPT-5.6). Recorded here rather
than silently carried:

- **The nav fetch is on every page's critical path.** The root layout awaits it with a
  2s timeout and degrades to the static nav, but a hung middleware still adds up to 2s
  before first paint — including on `/login` and `/setup`, where there is no session and
  the answer is always empty. A Suspense boundary, or skipping the fetch on
  unauthenticated routes, would remove that; neither is done yet.
- **`no-store` means a round trip per render.** The catalogue varies by locale and by
  plugin lifecycle, not by session, so a short stale-while-revalidate cache keyed on
  locale would bound the load. Conversely, because Next reuses shared layouts across
  client navigations, an already-open tab can keep showing an entry for a plugin that was
  just deactivated. Neither direction is addressed.
- **`MIDDLEWARE_URL` became a runtime requirement for web-ui.** RSC rendering reads it at
  request time; `web-ui/Dockerfile` and `.env.local.example` still describe it as
  build/dev-time only. Running the standalone image without it silently falls back to
  `localhost:3979` and hides every plugin entry. Documentation fix owed.
- **`WEB_UI_LOCALES` is duplicated in middleware** with a keep-in-sync comment. Server-side
  label resolution removes the *hydration* clock but not translation/version skew across
  the two images: ship a new locale in web-ui against older middleware and static labels
  translate while plugin labels fall back to English.
- **Homoglyph spoofing is not prevented.** Control, bidi and zero-width codepoints are
  rejected, but a Cyrillic `Аdmin` still renders convincingly next to the core `Admin`.
  Full confusable detection is out of scope; the entry at least carries its `pluginId`.
- **Test gaps.** The rollback path inside `activate()`'s catch is not covered (driving it
  needs a real on-disk package plus catalog/vault wiring), and the route test exercises
  the router without `requireAuth` — deleting the production guard would not fail a test.

### Pre-existing suite flakiness (not caused by this PR)

Adding these test files made `registryInstallMerge` fail intermittently in the full run
while passing in isolation. Investigated rather than assumed:

| Experiment | Result |
|---|---|
| Baseline, my files removed (3 runs) | 0 fail |
| My files present (3 runs) | 1, 5, 0 fail |
| My files with all TCP sockets removed (3 runs) | 1, 5, 0 fail |
| Three trivial 22-test files instead of mine (3 runs) | 0 fail |
| **One file of 48 `assert.equal(1, 1)` tests at the same sort position (3 runs)** | **0, 3, 2 fail** |

A file containing nothing but trivial assertions reproduces it. The race is latent in
`registryInstallMerge` (which itself binds ~6 sockets) and is exposed by test-runner
worker scheduling; any sufficiently large added file triggers it. This matches the
already-known "passes isolated, fails in the full suite" issue in this repo. My tests were
nevertheless converted to run socket-free via `test/_helpers/httpInvoke.ts`, which drives
the real Express pipeline through `app.handle` without binding a port — worth doing on its
own merits. **Follow-up owed on `registryInstallMerge`; it is not addressed here.**

---

## 6. Remaining phases

Reordered from the original draft: the visible deliverable moved first (done), and the
single irreversible step moved last.

| Phase | Content | Observable outcome |
|---|---|---|
| **P2a** | Decide the `ctx.devJobs` contract (§4.2) and the G8 public-contract break: `DevJob*` move to `@omadia/dev-platform-plugin-api`, `plugin-api` gets a SemVer-major bump, `dev_jobs` leaves the admin-v1 DTO. Add capability edges to `dynamicAgentRuntime` or document why agent plugins are excluded. | A written, versioned contract — before any code depends on it |
| **P2b** | Decide **H3** (chat card): declarative card schema, or accept degradation to `ToolRow` for out-of-repo plugins. Decide **G7 option B vs E**. | Both answers written down before code moves |
| **P2c** | Mechanical decoupling: break the `wireDevPlatform ↔ routes` cycle; collapse the 41 config keys into one namespaced object. ✅ `mintAppJwt` already moved to `src/services/githubAppJwt.ts`. | `index.ts` wiring reduced to one `assembleDevPlatform(cfg)` call |
| **P3** | The extension points. **H1** dynamic `publicPaths` + exclusive prefix ownership · **G2** `auth: 'session'` composed *inside* the disposed guard · **G3** route-local raw parser · **G4** permission-gated `graphPool@1` + shared `runPluginMigrations`. | Any plugin can own routes, exemptions, raw bodies and tables |
| **P3b** | **G7** (§4.3a): extract the `@theme inline` bridge out of `globals.css`; build the plugin Tailwind subset from it and serve it — replacing the 345 hand-written lines of `harness-admin-css.ts`; add a static-asset serving path for plugin SPA bundles; reject arbitrary-value classes at ingest. | Any plugin can ship a real UI in the house design system — the platform's weakest extension point today |
| **P4** | Stand up `byte5ai/omadia-plugin-dev-platform`; move ~49,100 LOC per `core-decoupling-checklist.md`; port the UI; stand up the repo's own GHCR + SBOM + signing pipeline. **Do not delete the `publicPaths` exemptions until P3 is proven on the live runner phone-home path.** | Dev Platform installs and uninstalls from its own repo |
| **P5** | Migration ownership handoff (no renumbering) + ledger seed, tested against a database restored from a production snapshot. Its own PR, its own rollback story. | Plugin owns its schema |
| **P6** | Delete the residue: core's `DEV_*` config, the compose overlay, the CI matrix entries and `id-token: write`, the workflow prompt rules, and every comment reference. | `node scripts/check-core-decoupling.mjs --report` reads **0**, and every row of `acceptance.md` §2 and §3 passes |

### How we know it is actually complete

Three documents, three different jobs — a file inventory alone cannot answer either half of
"all the functions extracted and installable":

| Document | Answers | Enforcement |
|---|---|---|
| `core-decoupling-checklist.md` | *What is still coupled?* (276 items, file-level) | Snapshot — goes stale on contact |
| `acceptance.md` | *Did every capability survive, and does it install?* (34 endpoints, 3 tools, 4 loops, 4 screens + install/uninstall) | Review checklist today; wants a smoke suite in the plugin repo |
| `scripts/check-core-decoupling.mjs` | *Is core still coupled at all?* | **Automated** — CI job `core decoupling ratchet (#470)`, baseline **3,171**, may only fall |

The ratchet is what makes the checklist's staleness survivable: even if the sweep missed a
reference, the count still sees it, and the count cannot reach zero while it survives. It
also stops core re-acquiring a dependency mid-extraction, which is the realistic failure
mode for a multi-week epic touching ~200 files.

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
| **Half-migrated codebase** | Each phase has an observable outcome above. **Abandonment checkpoint: after P3/P3b, the platform capabilities stand alone and dev-platform stays in core with no partial-move debt.** Half-moved is the only genuinely bad end state |
| **The UI port is the biggest single risk (G7)** | 3,933 LOC of React must move out of core. §4.3a removes the styling half of the problem for ~7.7 KB gzip, leaving only static-asset serving. P3b de-risks the rest *before* P4 commits. If it still proves too costly, fall back to option E (npm-published UI package) and accept the weakened constraint rather than rewriting the UI as hand-rolled HTML |
| **Arbitrary Tailwind values fail silently** | `w-[137px]` cannot be pre-generated, so it renders unstyled rather than erroring — a plugin author would see a subtly broken layout with no diagnostic. Mitigation is an ingest-time rejection of `[` in class attributes, not documentation alone |
| **Cross-repo development loses atomic changes** | Today a change spanning core and dev-platform is one PR with one CI run. Afterwards it is two PRs in two repos with a published contract between them, and no way to land them atomically. This is the standing tax of the split — worth it for installability, but it makes P3's extension points load-bearing: get them wrong and every fix needs a core release |
| **The new repo needs a real supply chain** | `dev-runner` is currently SBOM'd and keyless-signed in core's `publish-images.yml`. That is not a copy-paste — the new repo needs GHCR publishing, cosign identity, and its own release workflow before the images can move |
| **`plugin-api` SemVer-major break (G8)** | Third-party plugins importing `DevJobDescriptor` et al. break at compile time. Deliberate, versioned, and announced — not silent. The worse outcome is keeping the types while making the runtime optional, which preserves the signature and breaks the contract invisibly |
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
