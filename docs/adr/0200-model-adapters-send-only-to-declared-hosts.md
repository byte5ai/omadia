# 0200 — Model adapters send only to declared hosts; a custom endpoint is an allow-list entry

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (Welle 5, W07-08; decision after the recheck recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

The bundled OpenAI adapters (`@omadia/transcription-adapter-openai`,
`@omadia/embedding-adapter-openai`) have a configurable Base URL but declared made-up names
(`openai-transcription`, `openai-compatible-embeddings`) in `permissions.network.outbound`
(#1984). They keep their own HTTP clients (undici, `ws`) as
[ADR-0165](0165-model-gateway-is-an-admission-check-per-adapter.md) allows, and bundled
packages are kernel code the plugin egress guard does not inspect
([ADR-0108](0108-outbound-url-rules-follow-the-trust-class-of-the-source.md)). So the Store
showed a host nobody calls, and any Base URL received raw audio, texts and the API key. How
does an adapter with its own client stay inside its declared network permission while a
custom endpoint (Azure, a local OpenAI-compatible server) keeps working?

## Decision Drivers

- The permission the Store shows must be the hosts the plugin actually calls.
- A custom endpoint is a deliberate operator choice, visible as such.
- No rewrite of the adapters' transports (multipart upload, WebSocket) onto `ctx.http`.

## Considered Options

- **A — Declare the default host plus `$config.allowed_hosts`; the adapter refuses a Base URL
  whose host is not declared.**
- **B — Declare `$config.base_url`, so whatever Base URL is entered is the permission.**
- **C — Move every call onto `ctx.http`.**

## Decision Outcome

Chosen option: **A**.

- A model adapter with a configurable endpoint declares the provider's default host
  (`api.openai.com`) and `"$config.allowed_hosts"` in `permissions.network.outbound`.
- `allowed_hosts` is a setup field (comma-separated hosts or URLs). It is empty by default.
- At activation the adapter checks the host of every endpoint it will call (Base URL, and the
  Realtime URL when that path is enabled) against the default host and `allowed_hosts`. An
  undeclared host publishes no service and reports `ctx.status` `error` ("Endpoint nicht
  freigegeben") naming the host.
- Option B was rejected: the permission would follow the field it is meant to bound, so the
  Store could never show a custom endpoint as an extra grant. Option C was rejected for now:
  `ctx.http` has no multipart streaming or WebSocket path; the host rule closes the gap without
  it.

### Consequences

- 🟢 **Good:** the Store's network permission names the real hosts; a custom endpoint shows as
  `$config.allowed_hosts` and needs a second, explicit field.
- 🟢 **Good:** a Base URL typed into the wrong field cannot send the key elsewhere silently.
- 🔴 **Bad:** an installation that already runs an adapter against a custom endpoint stops
  publishing the service after the update until the operator lists the host in
  `allowed_hosts` (CHANGELOG names the step).
- ⚪ **Neutral:** the per-plugin rate limit and the audience host prohibition of `ctx.http`
  still do not apply to these calls; moving them onto `ctx.http` (option C) stays open.

## More Information

- Issue #1984; code: `transcription-adapter-openai/src/endpointCheck.ts`,
  `embedding-adapter-openai/src/endpointHosts.ts`; test `middleware/test/adapterProbesAndHosts.test.ts`.
- Related: [ADR-0053](0053-service-access-by-declaration-one-provider-per-capability.md),
  [ADR-0087](0087-transcription-capability-one-provider-consent-and-guardrails.md),
  [ADR-0108](0108-outbound-url-rules-follow-the-trust-class-of-the-source.md),
  [ADR-0165](0165-model-gateway-is-an-admission-check-per-adapter.md).
