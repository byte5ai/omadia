# Core decoupling checklist — Dev Platform

Every hardcoded dev-platform reference in core, i.e. everything that must be deleted,
moved, or genericised for core to retain **zero** knowledge of the Dev Platform once it
lives in its own repository.

Companion to `plan.md`. This file is the work-list; the plan holds the reasoning.

Measured on `worktree-dev-platform-plugin-extraction`. Line numbers drift — re-grep before
acting on a zone. Excludes `docs/`, `specs/`, `*.md`, and build output (`dist/`,
`*.tsbuildinfo`, lockfiles) which regenerate.

---

## Totals

| | |
|---|---|
| Items | **276** |
| DELETE / MOVE / GENERICISE | 166 / 66 / 44 |
| Volume leaving core | **≈49,100 LOC across ~200 files** |
| Zones | 18 |

Breakdown of the volume: `src/devplatform/` 14,498 · `test/devplatform/` 15,616 ·
sidecar daemon + runner shim ≈11,500 · `src/routes/devPlatform*` etc. 3,005 · web-ui 3,933 ·
migrations 364 · `scripts/dev-transcript.ts` 187.

---

## The three hard couplings

These are **not deletions**. Core has no extension point for what dev-platform does, so
each needs a new generic mechanism built first. They gate the whole extraction.

### H1 — `auth/publicPaths.ts` has no extension point

`STATIC_PUBLIC_PATHS` is a frozen literal. Two entries are dev-platform's:

- `:32` — `/^\/api\/v1\/dev-runner(?:\/|$|\?)/` (runner phone-home; `djr_` bearer *is* its auth)
- `:35` — `/^\/api\/v1\/dev-platform\/github-app\/(?:callback|setup)(?:\/|$|\?)/`

Deleting them without a replacement **kills every in-flight job**: runners carry no session
cookie, so the blanket `/api` `requireAuth` answers 401 before the plugin router is reached.

Needs: manifest-declared, install-time, operator-consented public-path grants, **plus
exclusive prefix ownership** — a grant only makes `requireAuth` call `next()` for a URL; it
does not say which router may answer it. Without ownership, plugin B mounted at plugin A's
granted prefix receives unauthenticated traffic.

### H2 — the conductor hardcodes the `dev_job` step kind and channel type

- `conductor/devJobStepEffect.ts` — the whole file (≈118 LOC): `DEV_JOB_ACTION_ID`,
  `isDevJobStep`, `buildDevJobPrincipalRef`, `parseDevJobPrincipalRef`,
  `DevJobStepPort`, `DevJobOutcomeSource`, `DevJobAwaitResolver`, `subscribeDevJobResolver`
- `conductor/runExecutor.ts:203-205` — the step dispatcher branches on `isDevJobStep(step)`
- `conductor/runExecutor.ts:365-407` — `resolveDevJobAwait()`
- `conductor/runExecutor.ts:421-433` — `reconcileTerminalDevJobAwaits()`
- `conductor/runExecutor.ts:578-600` — `openDevJobAwait()`
- `conductor/runExecutor.ts:22` — `DevJobPortUnavailableError` (exported)
- `conductor/awaitStore.ts:125` — the human inbox query is `... AND channel_type <> 'dev_job'`
- `conductor/awaitStore.ts:139-142` — `listWaitingDevJobAwaits()`

Needs: a generic **long-running step-kind registry** (a plugin registers an action id, a
port, and an await resolver) and a generic channel-type filter instead of a literal.

### H3 — the chat renderer hardcodes a tool name

- `web-ui/app/chat/page.tsx:53-54` — imports `DevJobChatCard`, `parseDevJobStartResult`
- `web-ui/app/chat/page.tsx:1025` — `tool.name === 'dev_job_start' ? parseDevJobStartResult(...) : null`
- `web-ui/app/chat/page.tsx:1027` — renders `<DevJobChatCard seed={seed} />`

Needs: a plugin-contributed **tool-card renderer registry**. This is the hardest of the
three, because the renderer is a React component and the plugin now lives in another repo
(see `plan.md` §G7).

---

## Zones

### 1 — `middleware/src/index.ts` (34 items)

- **14 imports** at `:165-185` and `:229` — DELETE. Also `DeviceFlowStore` (`:124`) becomes
  dead once `:2692` goes.
- **`:2050-2118`** — the GitHub-webhook block mounted *before* `express.json` (raw-body HMAC).
- **`:2579-2812`** — the entire assembly block: device provider, shim entry path, `csvList`,
  role store, Fly backend resolution (`:2599-2645`), `assembleDevPlatform` (`:2646-2697`,
  reads 40+ `config.DEV_*`), `mountDevPlatform` (`:2698`), GitHub-App routers (`:2700-2723`),
  chat tool registration (`:2725-2751`), worker start + signal hooks (`:2753-2767`),
  **the nav registration (`:2769-2787`)**, retention job (`:2789-2807`), no-graphPool warn.

The nav registration is the bridge PR #536 added. It is deliberately temporary: it becomes
`ctx.uiRoutes.registerNav(...)` in the plugin's `activate()`. The `uiRouteCatalog`
mechanism itself is generic and stays — it simply has no in-core caller afterwards.

Keep: `:1389` and `:4118` (`DEV_ENDPOINTS_ENABLED`) — that is the core dev-graph feature,
unrelated despite the prefix.

### 2 — `middleware/src/config.ts` (51 items)

**43 schema keys** — `:191-200`, `:226-229`, `:487-589`. Plus:

- `:31-37` `devFlag()` helper — all three call sites are dev-platform.
- `:629-656` `devPlatformBootRefusals()` + `:666-674` its call in `loadConfig()`.
  ⚠️ These are **safety interlocks** (`SUBSCRIPTION_MODE` without `_ACK`, `UNSAFE_LOCAL`
  without `LOCAL_UID`). They must become activation refusals in the plugin, not vanish.
- `:687-690` post-processing of `DEV_PLATFORM_RUNNER_BASE_URL` / `_WORKSPACE_DIR`.
- `:204-205` comment references dev-platform — scrub.

`FLY_APP_NAME` (`:575`) is Fly-generic but currently read only by the dev-platform Fly
backend. Decide: keep for future Fly needs, or delete.

### 3 — `auth/publicPaths.ts` (5) — see **H1**

### 4 — `platform/pluginContext.ts` (14)

`:32-36` type imports · `:747-755` the `ctx.devJobs` gate · `:793` the spread ·
`:906-931` `DevJobsHostService` · `:946-1013+` `createPluginDevJobsAccessor` and its
`requireAccessibleJob` / `create` / `get` / `list` / `listEvents`.

The accessor implementation MOVES to the plugin repo; core keeps only the generic
`serviceRegistry` and capability-grant machinery.

### 5 — `packages/plugin-api/**` (11) ⚠️ PUBLIC CONTRACT

`@omadia/plugin-api` is published and re-exports everything (`src/index.ts:1`). Removing
these is a **SemVer-major break** for every Hub plugin that imports them:

`:182` `PluginContext.devJobs` · `:1370` `DevJobKind` · `:1373-1387` `DevJobStatus` ·
`:1388-1397` `DevJobDescriptor` · `:1399-1405` `DevJobCreateRequest` ·
`:1407-1413` `DevJobEventRecord` · `:1424-1448` `DevJobsAccessor`.

Recommendation: MOVE the six type declarations into a `@omadia/dev-platform-plugin-api`
package owned by the new repo. Also `:765` — a JSDoc nav example uses `/admin/dev-platform`;
scrub.

Same problem one layer up: `api/admin-v1.ts:197-204` exposes `dev_jobs` and
`dev_jobs_repos_hint` on the **public admin DTO**.

### 6 — `plugins/**` (11)

`manifestLoader.ts:638-645,671-672` — the `permissions.devJobs` parse. Genericise into a
capability-grant mechanism rather than a named permission.

~~`plugins/builder/githubAppAuth.ts:1` — imports `mintAppJwt` from the devplatform tree~~
**DONE** — `appJwt.ts` moved to `src/services/githubAppJwt.ts`; all three call sites
updated. This was the only core→devplatform reverse dependency.

### 7 — `conductor/**` (33) — see **H2**

Also `conductor/routes.ts:332` — comment mentioning the `dev_job:<id>` phantom principal.

### 8 — `routes/**` (9 files, 3,005 LOC) — MOVE

`devPlatform.ts` 498 · `devPlatformShared.ts` 491 · `devPlatformRepos.ts` 370 ·
`devPlatformGithubApp.ts` 341 · `devPlatformGates.ts` 191 · `devRunnerApi.ts` 706 ·
`devRunnerJobPolicyRoute.ts` 136 · `devWebhooks.ts` 272.

Plus `services/ssrfGuard.ts:35` — comment only, scrub.

### 9 — `src/devplatform/**` — 54 files, 14,498 LOC — MOVE wholesale

### 10 — `migrations/**` — 9 files (`0022`–`0030`), 364 LOC — MOVE

⚠️ They occupy a **contiguous slot range in the core ledger**. Do not renumber (see
`plan.md` §G4) — seed the plugin ledger from `_multi_orchestrator_migrations` instead.

### 11 — scripts / sidecars / shim (15 items, ~11,700 LOC) — MOVE

`scripts/dev-transcript.ts` (187) · `sidecars/dev-runner/` (2 files) ·
`sidecars/dev-runner-daemon/` (30 files, 10,910 LOC, dockerode) ·
`packages/dev-runner-shim/` (21 files).

⚠️ Latent bug worth noting: `dev-runner-shim` is **not built** by `npm run build`, yet
`index.ts:2590` resolves `packages/dev-runner-shim/dist/src/index.js` at runtime.
Extraction removes the inconsistency.

### 12 — `middleware/package.json` (4) — GENERICISE

No explicit references. `workspaces: ["packages/*"]` and the test glob pick the package up
implicitly and resolve themselves on deletion. Regenerate `package-lock.json`.

### 13 — Dockerfiles — **no action**. Neither the root nor the web-ui Dockerfile references
dev-platform.

### 14 — compose — `docker-compose.dev-platform.yaml` (193 lines) MOVE wholesale.
All other compose files are clean.

### 15 — `web-ui/**` (45 items, 36 files, 560 i18n leaf keys)

- `app/admin/dev-platform/**` — 20 files, 3,163 LOC — MOVE
- `app/_components/devjobs/**` — 6 files, 770 LOC — MOVE
- `app/_lib/useDevJobEvents.ts` — 114 LOC — MOVE
- `app/chat/page.tsx:53-54,1025,1027` — **H3**
- `app/admin/page.tsx:68-75` — the card entry. The `requiresNavFrom` mechanism (`:28-37`)
  is generic and stays; this is its only user.
- `app/_components/Nav.tsx:20` — comment scrub only; Nav is fully generic.
- i18n: `adminDevPlatform.*` 269 · `chat.devJob.*` 9 · `admin.index.cards.devPlatform.*` 2
  = **280 leaf keys per locale, 560 across en+de, 728 lines.**

The nav label itself is *not* in the message files — it is supplied by the registration
(`index.ts:2786`), which is exactly the design intent.

### 16 — tests (12 items)

`test/devplatform/` 54 files, 15,616 LOC — MOVE · `test/conductorDevJobStep.test.ts` (358)
— MOVE · `test/pluginDevJobsAccessor.test.ts` (240) — MOVE ·
`packages/dev-runner-shim/test/` 7 files · `sidecars/dev-runner-daemon/test/` 10 files ·
web-ui `devjobs/__tests__/` 2 files + `dev-platform/_lib/__tests__/budget.test.ts`.

GENERICISE (these tests are core and must survive — only their **fixture strings** are
dev-platform): `test/uiRouteCatalogNav.test.ts`, `test/uiNavigationRoute.test.ts`,
`test/toolPluginRuntimeRouteDisposal.test.ts`, `web-ui/app/_lib/__tests__/nav{Parse,Merge}.test.ts`
— 14 fixture references in the web-ui pair alone.

### 17 — `.github/workflows/**` (11)

`publish-images.yml:80-86` (`dev-runner` matrix entry) · `:87-96` (`dev-runner-daemon`) ·
`:161-18x` (cosign install, syft SBOM, keyless sign + attest — all guarded on
`matrix.name == 'dev-runner'`) · `:101-104` (the missing-Dockerfile guard becomes
unnecessary) · `:47`, `:75-79`, `:151-160` comments.

`auto-release.yml:121-124` and `release.yml:31-34` grant `id-token: write` **solely** for
that keyless signing — reconsider once it moves.

The new repo needs its own GHCR publishing, SBOM and signing pipeline. This is real work,
not a copy-paste.

### 18 — everything else (9)

`scripts/wave-implement.workflow.mjs:297` and `scripts/wave-verify.workflow.mjs:190` bake a
dev-platform domain rule ("Terminal transitions go through `finalizeDevJob`") into
*generic* workflow prompts — delete or genericise. `:43` has a `docs/dev-platform/`
example path.

---

## Suggested order

1. **H1, H2, H3** — build the three extension points. Nothing else can complete without them.
2. Zone 6 reverse dependency ✅ done · zones 1–2 mechanical decoupling (cycle break, config collapse).
3. Zone 5 + `admin-v1.ts` — the public-contract break. Version `plugin-api` deliberately.
4. Bulk moves: zones 8, 9, 11, 14, 15a-c, 16.
5. Zone 10 migrations — last, own PR, snapshot-restored test.
6. Zone 17 CI + the new repo's publishing pipeline.

---

## Baseline raises

`scripts/check-core-decoupling.mjs` only ever lowers its baseline automatically.
A raise is hand-edited, and each one is argued for here. A raise is legitimate
only when the added references **leave core with the extraction**; a raise that
absorbs new *core* coupling is the ratchet failing at its job.

### 3303 → 3441 — W2-2 long-running task seam

The W2-2 unit generalised the existing `dev_job` machinery into a reusable
`TaskStore` seam plus `defineLongRunningTool()`, with `dev_job` as its first
implementor. Net +138 after decoupling work.

**Not counted, because it was removed rather than absorbed (−40).** The generic
seam — `packages/harness-orchestrator/src/tasks/` — initially named `dev_job` 25
times in its own doc comments, and the generic web-ui task card another 5. A
generic abstraction documented in terms of one implementor leaks the coupling it
exists to remove, and every one of those references would dangle the moment the
Dev Platform leaves. They were rewritten to state the contract instead. **The
generic seam is now CLEAN — `middleware/packages` sits at its baseline of 97 and
must stay there.** Also removed: two inaccurate comments (a pg test claiming to
seed "dev-platform surfaces" when it seeds only `mcp_*` and `agents`; a `ci.yml`
comment enumerating the features whose schema lives in `middleware/migrations`,
which was the only dev-platform reference in any workflow and was descriptive,
not functional).

**Absorbed into the raise (+138).** Broken down honestly:

| Count | Where | Leaves with extraction? |
|---|---|---|
| 62 | `src/devplatform/devJobTaskStore.ts` (new) | yes — inside the extracted folder |
| 4 | `src/devplatform/devJobStore.ts` (W3-A sweep scope) | yes — inside the extracted folder |
| 47 | `test/devplatform/devJobTaskStore.pg.test.ts` (new) | yes |
| 24 | `test/devplatform/devJobTaskStoreReap.test.ts` (new) | yes |
| 1 | `web-ui/.../tasks/__tests__/taskChatCardState.test.ts` | **no** |

The 137 are an **adapter and its tests**. `devJobTaskStore.ts` exists precisely
to adapt `dev_job` to the generic seam; naming `dev_job` is its entire job.
Contorting it to reduce a number would make the adapter worse and would not move
a single line out of core any earlier — it already lives in the folder the
extraction deletes. It is deliberately not reduced.

The 1 genuine core reference is
`expect(isTaskStartToolName('dev_job_start')).toBe(true)`. It is kept because it
is *true and load-bearing*: the generic `_start` suffix predicate does match
`dev_job_start`, which is exactly why `chat/page.tsx` must test the bespoke
dev-job card **before** the generic one. Deleting the assertion to save a count
would be dodging the regex, not decoupling. It disappears on extraction along
with the card it guards.

One structural fix rode along: `devJobTaskStoreReap.test.ts` was written into
`test/tasks/` (the *generic* seam's test directory) despite importing only from
`src/devplatform/`. Moved to `test/devplatform/` so the extraction picks it up
with its siblings. Ratchet-neutral — same zone — but it is 24 references that
would otherwise have been stranded in a directory nobody would think to move.
