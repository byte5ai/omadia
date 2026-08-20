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
| **`decoupling-baseline.json`** | The committed reference count the CI ratchet enforces | Never by hand — use `--update` |

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

### Still held back

- **DynamicAgentRuntime rollback** — two attempts rejected. The current one does not cover
  the timeout path: `withTimeout` does not cancel, so after the rollback the orphaned
  `activate()` keeps running and re-registers.

### Next — decisions before code

Two are genuinely blocking and belong to the maintainer, not the implementer:

1. **H3 — the chat card.** `chat/page.tsx` hardcodes `tool.name === 'dev_job_start'` and
   renders a core-compiled React card. An iframe per tool call is not acceptable. Either a
   declarative card schema, or an accepted degradation to a plain `ToolRow` for
   out-of-repo plugins. This is the one place "no hardcoding" and "no downgrade" conflict.
2. ~~**G7 fallback.**~~ **Resolved by C8.** Option B is built and proved: a plugin ships a
   compiled SPA, core serves it and the stylesheet it links. Option E (an npm-published UI
   package web-ui optionally installs) is no longer needed and should not be revived — it
   only ever weakened "no hardcoding" to "no source in core".

Then P3's extension points (H1 public paths + prefix ownership, H2 conductor step-kind
registry, G2/G3/G4), which everything else waits on.

---

## How we know it is complete

Three different jobs; none of them is sufficient alone.

```bash
node scripts/check-core-decoupling.mjs            # verify (CI runs this)
node scripts/check-core-decoupling.mjs --report   # per-zone breakdown
node scripts/check-core-decoupling.mjs --update   # lower the baseline
```

The ratchet counts Dev Platform references across 14 disjoint zones and **fails if the count
rises, per zone**. Baseline **3,300**. It only ever falls; raising it needs a hand-edited baseline, so
a new coupling shows up in review instead of slipping in.

That is what makes the checklist's staleness survivable — a file inventory goes stale on
contact, but the count does not, and it cannot reach zero while a reference survives.

But it counts IDENTIFIERS, NOT BEHAVIOUR: zero is a necessary condition for done, not a
sufficient one. Sections 2 and 3 of `acceptance.md` cover the rest, and neither is automated.

**The baseline rises for two reasons, and only two.** (1) main legitimately adds dev-platform
code. (2) A refactor concentrates coupling into a namespace whose own name matches the
pattern — C3 is the one instance: collapsing 41 flat config keys into `config.devPlatform`
added a mapping layer that names each key a second time (+48 in config.ts, +36 in the new
type file, against −33 in index.ts). The net is **+62** — `middleware/src` +29 and
`middleware/test` +33 — and it measured identically against three successive mains (before
#554, after #554, after #555), which is what shows it is C3's own concentration and not
drift picked up from elsewhere. The test half is the same effect — a shared
`devPlatformConfig.harness.ts` plus the moved routers' new `src/devplatform/routes/…` import
paths. **Every one of the 212 added matching lines in the test zone sits inside
`middleware/test/devplatform/`; none is outside it**, so no core test acquired a
dev-platform dependency. All of it deletes at extraction. Everything else is a
regression. That has happened three
times (PR #529, then #537's embedding work): the guard fires, the raise is hand-edited, and the
reason is recorded in the commit. A rise is only wrong when *core* re-acquires a dependency.

**C2b is a third kind of rise, and the smallest: +5, all documentation of a removal.**
`middleware/packages` 84 → 89, from the new `packages/plugin-api/CHANGELOG.md`. A changelog
recording that the `DevJob*` types were deleted has to name them, or a consumer grepping its
own source for `DevJobDescriptor` finds nothing and the record is worthless. Three of the five
lines are literal strings that cannot be reworded at all — a spec path, a test filename, and
the future package name `@omadia/dev-platform-plugin-api`; the other two are the removal
heading and the six type names, deliberately collapsed onto one line each. The count was
first +31: the example capability in the new gate tests and a `perCallerService` docblock both
used `devJobs` gratuitously, and both were reworded to a neutral name rather than excused —
`middleware/test` is back at its baseline of 1,030, unchanged. Nothing in core references the
dev platform as a result of this PR; the residue is prose *about* code that left.

**Definition of done:** ratchet reads `0`, every row of `acceptance.md` §2 passes, and the
install/uninstall criteria in `acceptance.md` §3 pass.

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
