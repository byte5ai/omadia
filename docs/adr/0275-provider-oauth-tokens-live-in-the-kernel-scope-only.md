# 0275 — Provider OAuth tokens live in the kernel scope only; older module copies are folded in newest-wins

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 6, W34; #2313; decision after recommendation, reversible)
- **Supersedes:** —  (completes the follow-up named in [ADR-0215](0215-system-modules-use-the-kernel-provider-pool.md), "Neutral" consequence)

## Context and Problem Statement

ADR-0215 moved provider API keys into one vault scope (`KERNEL_PROVIDER_CREDENTIAL_SCOPE`,
id `@omadia/orchestrator`) and consolidates the module copies on boot. Two writers were left
writing into the verifier's and `orchestrator-extras`' scopes: the OAuth device-flow fan-out
(`fanOutProviderOAuthTokens`) together with the token store's `persist`, and the back-compat
`/setup` key seed. Nothing reads those copies for the modules any more, but every refresh
wrote rotated refresh tokens into three places, and the token store hydrated newest-wins
across all three. Where do OAuth tokens live, and what happens to the copies already stored?

## Decision Drivers

- One credential, one scope (ADR-0215).
- Refresh-token rotation: only the newest refresh token is valid; dropping it logs the
  operator out of the subscription provider.
- No secret may be lost or logged by a migration (ADR-0215).
- ADR-0215's "no promotion" rule: a key the operator never entered under LLM access must
  not silently become instance-wide.

## Considered Options

- **A — Write the kernel scope only; on boot fold a newer module copy into the kernel scope,
  then delete the module copies**
- **B — Write the kernel scope only; rename module copies aside (`superseded:`) like API keys**
- **C — Keep the fan-out (status quo)**

## Decision Outcome

Chosen option: **A**.

- The device flow (`POST /api/v1/admin/providers/oauth/poll`) and the token store's
  `persist` write OAuth tokens into the kernel scope only; `load` reads only that scope.
- `consolidateProviderCredentials` also handles OAuth: for each provider with an access
  token in a module scope, the module copy replaces the kernel's when its
  `oauth_updated_at` stamp is newer (or the kernel holds none), then the module's OAuth keys
  are deleted. This is the boot-time form of the newest-wins hydration the token store
  already did, not a promotion: an OAuth login only ever came from the LLM access page,
  which wrote the kernel scope too, and a provider purge clears every scope. The log names
  scope and provider only.
- The `/setup` key seed writes the Anthropic key (and its verification record) once into
  the kernel scope and reactivates the consumers in `rebuildOrder` (orchestrator last).

### Consequences

- 🟢 **Good:** a rotated refresh token exists in exactly one place; no module scope gains
  credentials again.
- 🟢 **Good:** an install that crashed mid-fan-out keeps its newest login.
- 🔴 **Bad:** a module copy whose stamp is newer but whose token is broken would win once;
  the same was true of hydration before, and a re-connect fixes it.
- ⚪ **Neutral:** the readiness check that looks for an OAuth login in every LLM scope still
  reads the module scopes; after the boot consolidation they hold none.

## Pros and Cons of the Options

### A — kernel only, fold newest in

- 🟢 Matches what hydration did; no login lost.
- 🔴 A second consolidation rule next to the API-key one.

### B — rename aside

- 🟢 Same rule as API keys.
- 🔴 A rotated refresh token renamed aside is a lost login.

### C — status quo

- 🟢 No change.
- 🔴 Three copies of a rotating secret; contradicts ADR-0215.

## More Information

`middleware/src/platform/kernelProviderCredentials.ts`, `middleware/src/routes/adminProviders.ts`,
`middleware/src/routes/authSetup.ts`, `middleware/src/index.ts` (token store binding).
