# 0147 — Web search is a plugin capability with one operator-chosen provider; upstream text never enters an error message

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main)
- **Supersedes:** —

## Context and Problem Statement

Agents need current information from the web. omadia is multi-provider (ADR-0003), so a
search feature tied to one model vendor would not be available to every agent. Search APIs
also differ in result shape, quota and error behaviour, and their error bodies are text omadia
did not write. This record is retroactive.
How does an agent search the web, and what do the model and other plugins see?

## Decision Drivers

- The same tool on every model and transport.
- The search backend must be exchangeable without touching agents or other plugins.
- Outbound network access of a plugin is an allowlist (manifest `permissions.network.outbound`).
- Text from an upstream service must not reach the model through an error.
- A missing API key must not stop the middleware from booting.

## Considered Options

- **A — A built-in tool plugin that publishes `webSearch@1` and the `web_search` tool, backed
  by exactly one configured provider behind a `SearchProvider` interface.**
- **B — The model provider's hosted web search tool.**
- **C — Several providers at once with automatic failover.**

## Decision Outcome

Chosen option: **A** (`middleware/packages/harness-plugin-web-search/`).

- **One capability, one tool.** The plugin publishes a `WebSearchService` as `webSearch@1`
  for other plugins and registers `web_search` as a native tool. Both go through the same
  service, so cache and normalisation are shared.
- **One provider per install.** The operator picks `tavily` (default) or `brave` and fills in
  only that provider's key. Providers are thin wrappers behind a factory
  (`providers/registry.ts`); default `topK`, cache and cache-key shape live in the service
  layer, so a provider file can be swapped without touching cache semantics.
- **Network allowlist.** The manifest lists `api.tavily.com` and `api.search.brave.com`; the
  kernel's HTTP accessor enforces exact host names.
- **A plugin-local cache.** TTL plus LRU, bounded by entry count: 600 s and 200 entries by
  default. Not a kernel cache, because no stable kernel cache surface exists; the plugin stays
  portable.
- **Typed errors with the plugin's own words.** Every error extends `WebSearchError`. A message
  names provider id, HTTP status, and an auth, quota or config hint. The upstream body rides
  on `body` (truncated to 500 characters) and a transport exception on `cause`, both for the
  server log only. The tool returns `Error: …` built from those fields plus a log reference.
- **Rate limit is its own class** (`WebSearchQuotaError`), so a caller can decide to fall
  back instead of surfacing an opaque failure.
- **No key, no activation.** The plugin logs and returns a no-op handle; it activates on
  re-install after the secret is set.
- **Old hosts.** The tool-error helpers exist from plugin-api 1.20.0; they are read off the
  namespace at runtime and replaced by a fixed text on older hosts (`toolErrorCompat.ts`).

### Consequences

- 🟢 **Good:** Search behaves the same for every model and is dispatched like any native tool.
- 🟢 **Good:** Other plugins reuse search through the capability without their own keys.
- 🔴 **Bad:** One provider at a time: a quota or outage of that provider is a failed search;
  switching means changing the setup field and key.
- 🔴 **Bad:** The cache is per process and lost on restart; with several instances the same
  query is paid for several times.
- 🔴 **Bad:** `toolErrorCompat.ts` is a copy in each plugin that needs it (web-search,
  diagrams), because plugins must not import kernel code.
- ⚪ **Neutral:** Results can be up to ten minutes old by default.

## Pros and Cons of the Options

### A — Capability plus tool, one provider

- 🟢 Model-independent, swappable, auditable.
- 🔴 An extra API key and vendor per install.

### B — Hosted provider tool

- 🟢 No key, no plugin.
- 🔴 Tied to one model vendor; not a native tool of the kernel, so not offered as `webSearch@1`
  to other plugins.

### C — Multi-provider failover

- 🟢 Resilient to one provider's quota.
- 🔴 Two keys and two result shapes to reconcile per query; not needed so far.

## More Information

- Related: ADR-0003, ADR-0014; `docs/security-architecture.md` §6c (typed web-search and Kroki
  errors keep upstream text off their messages).
- Tests: `middleware/test/webSearchPlugin.test.ts`, `middleware/test/webSearchToolErrors.test.ts`.
