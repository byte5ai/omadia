# Epic #470 — Dev Platform → installable plugin in its own repository

Single source of truth for the extraction: the plan, the work-list, the acceptance
contract, and the automated guard. Implementation lands against these documents.

**Goal.** Turn the Dev Platform from a hard-wired core subsystem into an installable,
uninstallable plugin living in **its own repository** — its own backend, database schema,
configuration, UI and menu entries — until the `omadia` repository contains no reference to
it at all.

---

## The documents

| File | Answers | Read it when |
|---|---|---|
| **`plan.md`** | *What are we building, and why this way?* Architecture decisions, the capability gaps (G1–G10), the three hard couplings (H1–H3), phases P2a→P6, risks | Before touching anything |
| **`dormant-capabilities.md`** | *What happens to the five capabilities that never ran?* Per-capability verdict (activate / defer / delete) with the security finding that makes `ctx.devJobs` a delete | Before P2b |
| **`implementation.md`** | *In what order, and what did the detailed design change?* Six design passes synthesised: the five corrected decisions, six verified live bugs, the C1→C13 / P0→P6 PR sequence, and the six blocking decisions | Before starting a phase |
| **`core-decoupling-checklist.md`** | *What is still coupled?* 276 items across 18 zones, ~49,100 LOC / ~200 files, with `file:line` and DELETE / MOVE / GENERICISE per item | While doing the removal |
| **`acceptance.md`** | *Did every capability survive, and does it install?* 35 endpoints, 3 chat tools, 3 live background loops, 4 UI screens, CLI — each with a probe, plus FIVE capabilities marked unreachable. Plus install/uninstall/upgrade criteria | Before claiming a phase is done |
| **`plugin-tailwind-subset.probe.css`** | *Can a distributed plugin ship a UI without shipping CSS?* Measured reference artifact (7.7 KB gzip) — not built, not shipped. **Superseded by the real build in C8**; kept as the sizing reference it was | For the sizing argument only |
| **`plugin-ui-vocabulary.md`** | *What may a plugin UI actually use?* The shipped C8 contract: the utility vocabulary, the no-arbitrary-values rule and its enforcement, the ZIP layout, the iframe boundary | Before writing or reviewing any plugin UI |
| ~~`decoupling-baseline.json`~~ | The committed reference count the CI ratchet enforced | **Gone.** Retired with the ratchet at C14 — see "How we knew it was complete" |

---

## Status

### Done — merged via PR #536

- **Nav contribution API.** `ctx.uiRoutes.registerNav(...)`, `UiRouteCatalog.registerNav/listNav`,
  `GET /api/v1/ui/navigation` (session-gated, labels resolved server-side), and the
  static/dynamic merge in `Nav.tsx`. Dev Platform is its first consumer: its menu entry and
  `/admin` card now come from a registration, not a hardcoded literal.
- **Stale-plugin-route fix.** `ToolPluginRuntime.deactivate()` never disposed Express
  routers, so uninstalled plugins kept serving and shadowed later mounts. Disposal now also
  runs *before* the plugin-controlled `close()`, and `activate()` rolls back its own
  registrations when a plugin registers and then throws.
- **`appJwt` reverse dependency removed** → `middleware/src/services/githubAppJwt.ts`. Core's
  builder was importing out of the dev-platform tree, which made that tree a dependency of
  core and blocked extraction outright.

### In flight — this PR (#539)

- Tailwind-for-plugins (§4.3a) + the measured probe.
- The core-decoupling ratchet, the acceptance matrix, and the implementation plan.
- `dormant-capabilities.md` — five capabilities that never ran, each with a verdict.
- **Shipped code:** `ServiceRegistry` now disposes plugin-provided services on deactivate
  (owner-tracked, LIFO unwind, before the awaited `close()`), mirrored into both runtimes.

### Landed separately

- **PR #548** — path traversal in the plugin install pipeline. Unvalidated `identity.id`
  reached `path.join` and then a recursive `fs.rm`; reachable from remote registry ZIPs and
  imported profile bundles. Kept out of this PR so it does not wait on epic decisions.

### Wave 2 — shipped after #548 landed

- **`.sql` in the ZIP allowlist** — unblocked once the traversal fix merged. Also adds
  `migrations` to both boilerplate `build-zip.mjs` INCLUDE lists, without which the
  directory is silently dropped and the install succeeds with no schema.
- **Migrator concurrency** — shipped on the third attempt. Two prior designs were rejected:
  an unbounded `pg_advisory_lock` inside a 10s `activate()` budget, and a retry that never
  read `pg_advisory_unlock`'s return value.

### Phase A — C1 shipped

- **Golden `.d.ts` snapshot for `@omadia/plugin-api`.** The contract is now machine-checked:
  `packages/plugin-api/api-snapshot/plugin-api.d.ts.snap` holds every emitted declaration
  (comments stripped, whitespace normalized, files in sorted path order), and
  `packages/plugin-api/test/apiSnapshot.test.ts` fails the middleware suite on any drift. The
  package stays `private: true` — nothing is published (D1 stands).

  Regenerating is deliberate, and a regeneration is not the whole job:

  ```bash
  npm run api:check  -w packages/plugin-api   # what CI runs
  npm run api:update -w packages/plugin-api   # accept the new surface
  ```

  **The snapshot and the version move together.** A removed or renamed symbol, an added
  parameter, a narrowed type, or an optional field made required is a **MAJOR** bump; an added
  symbol, a widened type, or a required field made optional is a **MINOR** one. After the split
  that version number is the only signal an out-of-repo plugin gets about whether its pinned
  contract still holds, so a snapshot updated without a bump is the same silent break C1 exists
  to stop. Full table in `middleware/packages/plugin-api/README.md`.

### C4 / H1 — public-path grants (shipped)

- **Manifest-declared, operator-consented public-path grants + exclusive prefix ownership +
  the terminating early mount.** Closes G6. `permissions.public_paths` is a REQUEST; three
  gates must all hold before a prefix is served without a session: declaration (zod-validated
  shape), exclusive ownership (claimed at activation, first plugin wins, released on
  deactivate), and operator consent (`plugin_public_path_grants`, migration `0046`).
- **`auth/publicPaths.ts` stays a frozen literal, and both static exemptions stay** — they
  leave in C12, not here. Making that list dynamic was rejected in `implementation.md` §1:
  `requireAuth` runs before routing and cannot know who will answer, so a grant there says
  "this URL needs no session" without saying "and only plugin A may answer it".
- **The mount terminates.** An unhandled path under a granted prefix is answered 404 and does
  NOT fall through into the authenticated stack. A counter-proof test disables termination
  and shows the request escaping to `requireAuth`, so the guarantee is evidenced rather than
  asserted. Two mutation checks confirm the suite fails when termination or the consent gate
  is removed.
- **Fail-closed:** no grants, no store, no registry, no live plugin — each is a `next()` into
  `requireAuth`. No failure mode of the new machinery yields less authentication than a build
  without it.
- Unknown `permissions.*` keys now warn instead of vanishing silently (`implementation.md`
  §2.5). Ratchet unchanged at 3296.

### C6 — G2 route auth + G3 raw body (shipped)

- **`auth: 'session' | 'public' | 'custom'` on `ctx.routes.register`, composed INSIDE the
  disposed guard.** The order is the feature: `[disposed guard] → [auth] → [body] → router`,
  so a deactivated plugin's route answers **404 before any auth logic runs** rather than 401.
  The pinned-order test asserts exactly that, and a counter-proof rebuilds the pre-C6
  composition (auth outside the guard) to show the same request coming back 401.
- **The auth middleware is bound once per route, at registration** — the resolver is called
  by `register()`, never per request. No global mutable map decides a live route's posture,
  so there is no window in which it can change underneath it. Registering `auth:'session'`
  before `createRequireAuth` has run **throws**; it does not quietly serve.
- **`'session'` is defence-in-depth under `/api` and a genuinely new gate outside it.**
  `plan.md` §3's trap holds — the blanket `app.use('/api', requireAuth, …)` already covers
  every `/api` plugin router — but `/diagrams`, `/documents` and `/p/…` were never covered by
  it. CSRF posture is core's own (`SameSite=Lax`, no token layer) because it is the same
  `requireAuth` instance, not an equivalent one.
- **`'public'`/`'custom'` need a manifest declaration, checked at registration.** The gate
  lives in `pluginContext.ts` (the only layer that knows the manifest) and requires the
  **registered prefix** to lie inside a **declared** `permissions.public_paths` entry — never
  the inverse. The inverse would let a declaration for one webhook open the plugin's whole
  admin surface. Declaration is necessary, not sufficient: being served without a session
  still needs C4's exclusive ownership plus operator consent.
- **Consent is load-bearing, not decorative: `'public'`/`'custom'` entries are never mounted
  ambiently.** They are reachable exclusively through C4's terminating public-path mount,
  which re-checks the grant per request. Mounting them on the app as well would leave a
  non-session stack (no auth handler by construction) answering with neither session nor
  grant — masked under `/api` by the blanket gate, wide open outside it, where C4's
  `ownRoutePrefixes` branch legitimately permits prefixes like `/diagrams/…`. Two tests pin
  it: declared-but-ungranted is not served, and revoking a standing grant closes a live
  `'custom'` route. A third pins the converse — a granted prefix does **not** launder an
  `auth:'session'` route into a public one; anonymous still gets 401.
- **`body: 'raw' | 'json' | 'none'`, and the raw parse happens before the global JSON
  parser.** A route-local `express.raw()` alone does not work: body-parser marks the request
  `_body` and every later parser short-circuits, so a webhook posted as `application/json`
  reaches the plugin as an object and every HMAC fails. `pluginRawBodyMount.ts` is a new slot
  ahead of `express.json` that runs only the parser of a live, raw-registered prefix and then
  `next()`s. It never routes, never authenticates, never answers — no reachable surface is
  added. **Not** `express.json`'s `verify` hook (`plan.md` §3 G3).
- **Raw default limit is 512 KB, not the global 10 MB.** A raw body is necessarily buffered
  before authentication, so the default is the one the hand-rolled GitHub receiver already
  chose for the same reason; `bodyLimit` raises it visibly.
- **`body: 'raw'` goes through the same manifest declaration gate as `auth: 'public'`.** The
  raw parser runs in a GLOBAL mount ahead of `express.json` and ahead of authentication, so
  an unbounded raw prefix is not a local concern: `/` or `/api` would buffer every request in
  the process pre-auth at the raw limit and hand core routers a `Buffer` where they expect
  parsed JSON. Routing raw through C4's declaration schema (which forbids one-segment paths,
  core-reserved roots and core-`publicPaths` collisions) makes that unregisterable, and the
  registry keeps an independent `>= 2`-segment floor so a call site bypassing the manifest
  layer cannot claim one either.
- **The raw slot follows ownership, then rawness.** `resolveRawBodyRoute` takes the longest
  live prefix covering the path and only then asks whether it is raw. Picking the longest
  *raw* prefix instead let a shorter raw entry outrank a longer `body:'json'` entry that
  actually owns the path, and the json router silently received a `Buffer`. Pinned by a
  parent/child test — the pre-existing sibling test only covered disjoint prefixes.
- **Exit condition met:** a fixture plugin registers `POST /webhook` with
  `auth:'custom', body:'raw'` under a granted prefix and verifies `X-Hub-Signature-256` with
  `crypto.timingSafeEqual` over `req.rawBody` — valid signature 200, tampered body 401, after
  deactivate 404 (from C4's terminating mount, not the authenticated stack), and a
  `body:'json'` sibling still gets parsed JSON.
- `@omadia/plugin-api` gains `RouteAuthMode`, `RouteBodyMode`, `RouteRegisterOptions`;
  golden snapshot regenerated and the package bumped `1.0.0 → 1.1.0` per C1's rule.
  Decoupling ratchet unchanged — 3300, the baseline as it stands on `main` after
  C8 and the publish primitive; C6 adds no dev-platform reference.

### C7 / G4 — plugin-owned SQL schema (this PR, stacked on C2b #783)

- **`permissions.sql` is now a declaration the operator can see and refuse.** Manifest shape
  `{ migrations?: string, ledger: string }`; the ledger is charset-validated
  (`^[a-z][a-z0-9_]{2,62}$`) and must start with the plugin's sanitized id. Unknown
  `permissions.*` keys warn instead of vanishing silently — same implementation and same
  `KNOWN_PERMISSION_KEYS` shape C4 (#782) introduced, so the two merge as a one-line union.
- **`graphPool` is gated twice.** C2b's `requires:` check answers "did the author declare
  this?"; C7 adds "may this plugin touch the operator's database?" — `permissions.sql`
  **and** an operator grant row (`plugin_sql_grants`, migration **0047**). The two denial
  reasons stay distinct because `undeclared` is the author's to fix and `ungranted` is the
  operator's. C2b's dated legacy allowlist governs both gates and retires once, not twice.
- **One shared `runPluginMigrations`.** Advisory-locked (`pg_advisory_xact_lock`, plugin-only
  namespace 4420, `SET LOCAL lock_timeout` instead of a poll loop), one transaction per
  batch, sha256 per file, `.sql` + `.js`/`.mjs` in one filename order, empty-dir and
  checksum-drift both throw. B3 recorded core migrators racing on multi-replica boot; handing
  plugin authors a pattern to copy would have multiplied that bug into code the operator
  cannot patch.
- **Ownership is enforced by `UNIQUE (ledger)`, not by the prefix rule.** The prefix check
  cannot separate `acme_tool` from `acme_tool_extra` — a name carrying both prefixes would
  pass for either plugin. The database constraint has no such edge, so the prefix rule is
  documented as defence-in-depth rather than as the boundary.
- **Ratchet held at 3300** — no raise. The one line that moved it (+1, `middleware/src`) was a
  new comment naming the retired permission key, and it was reworded rather than excused.

### C8 — the abandonment checkpoint (G7 / P3b)

**Shipped.** The plugin UI mechanism, end to end. Everything before this point was
core capability work; this is the piece the whole extraction was blocked on, and it is
where the epic can honestly stop with a net-positive result.

- **Token bridge extracted.** The `@theme inline` block left `globals.css` for
  `web-ui/app/_lib/tailwind-bridge.css`; the shell imports it, the generated plugin
  stylesheet imports it, and the drift the C8 work exists to end is now structurally
  impossible rather than asked for in a comment.
- **Plugin stylesheet generated, not hand-written.**
  `web-ui/scripts/build-plugin-ui-css.mjs` compiles a finite Tailwind v4 vocabulary
  (`@import 'tailwindcss' source(none)` + `@source inline(...)`) from the same Lume
  tokens the shell uses, into the committed
  `middleware/assets/plugin-ui/plugin-ui.css`. CI regenerates and diffs it inside the
  existing web-ui job. Vocabulary documented in `plugin-ui-vocabulary.md`.
- **`admin-ui.css` retired as source.** `src/admin-ui/harness-admin-css.ts` — 345
  hand-maintained lines whose own header asked the next maintainer to keep two
  palettes "roughly in sync" — is deleted. `/api/_harness/admin-ui.css` is now an
  alias for the generated sheet and still carries the `.harness-*` helpers, so no
  shipped plugin admin UI is restyled by the upgrade.
- **Static serving for SPA bundles.** A plugin ships `ui/` (multi-file, hashed
  assets) and core serves it at `/p/<pluginId>/ui/…` — traversal-checked (lexical +
  realpath, root realpath'd too), extension-allowlisted, no directory listing,
  immutable caching for hashed files, CSP on the document. `.woff2` was added to the
  ZIP allowlist **scoped to `ui/`**. `.css` was NOT added and must not be — that
  absence is the enforcement.
- **Host page.** `/plugin-ui/<pluginId>` in web-ui embeds the bundle in a sandboxed
  iframe and passes `?theme=&palette=&locale=`, closing both §2.3 regressions
  (`next/font` and `data-theme` do not cross an iframe). Nav entries come from the
  existing `ctx.uiRoutes.registerNav`.
- **Ingest check.** Arbitrary Tailwind values in `ui/**/*.js` are rejected at package
  ingest with file, line and token. Its false-positive and false-negative limits are
  documented rather than implied.
- **Proved, not asserted.** `middleware/test/fixtures/plugin-ui-proof/` is a throwaway
  SPA driven through the real ingest path and the real routers, including the two
  negative cases: a `.css` inside `ui/` is rejected at extraction, an arbitrary value
  is rejected at ingest.

Artifact: 69.5 KB raw / **11.8 KB gzip** / 9.0 KB brotli. The measured probe was 7.7 KB
gzip against a narrower vocabulary and without the baseline + `.harness-*` layer that
replaces the separately-served `admin-ui.css`.

### C10 — the flip (this PR)

**Shipped.** The Dev Platform is gone from core. It lives in
`byte5ai/omadia-dev-platform` and installs via the Hub (or a ZIP upload).

- **~49k LOC / 213 files deleted in one PR**, because a partial delete leaves `tsc`
  red: the backend tree, its 58 test files, the runner shim, three sidecars, the
  compose topology, the operator SPA, the CI image matrix and its supply chain, the
  43 config keys, and the whole `index.ts` assembly block.
- **Ratchet 3,300 → 214.** Nine of fourteen zones read CLEAN. Everything left is
- **~49k LOC / 217 files deleted in one PR**, because a partial delete leaves `tsc`
  red: the backend tree, its 58 test files, the runner shim, three sidecars, the
  compose topology, the operator SPA, the CI image matrix and its supply chain, the
  43 config keys, and the whole `index.ts` assembly block.
- **Ratchet 3,300 → 214.** Nine of fourteen zones read CLEAN. Everything left is
- **Ratchet 3,300 → 211.** Nine of fourteen zones read CLEAN. Everything left is
  scheduled: migrations `0022`–`0030` (69) are **C11**, the two `publicPaths`
  exemptions (6) are **C12**, and the remainder is **C13** residue — comments,
  fixture strings, the `plugin-api` CHANGELOG that records the removal, and the
  ratchet script's own pattern list.
- **KEPT deliberately** (each argued in the PR): `services/githubAppJwt.ts` (§5 —
  sending it out would recreate the reverse dependency across a repo boundary),
  `express`/`pg`/`zod` (§5 — plugin `peerDependencies`, now with the comment §5
  asked for), `DEV_ENDPOINTS_ENABLED` + `DEV_ENDPOINTS_LOOPBACK_ONLY` (core
  dev-graph), `FLY_APP_NAME` (describes the host), `devFlag()` (two `PUBLIC_MCP_*`
  call sites), and the generic C1–C8 platform capabilities.
- **H3 resolved by omission.** `chat/page.tsx` no longer names `dev_job_start`; the
  plugin's start tool falls through to the generic long-running-task card. That is
  the accepted degradation from the two options above.
- **One coverage reduction, recorded not absorbed.** The adversarial eval's
  `brief_delimiter` Tier A probe ran the real `composeBrief` out of
  `src/devplatform/`. It leaves with the code it measured, taking the
  `direct_injection` and `indirect_injection` deterministic vectors with it
  (12 scenarios → 7). `test/adversarial/README.md` states both ways to close it.
- **A latent ordering bug fell out.** The `/api/v1/dev-runner/llm/` `express.json`
  carve-out sat ahead of the conductor's inbound webhook router, whose route-level
  `express.raw()` body-parser then short-circuited. Deleting the carve-out restores
  the order the surrounding comments already promised.

### C11 — the migration handoff (this PR)

**Shipped.** Migrations `0022`–`0030` stay in core's ledger; the plugin adopts them
without re-running them and without being able to lie about it.

- **`ctx.sql.seedLedger({ entries, dryRun })`** (plugin-api **1.3.0**, additive and
  optional). The plugin supplies its filenames and a witness per file; **core**
  supplies the donor ledger (`_multi_orchestrator_migrations` — the migrator that
  owns `middleware/migrations/`). A plugin has no field for the donor table, which
  is what keeps one plugin out of another plugin's migration history.
- **The witness decides, the donor row corroborates.** Rows present + objects absent
  is the case that kills an installation silently, and it is the only case the naive
  seed gets wrong. `skippedNoWitness` is the number to read: core says these ran, the
  catalog says they did not.
- **Filenames match by STEM.** The plugin ships `0022_dev_platform.js` (codegen'd);
  core recorded `0022_dev_platform.sql`. Matching on the full name would find nothing
  and report "no donor rows", which looks exactly like a fresh install.
- **Row shape is shared, not re-spelled.** `pluginLedgerDdl` and `migrationChecksum`
  are exported from `pluginMigrations.ts` and used by the seeder, so a seeded row is
  byte-identical to one the runner would have written. Get the checksum wrong and the
  drift guard turns a successful handoff into a hard activation failure one boot later
   — which is why the tests always run the migrator after the seed.
- **`dryRun` writes nothing**, including the `CREATE TABLE IF NOT EXISTS` for the
  ledger and any side effect a witness might have: the whole pass runs in one
  transaction that is rolled back.
- **Donor rows are never deleted.** That is the rollback path — see below.
- **Operator CLI:** `node middleware/scripts/plugin-ledger-handoff.mjs --plan <plan.json>`
  (dry run by default; `--apply` writes). Deliberately generic and named generically:
  core's ratchet requires that no core file name the extracted plugin, and the next
  plugin to leave core wants this tool unchanged.

#### The nine witnesses

One per file, each proving the **last** schema object that file creates — the last
one, because a core migration file ran in a single transaction, so the last object
is present exactly when the whole file was applied. These live in the plugin repo
(`packages/plugin/src/ledgerHandoff.ts`); they are reproduced here because core may
not name them and this is the document that has to survive the extraction.

| File | Last object it creates | Witness |
|---|---|---|
| `0022_dev_platform.js` | table `dev_job_artifacts` | `SELECT to_regclass('public.dev_job_artifacts') IS NOT NULL` |
| `0023_dev_platform_pipeline.js` | table `dev_github_app_installations` | `SELECT to_regclass('public.dev_github_app_installations') IS NOT NULL` |
| `0024_dev_platform_w3.js` | column `dev_jobs.conductor_await_id` | `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dev_jobs' AND column_name='conductor_await_id')` |
| `0025_dev_jobs_source_plugin.js` | constraint `dev_jobs_source_check` **containing `'plugin'`** | `SELECT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname='dev_jobs' AND c.conname='dev_jobs_source_check' AND pg_get_constraintdef(c.oid) LIKE '%''plugin''%')` |
| `0026_dev_job_gate_kind.js` | column `dev_job_gates.gate_kind` | `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dev_job_gates' AND column_name='gate_kind')` |
| `0027_dev_platform_triggers.js` | column `dev_jobs.usage_estimated` | `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dev_jobs' AND column_name='usage_estimated')` |
| `0028_dev_jobs_webhook_one_active.js` | index `dev_jobs_webhook_one_active` | `SELECT to_regclass('public.dev_jobs_webhook_one_active') IS NOT NULL` |
| `0029_dev_platform_retention.js` | index `dev_jobs_terminal_ended_idx` | `SELECT to_regclass('public.dev_jobs_terminal_ended_idx') IS NOT NULL` |
| `0030_dev_job_events_truncated_marker.js` | index `dev_job_events_truncated_once_idx` | `SELECT to_regclass('public.dev_job_events_truncated_once_idx') IS NOT NULL` |

**Two traps a witness author walks into.** `'public.dev_jobs'::regclass` THROWS on a
missing table — the exact case the witness exists to detect — so use `to_regclass`
or a catalog join, never a cast. And `SELECT count(*) FROM t` is not a witness: it is
`1` for a table that exists, `0` for one that exists and is empty, and a throw for
one that does not. The kernel enforces the shape rather than guessing: exactly one
row, exactly one column, a real boolean.

#### Rollback

Uninstalling the plugin and reverting C10 leaves core's migrator **consistent**,
because nothing in the handoff writes to core's ledger:

1. The donor rows in `_multi_orchestrator_migrations` are untouched — a test asserts
   the table is byte-for-byte identical after a seed. Revert C10 and core's migrator
   finds its ledger exactly as it left it, applies nothing, and boots.
2. The plugin's ledger (`plg_omadia_dev_platform_migrations`) is a table only the
   plugin reads. An uninstall may drop it or orphan it (D3: orphan by default); either
   way core never looks at it.
3. The `dev_*` tables themselves are never dropped by the handoff. C10 kept the
   migrations in core for exactly this reason: for one release both sides can apply
   them, and the files are idempotent.

The one irreversible act in this area would be **deleting** the donor rows, which is
why the module does not contain a `DELETE` at all: with the rows gone and core still
shipping the files, core's own migrator would re-run all nine on the next boot.

### Still held back

- **DynamicAgentRuntime rollback** — two attempts rejected. The current one does not cover
  the timeout path: `withTimeout` does not cancel, so after the rollback the orphaned
  `activate()` keeps running and re-registers.

### Next — decisions before code

Two are genuinely blocking and belong to the maintainer, not the implementer:

1. ~~**H3 — the chat card.**~~ **Resolved in C10 by omission.** `chat/page.tsx` no longer
   names the tool. The bespoke card left with the plugin and its start tool now falls
   through to the generic long-running-task card (`isTaskStartToolName` / `TaskChatCard`)
   — the "accepted degradation" branch of the two options, not the declarative schema.
   A plugin wanting a richer card needs the C8 UI contract, not a core code path.
2. ~~**G7 fallback.**~~ **Resolved by C8.** Option B is built and proved: a plugin ships a
   compiled SPA, core serves it and the stylesheet it links. Option E (an npm-published UI
   package web-ui optionally installs) is no longer needed and should not be revived — it
   only ever weakened "no hardcoding" to "no source in core".

Then P3's extension points (H1 public paths + prefix ownership, H2 conductor step-kind
registry, G2/G3/G4), which everything else waits on.

---

## How we knew it was complete — and why the guard is gone

**The decoupling ratchet is retired.** `scripts/check-core-decoupling.mjs` and its committed
`decoupling-baseline.json` counted Dev Platform references across 14 disjoint zones from
2026-07-30 (#539) to 2026-08-21 (C14). It peaked at **3,448**, fell to 214 at C10 and reached
**0** at C13, where it was pinned permanently. C14 removed the script, its colocated detector
test, the baseline file and the CI job.

It was removed because it had won. A ratchet is scaffolding for a migration in flight: it
makes a stale file inventory survivable, because a checklist goes stale on contact and a
count does not. Once the count is zero and the extraction is finished, the guard has nothing
left to guard — it only costs a CI job and a number for someone to edit. Bringing the Dev
Platform back into core is now an ordinary architectural decision, argued for in review.

Two facts outlive the guard:

- **It counted identifiers, not behaviour, and never the English name.** Prose may still say
  "the dev platform plugin"; what could not survive was an identifier-shaped reference — an
  import, a route, a config key, an i18n key, a fixture string, a
  `devPlatform`/`dev-runner`/`DEV_JOB` token. Zero was always a necessary condition for done,
  never a sufficient one: §2 and §3 of `acceptance.md` cover the rest, and neither is
  automated.
- **`services/githubAppJwt.ts` stays in core.** It carries no dev-platform identifier because
  it is generic GitHub App auth. Moving it into the plugin repository would recreate the
  reverse dependency across a repo boundary.

The plugin lives at `byte5ai/omadia-dev-platform`.

**Definition of done:** every row of `acceptance.md` §2 passes, and the install/uninstall
criteria in `acceptance.md` §3 pass.

---

## Working agreement for this PR

- **One commit per phase**, so a ~49k-LOC epic stays reviewable and revertible even though
  it lives in one PR.
- **Wire paths are frozen.** No phase may change `/api/v1/dev-runner`,
  `/api/v1/admin/dev-platform`, `/api/webhooks/github`, or `RUNNER_PROTOCOL_VERSION` —
  deployed runner images phone home to literal URLs and a rename bricks in-flight jobs with
  no compile-time signal.
- **Do not delete the `publicPaths` exemptions** until H1's mechanism is proven on the live
  runner path. Deleting them early 401s every phone-home.
- **Abandonment checkpoint:** after P3/P3b the platform capabilities stand alone and the
  Dev Platform can stay in core with no partial-move debt. Half-moved is the only genuinely
  bad end state.
