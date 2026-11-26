# 0165 — The model gateway is an admission check in every adapter; the CLI path is refused under a privacy guard

## Status

Accepted — superseded in part by [ADR-0195](0195-cli-path-runs-under-the-privacy-shield.md) (the CLI path is masked instead of refused under a privacy guard)

- **Date:** 2026-11-25
- **Deciders:** Owner (byte5), from the ADR-coverage audit of 2026-11-25
- **Supersedes:** [ADR-0017](0017-model-gateway-and-execution-contexts.md) in part: "only the
  kernel's model gateway calls" model plugins, "system modules that build their own pools move
  onto the gateway", and "prompt masked before spawn" for `run_loop` (claude-cli)

## Context and Problem Statement

ADR-0017 describes the model gateway as one kernel component that every model call passes,
with credentials held only by model plugins. The code built it differently. The gateway is
`admitModelCall()` (`middleware/packages/llm-provider-api/src/modelCallGate.ts`), a check
every wire-format adapter makes before it sends (`anthropicProvider.ts`,
`openaiProvider.ts`, `responsesProvider.ts`, `cliChatAgent.ts`,
`src/platform/claudeCliAdapter.ts`), plus a registry proxy for embedding and transcription
(`src/platform/modelGatewayServices.ts`). The orchestrator, the verifier and
`orchestrator-extras` build their own provider pools from their own vault scope
(`harness-orchestrator/src/plugin.ts`, `harness-verifier/src/plugin.ts`,
`harness-orchestrator-extras/src/plugin.ts`). Plugins never get raw pools
(`pluginServiceGrants.ts`). The subscription CLI path still has no Privacy Shield (#1087),
so "prompt masked before spawn" does not hold.

Which form of the gateway is binding, and what happens to CLI turns while the shield cannot
cover them?

## Decision Drivers

- Policy, kill switch and usage attribution must apply to every model call.
- Moving the three system modules onto one kernel pool risks key-precedence regressions
  (OM-102, `llmProviderResolution.ts`) and provider invalidation paths, for no change in
  what a plugin can reach.
- A turn the shield cannot mask must not reach a model on an instance whose operator
  installed the shield.

## Considered Options

- **A — Admission check per adapter, system modules keep their pools, CLI refused under a
  guard**
- **B — Build the kernel gateway component now** and move the system modules onto it
- **C — Keep ADR-0017 as written** and accept the code drift

## Decision Outcome

Chosen option: **A**.

- The model gateway is the admission check every adapter calls before it sends, plus the
  registry proxy for embeddings and transcription. A new adapter that does not call
  `admitModelCall` is a bug (`modelGatewayCallSites.test.ts` lists the call sites).
- The bundled system modules (orchestrator, verifier, orchestrator-extras) are trusted kernel
  code and may build provider pools from their own vault scope. Plugins still never receive a
  raw model client or pool; they reach models only through `ctx.llm`.
- A plugin's `ctx.llm` call inside a guarded turn is masked through the turn's privacy
  handle and its answer restored (`src/platform/pluginLlmPrivacy.ts`).
- A subscription-CLI turn is refused before the spawn whenever a privacy guard is installed,
  as it already was under `OMADIA_PRIVACY_FORCE_GUARDED`
  (`CliChatAgent.refusedByPolicy`, `CLI_PRIVACY_GUARD_ACTIVE_LOG`). The CLI runs unmasked only
  on an instance without a guard.

### Consequences

- 🟢 **Good:** The record matches the code; the call-site test keeps the check from being
  skipped.
- 🟢 **Good:** No CLI turn leaks unmasked data on an instance that runs the shield.
- 🔴 **Bad:** Credentials live in more than one vault scope; a key rotation must reach each
  system module.
- 🔴 **Bad:** Agents on `claude-cli` stop answering on instances with a privacy guard until
  they get an API-key provider.
- ⚪ **Neutral:** Masking on the CLI path (#1087) and one kernel pool for the system modules
  stay open; either one lands as a new ADR.

## Pros and Cons of the Options

### A — Admission check per adapter

- 🟢 Describes what runs; no migration risk.
- 🔴 No single place to read every model call from.

### B — Kernel gateway component now

- 🟢 One choke point, credentials in one place.
- 🔴 Vault migration and key-precedence rework across three system modules; no gain for the
  plugin boundary, which already holds.

### C — Keep ADR-0017 as written

- 🔴 The binding record and the code disagree; the CLI privacy statement is false.

## More Information

- Related: [ADR-0017](0017-model-gateway-and-execution-contexts.md),
  [ADR-0083](0083-neutral-llm-contract-and-wire-format-adapters.md),
  `docs/security-architecture.md` §6f.
- Implemented in #2237.
