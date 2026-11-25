# 0051 — Plugin registries are admin-managed runtime config; a failing registry degrades the store and never blocks it

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); robustness rules from #1458, #1482, #1483
- **Supersedes:** — (refines [ADR-0001](0001-plugin-distribution-via-signed-zip.md), whose packaging and trust model are unchanged)

## Context and Problem Statement

[ADR-0001](0001-plugin-distribution-via-signed-zip.md) decided that plugins are ZIP
packages served by a "dumb" registry and that registries can be stacked. It left open how
an instance knows its registries, what happens when two of them list the same plugin id,
and what the store does while a registry is slow or down. In practice the store page
waited for the slowest registry, and a registry that sent headers and then stalled the
body held the request open. This record is written retroactively; the decision is
implemented on main.

Where is the registry list kept, and how does the client behave when registries disagree
or fail?

## Decision Drivers

- An operator adds a private registry without redeploying.
- A registry token is a secret.
- The store must render what is reachable; one registry must not hold it hostage.
- A tampered index must not be able to point the download somewhere else.
- The client adds no second validation path next to the ingest pipeline.

## Considered Options

- **A — Registry list as admin-editable runtime config, seeded once; first registry wins;
  bounded, cached, per-registry failure**
- **B — Registries from an environment variable only**
- **C — Fail the store listing when any registry fails**

## Decision Outcome

Chosen option: **A**.

- **The list is runtime config** (`RegistryConfigStore`,
  `middleware/src/plugins/registryConfigStore.ts`). Name and URL live in the platform
  settings under `registry.list`; bearer tokens live in the vault under the synthetic
  owner `__registries__` and are never returned in a listing (only `has_token`).
- **Seeded once.** On first boot the list comes from `REGISTRY_URLS` if set (`[]` means
  no registry), otherwise it is the public default `omadia-public` →
  `https://hub.omadia.ai`. After that the environment variable is no longer read, and a
  list the admin emptied stays empty.
- **First registry wins.** `RegistryClient.listAll` fetches all registries in parallel
  and merges them; on a plugin-id collision the entry of the earlier registry in the
  configured order is kept and the other is dropped with a warning.
- **A registry failure is data, not an exception.** `listAll` returns `plugins`, `errors`
  and one `sources` status per registry. The index fetch has one deadline for headers and
  body, 5 s by default and capped at 8 s so it stays below the web UI's 10 s server-side
  fetch budget. A good index is reused for 5 minutes, a failure for 1 minute; concurrent
  callers share one in-flight fetch. An index is at most 5 MiB.
- **Downloads are pinned.** An artifact is fetched only from the registry's own host
  (`registry.host_mismatch` otherwise), redirects are refused, the size is capped at
  50 MiB with a 120 s deadline, and the bytes must match the SHA-256 the index lists
  (`registry.sha256_mismatch`). The buffer then goes into the same ingest pipeline as an
  upload ([ADR-0048](0048-one-ingest-pipeline-and-error-contract.md)).
- **Only known kinds are listed.** An index entry whose kind is not in the kernel's
  `PLUGIN_KINDS` is dropped from the listing.

### Consequences

- 🟢 **Good:** Private and public registries mix at runtime, and their tokens are stored
  like every other secret.
- 🟢 **Good:** The store stays usable with a registry down and says which one failed.
- 🔴 **Bad:** The order of the list is a trust decision: a registry listed first can
  shadow a plugin id of a later one. The collision is logged, not shown as a conflict.
- 🔴 **Bad:** Up to 5 minutes of staleness after a publish, and 1 minute after a failure
  was fixed.
- 🔴 **Bad:** Integrity rests on the index: SHA-256 from the registry plus the transport.
  There is no publisher signature, and the host pin compares host and port, not the
  scheme (see the implementation note in ADR-0001).
- 🔴 **Bad:** The registry list needs the settings store; an instance without a database
  runs on an in-memory list.
- ⚪ **Neutral:** `REGISTRY_URLS` is a seed, not configuration; changing it on a running
  instance has no effect.

## Pros and Cons of the Options

### A — Runtime config, first wins, bounded failure

- 🟢 Operable from the admin UI; failure stays local to one registry.
- 🔴 Cache and precedence rules an operator has to know.

### B — Environment variable only

- 🟢 Immutable and reviewable in deployment config.
- 🔴 Every change is a redeploy; tokens sit in the environment.

### C — Fail on any registry failure

- 🟢 Never shows a partial catalog.
- 🔴 The state #1458 removed: one unreachable registry blanks the store.

## More Information

- Related: [ADR-0001](0001-plugin-distribution-via-signed-zip.md) (and its
  "Implementation status" note), [ADR-0054](0054-setup-fields-typed-secrets-in-per-plugin-vault-validated-server-side.md),
  [ADR-0049](0049-plugin-api-semver-snapshot-and-compat-core.md) (`compat.core` of a registry entry).
- Paths: `middleware/src/plugins/registryClient.ts`, `registryConfigStore.ts`,
  `registryCapabilityProviders.ts`; `middleware/src/api/registry-v1.ts`;
  `middleware/src/routes/registryInstall.ts`; `middleware/src/config.ts`
  (`REGISTRY_URLS`); `docs/security-architecture.md` §4.
- Tests: `middleware/test/registryClient.test.ts`, `registryConfig.test.ts`,
  `registryInstallMerge.test.ts`.
- Border: the Hub itself (`byte5ai/omadia-hub`) is a separate repository.
