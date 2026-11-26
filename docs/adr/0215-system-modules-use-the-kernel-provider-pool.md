# 0215 — System modules use the kernel provider pool; provider API keys live in one vault scope

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (#2240; decision after recommendation, reversible)
- **Supersedes:** [ADR-0165](0165-model-gateway-is-an-admission-check-per-adapter.md) in part:
  "the bundled system modules (orchestrator, verifier, orchestrator-extras) … may build
  provider pools from their own vault scope" and its consequence "credentials live in more
  than one vault scope; a key rotation must reach each system module"

## Context and Problem Statement

ADR-0165 recorded that the orchestrator, the verifier and `orchestrator-extras` each build
providers from their own vault scope. The LLM access page therefore wrote every provider
API key into three scopes (`settingsCatalog.ts`), the verifier read only its own copy,
and extras read its own copy before the kernel pool. A key written by another path (the
per-plugin secret editor, the environment seed, the `/setup` endpoint) could leave the
three copies apart, and a rotation had to reach every copy. The kernel already runs one
provider pool (`llmProviderPool@1`, `src/index.ts`) that the orchestrator prefers. Should
the three system modules read provider credentials from that pool only, and where do the
keys live?

## Decision Drivers

- One rotation under LLM access must reach every system module.
- The OM-102 precedence must hold: an install that pays for an Anthropic key is not moved
  onto the operator's subscription quota by the orchestrator's assignment
  (`llmProviderResolution.ts`).
- Provider invalidation on a key change must keep working (`createProviderPoolCredentialListener`).
- No secret may be lost or logged by a migration.
- Plugins still never receive a raw pool (ADR-0165, `pluginServiceGrants.ts`).

## Considered Options

- **A — Kernel pool only, keys in the existing kernel scope (`@omadia/orchestrator`),
  boot-time consolidation of the module copies**
- **B — A new dedicated scope (for example `kernel:llm-providers`)** and a migration of
  every reader and writer
- **C — Keep three scopes** and only make every writer fan out reliably

## Decision Outcome

Chosen option: **A**.

- **One scope.** Provider API keys (`provider:<id>/api_key`, legacy `anthropic_api_key`)
  live in `KERNEL_PROVIDER_CREDENTIAL_SCOPE` (`src/platform/kernelProviderCredentials.ts`),
  whose id stays `@omadia/orchestrator`: provider readiness, model discovery, the shared
  Anthropic client, the mirrored keys of the canvas and fast-path plugins and the token
  store already read it. The LLM access page writes only there.
- **One pool.** The orchestrator, the verifier and `orchestrator-extras` build their
  providers from the kernel pool (`llmProviderPool@1`, declared in `optional_requires`).
  Their own vault scope is used only on a host that publishes no pool (legacy hosts, unit
  tests). The verifier refuses `claude-cli` before asking the pool (#1583).
- **Rotation reaches all modules.** A key change through LLM access rebuilds every
  installed LLM plugin in `rebuildOrder` (the capturing orchestrator last); the vault write
  listener invalidates the pool entry before that.
- **OM-102 precedence kept.** "This plugin holds an Anthropic key" now reads "the kernel
  scope holds one" (`kernelPool.usable('anthropic')`); the candidate chain is unchanged.
- **Migration.** `consolidateProviderCredentials` runs on every boot after the legacy
  bootstrap and before any plugin activates. Per provider key name in the verifier's or
  extras' scope: dropped when equal to the kernel's key for that provider; otherwise renamed
  to `superseded:<key>` (a `#<n>` suffix when that name is taken; kept in the vault, no
  longer read). A canonical copy and a legacy `anthropic_api_key` are judged separately, so
  a differing legacy value is kept. Logs carry scope and key name only. A second run changes
  nothing.
- **No promotion (decision after recommendation, reversible).** A key that only a module
  scope held is NOT copied into the kernel scope when the kernel has none for that
  provider: that would silently widen which providers the whole instance (every agent,
  the pool behind `ctx.llm`) can reach, outside the operator's view of LLM access and the
  ADR-0084 posture shown there. It is renamed aside like a differing key, and the boot log
  asks the operator to enter it under LLM access.
- **No silent writes.** A provider API key sent to the verifier's or extras' scope through
  the per-plugin editor is refused with `400 runtime.provider_key_in_kernel_scope`; their
  manifests no longer declare an `anthropic_api_key` field. A revoke under LLM access also
  deletes copies left in those scopes and their `superseded:` copies; a provider plugin's
  uninstall purge removes its `superseded:` copies too.

### Consequences

- 🟢 **Good:** One place for provider keys; a rotation reaches the agent runtime, the
  verifier and the background jobs in one save.
- 🟢 **Good:** The verifier gets the provider catalog, so plugin-contributed providers and
  OAuth-connected providers resolve for it as they do for the agent runtime.
- 🔴 **Bad:** A dedicated Anthropic key for the background jobs (the old extras field) is
  no longer possible. An install that had one keeps it as `superseded:<key>` in extras'
  scope and from now on runs extras on the key under LLM access; the boot log warns.
- 🔴 **Bad:** An install whose verifier or extras held a provider key that LLM access does
  not hold loses that provider for those modules until the operator enters the key under
  LLM access (the boot log says so).
- 🔴 **Bad:** The verifier now shares the pool's retry budget (5) instead of the SDK
  default.
- ⚪ **Neutral:** The OAuth fan-out (`fanOutProviderOAuthTokens`) and the back-compat
  `/setup` key seed still write copies into the module scopes; they are harmless (never
  read by the modules) and the API-key copies are consolidated on the next boot. Narrowing
  both to the kernel scope is follow-up work.
- ⚪ **Neutral:** The scope id `@omadia/orchestrator` now names a kernel scope, not only
  the orchestrator plugin's.

## Pros and Cons of the Options

### A — Kernel pool only, existing scope, consolidation

- 🟢 Small migration; every existing reader of the scope keeps working.
- 🔴 The scope name keeps the plugin id.

### B — New dedicated scope

- 🟢 A clean name.
- 🔴 Every credential of every install moves; every reader and writer changes at once —
  the key-precedence regression risk ADR-0165 named.

### C — Keep three scopes, fan out reliably

- 🟢 No migration.
- 🔴 Every writer has to know the fan-out; copies still drift through other paths.

## More Information

- Related: [ADR-0017](0017-model-gateway-and-execution-contexts.md),
  [ADR-0054](0054-setup-fields-typed-secrets-in-per-plugin-vault-validated-server-side.md),
  [ADR-0081](0081-model-policy-fallback-and-provider-circuit-breaker.md),
  [ADR-0084](0084-provider-credentials-and-compliance-posture.md),
  [ADR-0112](0112-secret-vault-and-credential-keychain-two-master-keys.md),
  `docs/security-architecture.md` §1.
- Code: `middleware/src/platform/kernelProviderCredentials.ts`, `settingsCatalog.ts`,
  `routes/adminSettings.ts`, `routes/runtime.ts`,
  `middleware/packages/harness-{verifier,orchestrator-extras}/src/plugin.ts`.
- Tests: `middleware/test/kernelProviderCredentials.test.ts`, `adminSettingsRoute.test.ts`,
  `orchestratorExtrasActivate.test.ts`, `verifierModelResolution.test.ts`,
  `runtimeConfigProviderDependents.test.ts`.
