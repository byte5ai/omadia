# 0086 — A subscription login is a provider: host capability instead of a vault secret, two shapes, one spawn gate, billed at zero

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; #309 Claude CLI, #294 ChatGPT login, #1007 and #1014 spawn gate, OM-103 ledger rows, OM-104 turn budget)
- **Supersedes:** —

## Context and Problem Statement

A single operator who self-hosts often has a Claude Pro or Max plan and no metered API
key. The official `claude` CLI can run on that plan. [ADR-0017](0017-model-gateway-and-execution-contexts.md)
fixes how a CLI-owned loop (`run_loop`) is confined inside an agent turn. It does not say
how a subscription becomes a provider at all: where the login lives, which calls may use
it, how the binary gets onto the host, and what the usage ledger records for a call
nobody is billed for. This record is retroactive.

## Decision Drivers

- No API key in the vault; the login belongs to the host.
- Prompts are built from end-user chat text and uploaded documents, so the spawned
  process must not be able to read host files or run commands.
- A proprietary vendor CLI must not be redistributed without a legal review.
- A flat fee is not a price per call; the ledger must not invent money.

## Considered Options

- **A — The CLI as a provider in two shapes (single completion, CLI-owned loop), login as host capability, one shared spawn gate**
- **B — Extract the subscription token and call the vendor HTTP API directly**
- **C — No subscription path; a metered API key is required**

## Decision Outcome

Chosen option: **A**.

- **Two shapes.** *Completion* (`src/platform/claudeCliAdapter.ts`, wire format
  `claude-cli`): one `claude -p --output-format json` per call, prompt on stdin, no
  tools, no streaming, no prompt caching; used for summaries, extraction, classifiers and
  the verifier. A forced single tool is emulated through a JSON schema in the prompt.
  *Loop* (`harness-orchestrator/src/cliChatAgent.ts`): the CLI owns the agent loop and
  reaches omadia's tools only through the loopback MCP server.
- **Login is host capability.** `cliBackendDetector.ts` probes with `--version` and a
  read-only auth command, never triggers a login and reports `loggedIn` as `yes`, `no` or
  `unknown`. `cliAuthService.ts` drives `claude auth login --claudeai` from the web UI,
  with the code on stdin and one active login at a time. Only the Claude CLI counts as
  subscription billing; Codex and Gemini are detected and shown as "needs verification".
- **One definition of the spawn gate** (`cliSpawnGate.ts`), used by both shapes: built-in
  tools off (`--tools ""` plus `--disallowedTools`), `--permission-mode dontAsk`,
  `--setting-sources ""`, `--strict-mcp-config`, `--restricted` only where the resolved
  CLI version has it, an empty working directory, and an environment built from an
  allowlist (`CLI_ENV_ALLOWLIST_KEYS`), not from a deny list. API-key variables never
  reach the child, so the call cannot fall onto metered billing.
- **The gate is proven by behaviour, not by argv.** `cliGateLiveProbe.test.ts` runs the
  real binary with the production arguments (opt-in, `OMADIA_CLI_LIVE_PROBE=1`); a drift
  guard reads the CLI's own tool inventory.
- **One place answers "which binary".** `resolveClaudeCliBin()` (`cliBinary.ts`): the
  runtime install directory first, then `PATH`, asked per spawn.
- **Distribution.** The public image does not contain the CLI
  (`INSTALL_SUBSCRIPTION_CLIS=false` in the `Dockerfile`); when it is built in, the
  version is pinned (`CLAUDE_CODE_VERSION=2.1.312`, #1581). `cliInstallService.ts`
  installs from the public npm registry on the operator's request into `CLI_TOOLS_DIR`.
  The login lives on the data volume (`CLAUDE_CONFIG_DIR=/data/claude-cli`).
- **Ledger.** Subscription calls write their own `token_usage` rows with `cost_usd = 0`
  and the vendor's figure in `reference_cost_usd`; `claude-cli` is in
  `SELF_RECORDING_PROVIDER_IDS` so no layer above records it twice.
- **Turn budget.** A CLI-owned turn has a wall-clock budget of 600 s and an idle timeout
  of 60 s. Precedence: operator setting `cli_turn_seconds`, then
  `OMADIA_CLI_SPAWN_TIMEOUT_MS`, then the default.
- **Tool parity.** A kernel tool exists for the CLI only if it has a spec and a handler in
  the tool dispatch service; `memory` and `get_chat_participants` stay marker-only on
  purpose (#1102).
- **ChatGPT subscription** (`openai-chatgpt`, wire format `openai-responses`, device-code
  login) is experimental and off unless `CHATGPT_SUBSCRIPTION_EXPERIMENTAL` is set.

### Consequences

- 🟢 **Good:** An install runs without any API key, on the vendor's own client.
- 🟢 **Good:** A new spawn site cannot forget half the gate.
- 🔴 **Bad:** A consumer plan has no data-processing agreement; the UI warns
  (`subscriptionNotice`), the risk stays with the operator.
- 🔴 **Bad:** Every CLI release can change flags, the login prompt or the tool list. An
  unknown flag made every turn fail on an older CLI (OM-85); the pin applies only to the
  bundled build, a runtime install can be any version.
- 🔴 **Bad:** No streaming, vision or prompt caching on the completion shape; a spawn per
  call.
- 🔴 **Bad:** On macOS the login sits in the keychain, so profile isolation in mode `auto`
  stays inherited until the operator signs in again (`cliProfile.ts`).
- ⚪ **Neutral:** The ChatGPT login is a grey area of the vendor's terms and is marked so
  in `oauthDeviceFlow.ts`.

## Pros and Cons of the Options

### A — CLI as provider, host login, one gate

- 🟢 Uses the vendor's supported client; no secret in the vault.
- 🔴 A process boundary with a moving CLI behind it.

### B — Token extraction and direct HTTP

- 🟢 Streaming and tools as on the API.
- 🔴 Uses the subscription outside the vendor's client; breaks when the token format
  changes.

### C — API key only

- 🟢 One path, full features.
- 🔴 Excludes operators without a metered account.

## More Information

- Related: [ADR-0017](0017-model-gateway-and-execution-contexts.md) (run_loop rules,
  isolated profile), [ADR-0084](0084-provider-credentials-and-compliance-posture.md),
  [ADR-0088](0088-usage-ledger-in-usd-with-read-time-price-resolution.md).
- Paths: `middleware/src/platform/{claudeCliAdapter,cliBinary,cliBackendDetector,cliAuthService,cliInstallService}.ts`,
  `middleware/packages/harness-orchestrator/src/{cliChatAgent,cliSpawnGate,cliProfile}.ts`, `Dockerfile`.
- Tests: `middleware/test/cliBridge/*` (`cliSpawnGate`, `cliEnvScrub`, `cliGateLiveProbe`,
  `cliToolInventory`, `kernelNativeParity`, `cliRunLoopIsolation`),
  `middleware/test/subscriptionParity/*` (`usageSubscription`, `cliTurnBudget`, `lastTurnOutcome`),
  `middleware/test/claudeCliAdapterCompletion.test.ts`.
