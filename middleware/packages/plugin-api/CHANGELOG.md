# Changelog — `@omadia/plugin-api`

The type contract every omadia plugin compiles against. The package is
`private: true` and is not published to npm; plugin repositories consume it by
`file:` link or a vendored `.d.ts` (epic #470, decision D1).

Versioning is SemVer over the **exported type surface**. Removing or narrowing
an exported type, or adding a required member to an interface a plugin
implements, is a major.

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
