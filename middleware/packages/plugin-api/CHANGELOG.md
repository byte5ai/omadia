# Changelog — `@omadia/plugin-api`

The type contract every omadia plugin compiles against. The package is
`private: true` and is not published to npm; plugin repositories consume it by
`file:` link or a vendored `.d.ts` (epic #470, decision D1).

Versioning is SemVer over the **exported type surface**. Removing or narrowing
an exported type, or adding a required member to an interface a plugin
implements, is a major.

## 1.10.0 — 2026-08-21

Additive. The service grant gate reports which verb it refused, and `replace`
is now gated on the same declaration as `get` (issues #788, #789).

Numbered 1.10.0 rather than 1.8.0: 1.8.0 and 1.9.0 were taken on `main` by the
transcription capability (#829) and the timer/nudge surface (#830) while this
branch was open. Reusing 1.8.0 would have shipped two different exported type
surfaces under one version — the failure this file's SemVer rule exists to
prevent.

### Added

- **`ServiceGateOperation`** — `'get' | 'replace'`, the `ctx.services` verb the
  gate refused.
- **`ServiceNotDeclaredError.operation`** — defaults to `'get'`, so every
  existing construction site keeps its exact message. The constructor takes it
  as an optional 4th argument.

### Changed

- **`ctx.services.replace(name, …)` now throws `ServiceNotDeclaredError`** when
  the plugin's manifest does not declare `name` under
  `requires:`/`optional_requires:`, and when it declares `name` only under
  `provides:` without holding a live registration for it. `replace` is the one
  verb that takes a live name away from its owner, so an ungated `replace` let
  any activated plugin swap out core's `graphPool` or another plugin's service
  for an implementation every later consumer then resolves. `provide` stays
  ungated — it throws duplicate-provider rather than displacing anyone.

  Decorators are unaffected: wrapping a capability already requires declaring
  it (`@omadia/orchestrator-extras` declares `knowledgeGraph@^1`), and
  re-wrapping a plugin's own registration is already `self-provided`. Scanned
  before landing: 21 bundled packages and 35 sibling plugin repos contain one
  `ctx.services.replace` call site between them, and it declares its name.

## 1.6.0 — 2026-08-21

Additive. `permissions.sql` gains an optional `handoff` — a path, inside the
package, to the JSON plan the kernel runs BEFORE it runs the plugin's
migrations directory (epic #470, C15).

### Added

- **`SqlPermission.handoff?: string`** — names a plan of the same shape
  {@link SqlAccessor.seedLedger} accepts:
  `{ "entries": [{ "filename", "witnessSql" }], "dryRun"?: false }`. The kernel
  reads it at activation, validates it against the package root, and performs
  the handoff through the same seeder — read-only witness fence, advisory lock
  and entry validation included — before its own migration runner. A shared
  file MAY carry `"dryRun": false` for the operator CLI's benefit; the kernel
  refuses `"dryRun": true`, because a preview that writes nothing would hand
  every file straight to the migration runner below. Use the CLI's
  `--dry-run` / `--apply` flags to preview or apply.

### Why a declaration and not the call C11 already shipped

`seedLedger` was documented as "call this BEFORE `runMigrations`", and a plugin
cannot honour that. The kernel runs the migrations directory ITSELF, before
`activate()`, so that "the tables exist" is an invariant `activate()` can rely
on rather than a race each plugin re-loses in its own way. The plugin's own
call therefore always arrived second, after every ledger row was already
written.

The 2026-08-21 acceptance run of the first extracted plugin measured the
consequence on the exact upgrade C11 exists for: `0 seeded, 9 already seeded`,
with `skippedNoWitness` — the one alarm the feature was built to raise —
unreachable. Nothing failed, and that is the problem: the line is
indistinguishable from a healthy re-run.

The witnesses are knowledge only the plugin has; the ordering is a decision
only the kernel can make. So the plugin declares and the kernel executes.

### Compatibility

Every existing consumer keeps compiling: `handoff` is optional, and a plugin
that omits it sees the pre-1.6.0 behaviour exactly. `SqlAccessor.seedLedger`
is unchanged and stays the right call for a plugin that manages its own
ordering or must work against a kernel older than this one — against a kernel
that honours `handoff`, that call simply reports `alreadySeeded`, which is what
it should report once the work is done.

## 1.5.0 — 2026-08-21

> **Why 1.4.0 and not 1.3.0.** This change was written against a tree where
> `1.3.0` was free. #802 (epic #470 C9) landed on `main` first and took it, so
> the number moved rather than the meaning: everything below is the same
> additive surface, and `1.3.0` on `main` is C9's. Two open PRs claiming one
> version is a merge-order accident, not a semantic one — but a duplicate
> version is indistinguishable from a silently-changed contract to anything
> that resolves by version, so it gets its own.

Additive. A plugin that was extracted out of core can now ADOPT an existing
installation's schema instead of re-applying it — and does so on proof rather
than on trust (epic #470, C11 — the migration handoff). Every existing consumer
keeps compiling: `seedLedger` is optional on `SqlAccessor`, so a plugin built
against 1.4.0 still activates on an older core, where the accessor is
`undefined` and the (idempotent) migrations simply run.

### Added

- **`SqlAccessor.seedLedger(opts)`** — optional. Records the plugin's own
  migration files as applied, one file at a time, when a witness proves the
  schema object that file creates already exists. Core supplies the donor
  ledger; the plugin supplies its filenames and its witnesses. Never deletes a
  donor row — those are the rollback path.
- **`LedgerSeedEntry`** — `{ filename, witnessSql }`. The filename is the
  plugin's own, matched to the donor ledger by STEM, so a codegen'd
  `0022_x.js` adopts core's `0022_x.sql`.
- **`SeedLedgerOptions`** — `{ entries, dryRun?, dir? }`. `dryRun` computes the
  plan against the live database inside a transaction that is rolled back:
  nothing is written, including anything a witness touched.
- **`LedgerSeedReport`** — `{ seeded, applied, skippedNoWitness, alreadySeeded,
  donorRecorded, ledger, donorLedger, dryRun, durationMs }`.
  `skippedNoWitness` is the one to read: the donor says these ran, the catalog
  says their objects are absent. On a healthy installation it is empty; a
  non-empty list is a restore or a rollback, and the migration runner is about
  to repair it.

### Why the witness and not the donor row

The naive handoff copies the donor ledger's rows and skips those files. That is
correct on a healthy database and silently destroys one specific installation:
rows present, tables ABSENT — a restore from an older snapshot, a version-skewed
rollback, an operator who dropped a table during an incident. The plugin
activates green and every request 500s, nine steps away from the cause. So the
donor ledger is corroboration and the witness is the decision.

## 1.4.0 — 2026-08-20

- MINOR: `PluginActionStatus` gains an optional, kernel-stamped `checked_at`
  ISO timestamp, and `ctx.status.report({ state: 'ok', title })` is now stored
  and rendered as a positive "connection verified" badge instead of being
  normalized to `clear()`. A BARE `{ state: 'ok' }` keeps its clear() synonym
  semantics — no existing caller changes behaviour. (Field-test OM-16/24/33:
  integrations can now surface "Verbunden · geprüft <Zeit>" on the store card.)

## 1.3.0 — 2026-08-20

Additive. Two shapes a plugin could not express before, both found by the
epic #470 P5 acceptance run against a real core: a dependency it can survive
the absence of, and a nav entry pointing at its own bundled UI when its id is
scoped. Every existing consumer keeps compiling — the new members are optional
or additive, and no existing member changed meaning.

### Added

- **`ctx.services.getOptional(name)`** (`<T>(name: string) => T | undefined`)
  — the accessor for a capability declared under the new manifest field
  `optional_requires:` (#795). Declaration-gated exactly like `get`, so an
  undeclared name still throws `ServiceNotDeclaredError` and a typo cannot
  quietly become `undefined`; what it adds is a call site that says absence is
  survivable. `optional_requires:` entries use the same capability-ref syntax
  as `requires:` and satisfy the same declaration gate, but are NOT an
  activation dependency: the installer raises no
  `install.missing_capability`, and the capability resolver neither demands
  nor orders a provider for them.

  The ordering consequence is part of the contract: with no activation edge,
  an optional provider that IS installed may activate after its consumer.
  Resolve optional services lazily, at first use, rather than caching the
  result of one call during `activate()`.

- **`UiNavEntryInput.pluginUi`** (`true | undefined`) — ask the kernel to
  render the canonical path to this plugin's own bundled UI instead of
  supplying a literal `href` (#798). A scoped plugin id resolves only
  percent-encoded (`/plugin-ui/%40acme%2Fwidget`), and percent-encoding is
  precisely what the literal-`href` validator refuses — so a scoped plugin
  previously had no spelling that both validated and worked. Supply exactly
  one of `href` or `pluginUi: true`; supplying both, or neither, throws.

- **`ResolvedUiNavEntry.pluginUi`** (`true | undefined`) — set on entries
  registered that way, so the web UI re-derives the href from `pluginId`
  locally instead of trusting a percent-encoded string across a deployment
  boundary.

### Changed

- **`UiNavEntryInput.href`** is now optional (`string | undefined`), because
  a `pluginUi: true` entry supplies none. Widening an input field: every
  plugin that passes an `href` today is unaffected.
- **`UiNavEntry.href`** stays required — the kernel resolves `pluginUi` to a
  concrete path at registration, so a catalogued entry always has one.
- **`ServiceNotDeclaredError`**'s message now names `optional_requires:` as a
  fix alongside `requires:` and `provides:`.

## 1.2.0 — 2026-08-20

Additive. A plugin may now be handed a Postgres pool and own tables in the
operator's database — but only after declaring `permissions.sql` and being
granted it (epic #470, C7 — G4 plugin-owned SQL schema). Every existing
context consumer keeps compiling: `ctx.sql` is optional and is `undefined`
for a plugin that declared nothing.

### Added

- **`ctx.sql`** (`SqlAccessor | undefined`) — present only when the plugin
  declared a valid `permissions.sql` block AND an operator grant row exists.
  Absence is the normal case and is not an error; it is the shape a denial
  takes, so a plugin that forgot to declare gets `undefined` rather than a
  pool it should not hold.
- **`SqlPermission`** — `{ migrations?: string, ledger: string }`, the
  manifest block. The ledger is charset-validated and must live inside the
  plugin's own `plg_<sanitized-id>_` namespace, so a plugin cannot name a
  core table as its migration ledger.
- **`SqlAccessor`** — `{ ledger, runMigrations(opts?) }`. The one shared
  migration runner, advisory-locked and transactional per batch, rather than
  a pattern each plugin author reimplements.
- **`RunMigrationsOptions`** — `{ dir?, allowChecksumDrift? }`.
- **`MigrationReport`** — `{ applied, skipped, ledger, durationMs }`.
- **`SqlPermissionError`** — carries `reason: 'undeclared' | 'ungranted'`.
  The two stay distinct because `undeclared` is the plugin author's to fix
  and `ungranted` is the operator's.
- **`LedgerNameError`**, **`SqlMigrationError`** — thrown for a ledger name
  outside the plugin's namespace and for a failed or drifted migration batch.

A pool-shaped capability reaching a plugin through `ctx.services.get` is now
BORROWED: `end()` throws rather than tearing down the connection pool core
writes user data through (#665).

## 1.1.0 — 2026-08-20

Additive. Route registration gains an optional third argument; every existing
`ctx.routes.register(prefix, router)` call site keeps compiling unchanged
(epic #470, C6 — G2 route auth, G3 raw body).

### Added

- **`RouteAuthMode`** (`'session' | 'public' | 'custom'`) — the authentication
  posture the kernel composes in front of a contributed router. Default
  `'session'`, which is the previous behaviour made explicit. `'public'` and
  `'custom'` additionally require the registered prefix to lie inside a
  declared `permissions.public_paths` entry, checked at registration; being
  *served* without a session still needs C4's exclusive prefix ownership plus
  operator consent.
- **`RouteBodyMode`** (`'json' | 'raw' | 'none'`) — which body parser runs
  before the router. Default `'json'`, the previous behaviour. `'raw'` is
  captured ahead of the kernel's global `express.json`, because a route-local
  `express.raw()` cannot recover bytes body-parser has already marked
  consumed — the reason HMAC-verifying webhooks could not be written as
  plugins before.
- **`RouteRegisterOptions`** — `{ auth?, body?, bodyLimit? }`, the optional
  third parameter of `RoutesAccessor.register`. `bodyLimit` defaults to 10 MB
  for `'json'` and **512 KB** for `'raw'`: a raw body is necessarily buffered
  before authentication, so its ceiling is the anonymous one.

The composition order around a contributed router is now fixed and documented
on `RoutesAccessor`: `[deactivation guard] → [auth] → [body parser] → router`.
The guard is first on purpose — a deactivated plugin's prefix answers 404
before any auth logic or body buffering runs, rather than 401.

## 1.0.0 — 2026-08-20

First stable cut of the contract. Two breaking changes are taken together,
deliberately, in one major — **now**, while the installed base is still zero
and every consumer is a repository we control. There is no published `0.x`
range on npm and no third-party plugin pinned to one, so the cost of the break
is a coordinated bump across the sibling repos rather than an ecosystem event.
Deferring it would only have made it expensive (epic #470, `implementation.md`
§1 row 4).

### Breaking

- **Removed the dev-platform job types and their context accessor.** No longer
  exported (spelled out on one line, once, so a consumer grepping its own source finds this entry): `DevJobKind`, `DevJobStatus`, `DevJobDescriptor`, `DevJobCreateRequest`, `DevJobEventRecord`, `DevJobsAccessor`, `PluginContext.devJobs`.

  They were never usable. Nothing ever registered the backing host service, so
  every call threw, and no manifest in this repository, in the private byte5
  plugin set, or in any sibling plugin repository ever declared the matching
  permission (`specs/470-dev-platform-plugin/dormant-capabilities.md` §2). The
  view types survive core-locally under `middleware/src/` and travel with the
  extraction into its own repository, where the plugin will own them as
  `@omadia/dev-platform-plugin-api`. They are deliberately not re-published
  from here for zero consumers.

  *Migration:* none required — no working code can exist against a surface that
  threw on every call. A stale manifest still declaring the legacy permission
  key keeps installing and activating unchanged; unknown permission keys are
  ignored, not rejected (regression-pinned in
  `test/manifestDevJobsLegacyKey.test.ts`).

- **`ctx.services.get(name)` is now gated on the manifest.** A plugin may only
  resolve capability names it declares in `requires:` (or `provides:`, to read
  back its own registration). An undeclared name throws the new
  `ServiceNotDeclaredError` instead of returning the implementation.

  Previously the accessor was a bare pass-through: any installed plugin could
  ask for any registered service — including `graphPool`, the same Postgres
  pool the kernel uses — with no declaration and nothing in the install dialog
  (epic #470, bug B1).

  *Migration:* add the capability to the manifest's `requires:` list, e.g.
  `requires: ["graphPool@^1"]`. The service-registry key **is** the capability
  name. A dated allowlist
  (`LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20` in
  `middleware/src/platform/pluginServiceGrants.ts`) grandfathers the exact
  (plugin, capability) pairs an audit found in shipped plugins: those warn once
  and resolve. The allowlist is closed — a different plugin, or a different
  name, still throws.

  *Note:* `requires:` is also the activation dependency, so declaring an
  optionally-consumed capability makes it mandatory. Expressing an optional
  requirement is an open design question and the reason the allowlist exists at
  all rather than every row being fixed in place.

- **`ServicesAccessor.provide` / `.replace` widened to
  `T | PerCallerFactory<T>`.** Source-compatible for every existing call; only
  code that *implements* `ServicesAccessor` (the kernel, and test doubles that
  type themselves against it) sees the change.

### Added

- `perCallerService(factory)` — register a service that mints one
  implementation per consuming plugin. The factory receives a `ServiceCaller`
  (`{ agentId, pluginId }`) built from the id the **kernel** activated the
  consumer under, never from an argument the consumer supplies. This is what
  lets a provider attribute, scope or filter per consumer without asking the
  consumer to name itself — the self-attribution hole that removing the
  accessor above would otherwise have opened (epic #470 §2.2).
- `ServiceCaller`, `PerCallerFactory<T>`, `isPerCallerService`,
  `resolvePerCallerService` — the supporting surface. The factory is a
  symbol-branded object rather than a bare function, so a service that *is* a
  function can never be mistaken for a factory.
- `ServiceNotDeclaredError` — typed, carrying `pluginId`, `capability` and
  `manifestField`, so a plugin can tell "the operator has not installed a
  provider" (`get` returns `undefined`) from "I forgot to declare this" (this
  throw). The two used to look identical.

## 0.1.0

Initial extraction of the plugin-facing types out of the middleware kernel, so
plugin packages could import them without reaching back into `middleware/src`.
