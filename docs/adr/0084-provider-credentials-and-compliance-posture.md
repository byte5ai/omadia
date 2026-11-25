# 0084 — Provider credentials are namespaced per provider; the data-protection posture is declared by the provider and defaults to the cautious reading

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; OAuth login from #294, disclosure default after field test OM-10)
- **Supersedes:** —

## Context and Problem Statement

The vault held one flat key, `anthropic_api_key`. Several providers in one vault scope
need distinct keys, some providers have no key at all (a local server, a subscription
login), and one connects through an OAuth login whose refresh token rotates. The operator
UI also has to say what sending prompts to a provider means under data-protection law,
without a hard-coded list of provider ids. How are provider credentials stored and read,
and where does the compliance statement come from? This record is retroactive.

## Decision Drivers

- An existing install must never lose its key through the change of scheme.
- Several providers coexist in one vault scope.
- A rotated refresh token that is used again ends the grant for good.
- A provider nobody described must not look harmless in the UI.

## Considered Options

- **A — `provider:<id>/api_key` with a read fallback to the legacy key; posture as descriptor data with cautious defaults**
- **B — Destructive migration to the new key names; posture as a table in the UI**
- **C — Keep one flat key per vendor name (`openai_api_key`, …)**

## Decision Outcome

Chosen option: **A**.

- **Key scheme.** A provider's API key lives under `provider:<id>/api_key`
  (`providerApiKeyVaultKey`). `readProviderApiKey` reads that key first and falls back to
  `anthropic_api_key`; only Anthropic ever had a legacy key. The bootstrap migration
  copies legacy to canonical and does not delete the legacy key, and the environment seed
  writes the canonical key. Three mechanisms lead to the same value on purpose.
- **No credential means no provider.** `resolveLlmProvider` returns `undefined` when a
  provider that needs a key has none, and the caller does not publish its capability.
  The provider pool memoises that negative result until `invalidate` is called after a
  key was added or rotated.
- **Keyless providers declare it.** `policy.requiresApiKey: false` (a local server,
  `claude-cli`, `openai-chatgpt`) makes the factory build the provider without a key.
- **OAuth tokens have one canonical copy per process.** `providerOAuthTokenStore.ts`
  holds one in-memory copy per provider id and runs at most one refresh at a time.
  Rotated tokens are written to all vault scopes that hold a copy, with an
  `oauth_updated_at` stamp, before the refresh resolves. On restart the newest copy
  wins. A terminal refresh failure parks the provider in `reconnect_required`; it is not
  retried, the operator signs in again. Adapters must take the bearer from
  `bearerProvider` per request and never capture it at build time.
- **Posture is descriptor data** (`ProviderPolicy`): `requiresAvvDisclosure` (default
  true), `euHosted` (default false), `subscriptionNotice` (default false). A provider
  without a policy is shown as a third-party processor outside the EU, with the
  Art. 28 GDPR disclosure. Anthropic, the default provider, carries the disclosure too;
  the earlier exemption was removed. A consumer subscription sets `subscriptionNotice`,
  which the UI shows as a stronger warning: no data-processing agreement exists on such
  a plan.

### Consequences

- 🟢 **Good:** The scheme change cannot break the Anthropic default path; a missed
  migration is covered by the fallback.
- 🟢 **Good:** A new provider plugin gets the disclosure without a UI change.
- 🔴 **Bad:** The legacy key stays in the vault and in the manifests of the orchestrator,
  verifier and orchestrator-extras (`anthropic_api_key` setup fields). The fallback has no
  end date.
- 🔴 **Bad:** Provider keys and OAuth tokens are held per plugin vault scope, so the same
  secret exists in several scopes and a rotation has to reach all of them. This is also
  where the code differs from [ADR-0017](0017-model-gateway-and-execution-contexts.md)
  ("only model plugins hold model credentials").
- 🔴 **Bad:** The OAuth store is per process. Two processes that share a vault can both
  refresh; the newest-copy rule repairs a crash between writes, it does not coordinate
  two live processes.
- ⚪ **Neutral:** The policy flags are hints for the operator UI. They do not change what
  the provider is sent.

## Pros and Cons of the Options

### A — Namespaced key with fallback, posture in the descriptor

- 🟢 Non-destructive; data-driven UI; cautious default.
- 🔴 Two key names for Anthropic indefinitely.

### B — Destructive migration, UI table

- 🟢 One key name, no fallback code.
- 🔴 A failed migration leaves an install without a model; every new provider needs a UI
  change.

### C — Flat vendor keys

- 🟢 No migration.
- 🔴 A key name per vendor in code; plugin-contributed providers have nowhere to put
  theirs.

## More Information

- Related: [ADR-0003](0003-capability-based-multi-provider-middleware.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md),
  [ADR-0083](0083-neutral-llm-contract-and-wire-format-adapters.md), [ADR-0086](0086-subscription-logins-as-providers.md).
- Paths: `middleware/packages/llm-provider/src/{providerCredentials,providerOAuthTokenStore,oauthDeviceFlow,providerPool,providerFactory}.ts`,
  `middleware/packages/llm-provider-api/src/descriptor.ts` (`ProviderPolicy`),
  `middleware/src/platform/builtinLlmProviders.ts`.
- Tests: `middleware/test/llmProviderCredentials.test.ts`, `llmProviderOAuthTokenStore.test.ts`,
  `llmProviderOAuthDeviceFlow.test.ts`, `llmProviderPool.test.ts`.
