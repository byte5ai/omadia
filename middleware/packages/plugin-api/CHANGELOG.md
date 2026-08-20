# Changelog — `@omadia/plugin-api`

The type contract every omadia plugin compiles against. The package is
`private: true` and is not published to npm; plugin repositories consume it by
`file:` link or a vendored `.d.ts` (epic #470, decision D1).

Versioning is SemVer over the **exported type surface**. Removing or narrowing
an exported type, or adding a required member to an interface a plugin
implements, is a major.

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
