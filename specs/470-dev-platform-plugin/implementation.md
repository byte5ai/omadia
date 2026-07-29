# Implementation plan — epic #470

Six parallel design passes, one per hard problem (H1 public paths · H2 conductor step kinds ·
H3 chat card + plugin UI · G4 plugin SQL + migration handoff · G8 plugin-api contract ·
P4 repo split + supply chain). This is the synthesis: what the designs **changed**, what they
**found**, and the PR sequence that follows.

`plan.md` holds the architecture, `core-decoupling-checklist.md` the work-list,
`acceptance.md` the functional contract. This file holds the order of operations.

---

## 1. What the designs changed in the plan

Five decisions were wrong or under-specified. All five are corrected here and in `plan.md`.

| # | Plan said | Design says | Why it matters |
|---|---|---|---|
| **1** | Make `publicPaths` a dynamic set | **Don't.** `requireAuth` runs *before* routing and structurally cannot know who will answer — putting the grant there rebuilds the hole. Use a mount slot **before** `requireAuth` that **terminates**. `publicPaths.ts` stays a frozen literal | Fail-closed by construction: if the new machinery is off or broken, `requireAuth` still 401s |
| **2** | Chat card: declarative schema *or* `ToolRow` degradation | **Neither.** A **closed** contract — 7 node kinds, one level deep, no className/style/HTML — with liveness **mediated by core** | A plugin-supplied SSE URL is an SSRF aimed at the operator's own session; a generic node tree makes core a rendering engine for untrusted markup |
| **3** | Add `.css` to the ZIP allowlist | **Don't.** The inability to ship CSS *is* the enforcement for the Tailwind vocabulary | The moment a plugin can ship a stylesheet, "plugins inherit the design system by construction" is gone on day one |
| **4** | `plugin-api` removal = SemVer-major break for Hub plugins | **There is no installed base.** Take the break now and cut `1.0.0` already clean | See finding F2 |
| **5** | Migrations are the most irreversible step | **The vault re-key is.** Migrations are idempotent and additive; a deleted GitHub App private key is gone | Re-key gets its own PR, its own window, and must be copy → verify → delete |

---

## 2. What the designs found

### 2.1 Verified live bugs — none of these are caused by the extraction

| # | Bug | Evidence | Status |
|---|---|---|---|
| **B1** | **`ctx.services.get` is completely ungated.** `platform/pluginContext.ts:230-233` is a bare pass-through. Any installed plugin can call `ctx.services.get('graphPool')` and receive the superuser `pg.Pool` — full read/write on `users`, `conductor_runs`, everything. No manifest declaration, nothing in the install dialog | Read the file — the accessor has no permission check. The file's own comment concedes it: *"naked service-locator; enforcement lives at the consumer seam"* | **Verified.** Biggest hole found in this epic, and it is live today |
| **B2** | **`ServiceRegistry` is never disposed on deactivate.** No owner tracking, no `disposeBySource`. `toolPluginRuntime.deactivate()` disposes routes and uiRoutes but not services — so a provider whose `close()` forgets leaves the service registered on a torn-down module, and reinstall then throws `duplicate provider` | `serviceRegistry.ts` has only the duplicate-provider throw; `deactivate()` has no services call | **Verified.** Exactly the bug class PR #536 fixed for Express routers, one layer down |
| **B3** | **All five core migrators race on multi-replica boot.** No advisory lock: two replicas read an empty ledger, both execute. `IF NOT EXISTS` hides it; `0025`'s `ADD CONSTRAINT` does not (`42710`, boot fails) | Every migrator is read-ledger → filter → apply, unguarded | Reported by design; **fix independently of #470** |
| **B4** | **`.sql` is not in the ZIP extension allowlist.** `zipExtractor.ts:20-41`. A distributed plugin cannot ship migrations at all | Confirmed by grep — `.sql` absent | **Verified. Blocks G4** exactly as the missing `.css` blocked G7 |
| **B5** | **The conductor dev-job step is dead code in production.** `conductor/index.ts:209-232` builds the executor with **no** `devJob` dep, so the `runExecutor.ts:203` branch is always false and nothing ever schedules the reconciliation sweep | Its own comment says "W4 schedules this on a timer" — W4 never did | Reported by design. **Good news:** almost certainly zero live `dev_job` awaits, so H2's backwards-compatibility is nearly free |
| **B6** | **Stale plugin grants.** `dev_repo_plugin_grants` is never cleaned on uninstall. Uninstall B, reinstall something claiming the same id, and it inherits the operator's consent silently. `plugin_mcp_grants` likely has the identical bug | No FK, no cleanup hook | Reported by design |

### 2.2 The trap in my own plan

Removing `ctx.devJobs` without replacing its gate would have **converted a permission-gated,
kernel-attributed accessor into an ungated, self-attributed one** — because the only remaining
path is B1's naked locator, and a plugin would pass its own `pluginId` into
`listGrantedRepoIds`. Two designs flagged this independently, from different directions.

The fix is generic and worth shipping regardless: grant-gate `services.get`, and make
`provide` accept a per-caller factory so caller attribution comes from the kernel-known
`agentId` rather than from the caller.

### 2.3 Two silent UI regressions the plan missed

- **`next/font` does not cross an iframe boundary.** Fonts are injected into web-ui's document
  only; the plugin SPA renders in the fallback stack.
- **`data-theme` does not either.** Plugin UI sits in light mode inside a shell the operator
  forced dark.

Both fixed by a core host page passing `?theme=&locale=` and by shipping `@font-face` in the
plugin stylesheet.

### 2.4 The supply-chain break

Keyless cosign binds the certificate identity to **repo + workflow + ref**. Publishing the same
image from the new repo produces a different identity, and `imageVerify.mjs` does an
**exact-match** `--certificate-identity`. Every deployed daemon with an identity pinned would
**refuse to launch jobs**. Fix: add `--certificate-identity-regexp` support and ship a
transition regexp accepting both signers, *before* the first image is published from the new
repo. Narrow it one release later.

---

## 3. The sequence

Governing trick: **copy → prove → delete.** For a long stretch both implementations exist and
core's is the live one.

### Phase A — core capabilities. Moves zero dev-platform code.

| # | PR | Exit condition |
|---|---|---|
| **B-fix** | The three live bugs that stand alone: `ServiceRegistry` owner tracking + `disposeBySource` + the `deactivate` call (B2); advisory lock in all five migrators (B3); `.sql` in the allowlist (B4) | Independently valuable, zero contract change |
| **C1** | Publish `@omadia/plugin-api` for real: un-private, un-gate the `if: false` publish job, **add a `.d.ts` golden-snapshot test** | Third parties can depend on it. The snapshot is what makes the contract machine-checked |
| **C2** | **G8**: `DevJob*` types → `@omadia/dev-platform-plugin-api`; delete `PluginContext.devJobs` and the `admin-v1` DTO fields; grant-gate `services.get` + per-caller factory (**closes B1**) | Break taken once, deliberately, before any publish |
| **C3** | Mechanical decoupling: break the `wireDevPlatform ↔ routes` cycle; collapse the 41 config keys | `index.ts` reduced to one `assembleDevPlatform(cfg)` |
| **C4** | **H1**: manifest-declared, operator-consented public-path grants + **exclusive prefix ownership** + the terminating early mount. The two static exemptions **stay** | Belt and braces, zero risk |
| **C5** | **H2**: generic long-running step-kind registry + `await_kind` column replacing the `<> 'dev_job'` literal. Core's own dev-job re-registers *through* the new registry | The registry is proven by its first consumer while that consumer is still in-tree |
| **C6** | **G2** `auth:'session'` composed *inside* the disposed guard; **G3** `rawBody` via a route-local parser at the plugin's own prefix | Webhook HMAC works through the generic path |
| **C7** | **G4** `pgPool` capability (gated on `permissions.sql`) + shared `runPluginMigrations` with advisory lock, ledger-name validation, empty-dir throw, and a `MigrationReport` | Plugins can own tables |
| **C8** | **G7/P3b**: extract the `@theme inline` bridge out of `globals.css`; generate + serve the plugin Tailwind subset; static-asset serving; ingest check for arbitrary values. Prove with a throwaway SPA | **← ABANDONMENT CHECKPOINT** |

**If the epic stops at C8, everything shipped is still net-positive**: five reusable platform
capabilities, three live bugs fixed, and dev-platform can stay in core with zero partial-move
debt.

### Phase B — the move

| # | Repo | PR | Exit condition |
|---|---|---|---|
| **P0–P1** | plugin | Stand up the repo; publish `@omadia/dev-platform-plugin-api`. **Verify GHCR cross-repo package write access here, where it costs nothing** | Empty repo, green CI |
| **P2** | plugin | **SPA port** — 26 files → Vite/React, `next-intl` → local i18n, Tailwind constrained to the C8 vocabulary | Biggest single risk, isolated. web-ui untouched |
| **P3** | plugin | Middleware plugin package. Migrations codegen'd to JS (filenames preserved). **Delete `devJobConductorBridge.ts`** — dead code, don't carry it into a published package | Compiles, unit tests green, core still live |
| **P4** | plugin | Sidecars + shim + supply chain. **Land the cosign regexp support first, then publish** | Dual-sign window open |
| **P5** | plugin | ZIP + hub publish. Install on staging with `DEV_PLATFORM_ENABLED=false`, run `acceptance.md` end to end **including a real runner phone-home over the C4 grant with the static exemptions removed from the staging config only** | **← THE PROOF GATE** |
| **C10** | core | The flip: delete ~49k LOC. **Keep** the `publicPaths` exemptions and migrations `0022`–`0030` | Must be one PR — a partial delete leaves `tsc` red |
| **C11** | core | **Migration handoff.** Seed the plugin ledger by filename, **with per-file schema witnesses** (see below). Own PR, own rollback | Plugin owns its schema |
| **C12** | core | Delete the two `publicPaths` exemptions. **Nothing else in the PR** | Single revertible commit |
| **C13** | core | Residue: CI matrix, `id-token: write`, compose, i18n keys, comments, fixture strings | **Ratchet reads 0**, baseline pinned there permanently |

### The migration handoff needs witnesses, not trust

The naive seed copies the donor ledger rows and skips those files. That silently destroys an
installation in one case: **donor rows present, tables absent** (a restore, a version-skewed
rollback, an operator who dropped tables during an incident). The plugin activates green and
every request 500s.

So seed a filename **only when the donor recorded it AND the schema object it creates actually
exists** — `to_regclass('public.dev_jobs')`, `dev_jobs.pipeline_mode` exists, the constraint
definition contains `'plugin'`, and so on, one witness per file. Donor row without witness →
don't seed, let the apply loop run it (all nine are idempotent). Witness without donor row →
seed anyway.

**Never delete the donor rows** — that is the rollback path, and deleting them makes core's
migrator re-run the files while core still ships them.

And ship `dryRun`: printing `{seeded: 9, applied: []}` against production *before* writing is
the cheapest possible de-risking of the epic's most irreversible step.

---

## 4. Decisions that block work

Ordered by what they hold up.

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| **D1** | **Publish `@omadia/plugin-api` to public npm?** It is `private: true` and the publish job is `if: false` | C1 → everything | Public npm. GitHub Packages needs auth even to read, which kills the "fork the starter and go" story |
| **D2** | **H3 chat card** — closed card contract, or accepted `ToolRow` degradation? | C13 | The closed contract. The card's value is the *gate*; degrading it makes the platform's principal safety mechanism annoying, and annoying safety mechanisms get bypassed |
| **D3** | **Uninstall data lifecycle** — 9 tables of rows | P4 | Orphan by default, never drop. Reinstall must be lossless. Ship a separate type-to-confirm purge route |
| **D4** | **Secret re-key** — one-time migration or operator re-entry? | P4 | Operator re-entry. Visible, honest, and it avoids a core hook that becomes dead code |
| **D5** | **Cosign identity** — transition regexp, documented break, or dual image? | P4 | Transition regexp, narrowed one release later |
| **D6** | **`.sql` codegen or allowlist?** | P3 | Both. Codegen ships now; the allowlist fix means the next plugin doesn't need one |

---

## 5. What can never move

Beyond the obvious: **`services/githubAppJwt.ts` must not follow dev-platform out.** It was
just moved *into* core to close the one core→devplatform reverse dependency; sending it to the
plugin repo would recreate that leak in the opposite direction, across a repo boundary.

And counter-intuitively: **core cannot drop `express`, `pg` or `zod`** from its dependencies
even after "zero dev-platform code paths". They are the plugin's `peerDependencies`, resolved
through the host `node_modules` symlink. Removing them breaks every installed copy at runtime.
Worth a comment in `middleware/package.json`.

`DEV_ENDPOINTS_ENABLED` is core's dev-graph feature and merely shares the prefix — the ratchet
already allowlists it so the count can legitimately reach 0.

---

## 6. Confidence

| Ebene | Before the designs | After |
|---|---|---|
| Diagnosis | ~85 % | **~90 %** — six independent passes found six things the checklist missed, and the ratchet catches what all of them missed |
| Architecture | ~70 % | **~75 %** — five decisions corrected, two of them (H1 shape, H3 shape) materially better than what I had |
| Lands as planned | ~50 % | **~55 %** — H2 got much cheaper (B5: dead code, no live awaits) and G8's SemVer risk evaporated (F2: never published); H3 and P4 got visibly more expensive |

Still unvalidated by running code: everything after C8. The abandonment checkpoint is there
because that is an honest place to stop.
