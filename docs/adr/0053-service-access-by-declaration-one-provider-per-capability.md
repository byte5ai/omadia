# 0053 — A plugin reaches a service only by manifest declaration; one active provider per capability

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); grant gate from epic #470 (bug B1, item C2b), tightened in #788, #789, #794, #795, #838/#839; provider collisions from OM-87 / #1053
- **Supersedes:** — (refines [ADR-0003](0003-capability-based-multi-provider-middleware.md): its "several providers of one capability at once" does not hold for the service registry)

## Context and Problem Statement

[ADR-0003](0003-capability-based-multi-provider-middleware.md) made every service a named
capability that plugins provide and consume. The registry behind it was a bare service
locator: `ctx.services.get(name)` returned whatever was registered, so any installed plugin
could take `graphPool` (the operator's Postgres pool), `tigrisStore` or `anthropicClient`
without a manifest line and without anything in the install dialog. The registry also
never said what happens when two installed plugins provide the same capability. This
record is written retroactively; the decision is implemented on main.

Who may resolve a service, and which provider answers when more than one is installed?

## Decision Drivers

- What a plugin can reach must be readable from its manifest before it is installed.
- A self-declaration that costs nothing must not buy access to somebody else's object.
- Shipped plugins with incomplete manifests must not break in one step.
- Boot must stay up when two providers collide; the operator needs a named cause.
- A dependency a plugin can live without must not block its activation.

## Considered Options

- **A — Declaration-gated access at the plugin context; one active provider per capability**
- **B — Keep the open service locator** (trust installed plugins)
- **C — Policing inside the registry itself**, for kernel and plugins alike
- **D — Several active providers per capability with a per-consumer selection**

## Decision Outcome

Chosen option: **A**.

- **The service-registry key is the capability name**, so the manifest already carries the
  declaration. `createServiceGrantGate` (`middleware/src/platform/pluginServiceGrants.ts`),
  called from `createPluginContext`, decides every `ctx.services.get`:
  - `requires: ["name@^1"]` grants `get('name')` and is an activation prerequisite;
  - `optional_requires:` grants `get` and `getOptional` and creates no prerequisite and no
    ordering edge (#795);
  - `provides:` alone grants `get` only while the asking plugin holds a live registration
    for that name (`ServiceRegistry.providedBy`, #788): `provide()` first, `get()` after;
  - anything else throws `ServiceNotDeclaredError`, naming the capability and the manifest
    field that would grant it. `replace` is gated on the same terms as `get`.
- **The registry itself stays unenforcing.** The kernel resolves its own services through
  it (`KERNEL_SERVICE_CALLER`); the gate sits only in front of plugin consumers.
- **Two name sets no declaration can buy:** `KERNEL_ONLY_SERVICE_NAMES` (the privacy
  guard's real field samples) and `RAW_MODEL_SERVICE_NAMES` (`anthropicClient`, `llm`,
  `llmProviderPool`), the latter per [ADR-0017](0017-model-gateway-and-execution-contexts.md).
- **A dated, closed allowlist grandfathers history.** The audit of 2026-08-20 found 63
  undeclared (plugin, capability) pairs. They warn once and resolve; a different plugin or
  a new name still throws. The bundled half is consulted only for packages whose catalog
  origin is `bundled`; an uploaded package that claims a bundled id inherits nothing.
  Rows are retired by declaring the capability in the plugin's manifest.
- **One active provider per capability.** `ServiceRegistry.provide` throws on a second
  registration of a name. At boot `resolveEligiblePlugins`
  (`middleware/src/plugins/capabilityResolver.ts`) keeps the provider with the older
  `installed_at`, drops the younger one as a whole plugin and reports it as
  `provider_conflict`, separately from missing dependencies. Install-time callers keep the
  strict default and throw. A consumer whose `requires` has no provider is dropped the same
  way (cascading), and the install route answers 409 with `available_providers`.
- **Decoration is the one sanctioned stacking:** `replace` wraps the current provider and
  restores it on dispose (LIFO).
- **Optional services are resolved lazily.** Because `optional_requires` adds no ordering
  edge, an installed optional provider may activate after its consumer; a plugin resolves
  such a service at first use and never caches the result of one call during `activate()`.

### Consequences

- 🟢 **Good:** A plugin's reach is its manifest; an undeclared read fails with a message
  that names the fix.
- 🟢 **Good:** A provider collision costs one plugin, not the boot, and names both sides.
- 🔴 **Bad:** For Hub plugins the allowlist is keyed by plugin id, and an id is not a
  credential: a ZIP claiming a still-listed id on a host without that plugin inherits the
  row. Closing that needs package provenance; one residual row (`@omadia/channel-teams` →
  `graphPool`) remains.
- 🔴 **Bad:** Alternative backends of one capability (three `embeddingClient@1` adapters,
  two `knowledgeGraph@1` and two `memoryStore@1` providers ship in the image) are mutually
  exclusive; switching means uninstalling one. Several LLM providers coexist only because
  they register through the `llm_provider` manifest block into the LLM provider catalog
  and are picked by provider assignment, not through this registry.
- 🔴 **Bad:** `privacy.redact@1` is registered under the key `privacyRedact`; capability
  name and service key disagree, so that pair cannot be declared and stays allowlisted.
- ⚪ **Neutral:** `has(name)` stays ungated; it reveals only whether a provider exists.

## Pros and Cons of the Options

### A — Declaration gate, single active provider

- 🟢 Fail-closed for everything new, with a bounded ramp for what already shipped.
- 🔴 The ramp is a list to drain, and its Hub half rests on an unauthenticated id.

### B — Open service locator

- 🟢 No manifest work.
- 🔴 Any plugin holds the operator's database pool and raw model clients.

### C — Policing inside the registry

- 🟢 One place.
- 🔴 The kernel resolves its own services through the same registry; a registry that
  polices its callers cannot serve both.

### D — Several active providers per capability

- 🟢 Matches the wording of ADR-0003.
- 🔴 Every consumer would need a selection rule; today's consumers ask for one name and
  expect one object.

## More Information

- Related: [ADR-0003](0003-capability-based-multi-provider-middleware.md),
  [ADR-0014](0014-plugins-are-only-the-delivery-form.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md), [ADR-0050](0050-plugin-database-access-declared-granted-and-kernel-run-migrations.md),
  [ADR-0046](0046-activation-soft-fail-circuit-breaker-and-typed-result.md).
- Paths: `middleware/src/platform/pluginServiceGrants.ts`, `serviceRegistry.ts`,
  `pluginContext.ts`; `middleware/src/plugins/capabilityResolver.ts`;
  `middleware/packages/plugin-api/src/pluginContext.ts` (`ServicesAccessor`).
- Tests: `middleware/test/pluginServiceGrantGate.test.ts`,
  `pluginServiceGrantCoverage.test.ts` (re-runs the provides-only scan with the TypeScript
  checker), `optionalRequires.test.ts`, `capabilityResolver.test.ts`,
  `serviceRegistryDisposal.test.ts`.
