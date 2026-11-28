# 0055 — An agent's computer is a Docker container per scope, off by default, with wired limits and a command floor

## Status

Accepted — superseded in part by [ADR-0361](0361-sandbox-registry-is-wired-and-the-idle-sweep-is-an-operator-action.md) (the registry is wired; the idle sweep is an operator action)

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; issue #576, implemented in #776 (contract and Docker
  backend), #777 (`execute` tool and command policy gate), #779 (registry, content hash,
  reaper); limits hardened in #1256 and #1286. Recorded retroactively.
- **Supersedes:** —

## Context and Problem Statement

Some tasks need a shell: run a script, transform a file, install a tool and use it again in the
next turn. The middleware process must never run a model-written command itself. The "plugin
sandbox" of [ADR-0017](0017-model-gateway-and-execution-contexts.md) is a network policy for
plugin code in the kernel process; it is not a place to execute commands.

This record is retroactive. Where do agent-issued commands run, and what bounds them?

## Decision Drivers

- A declared restriction must be an applied restriction ("wired, not declared").
- Fail closed: no flag, no policy, no limit must ever mean "allowed" or "unlimited".
- Work must survive between tool calls of the same conversation.
- Other backends (remote machines, microVMs) must fit later without touching the tool.

## Considered Options

- **A — A narrow `Sandbox` contract, a local-Docker backend with one container per scope,
  an `execute` tool that is off by default and checks an org command floor itself**
- **B — Run commands in the middleware container** with a deny list
- **C — A hosted code-execution service of a model provider**
- **D — A fresh container per command**

## Decision Outcome

Chosen option: **A** (`middleware/packages/harness-sandbox`, `@omadia/sandbox`).

- **Contract.** `Sandbox`: `run`, `read`, `write`, `list`, `teardown`; `SandboxBackend.provision
  ({ scopeKey, profile })` is idempotent per scope. Optional abilities (process sessions,
  backup, blob staging) are discovered by type guards on the sandbox instance, never assumed
  from the profile; the Docker backend offers none of them.
- **Profile, default closed.** `AgentComputerProfile`: `persistent: false`, `egress: false`,
  `processSessions: false`, `maxRunSeconds: 60`, `maxOutputBytes: 1 MiB`. `egress: false`
  becomes `docker run --network none`.
- **One container per scope.** The container name is `omadia-sbx-<sha256(scopeKey)[0:24]>`, so
  the backend re-attaches after a restart without a database; image `alpine:3.20`, work
  directory `/workspace`. The scope key is the turn's session scope; an unscoped turn gets a
  key unique to the turn, never a shared bucket.
- **Resource ceilings on every container** (`resourceLimits.ts`): memory 512 MiB (also the
  swap ceiling), 1 CPU, 256 processes; order per field: orchestrator setup field
  (`sandbox_memory_mb`, `sandbox_cpus`, `sandbox_pids_limit`) > `OMADIA_SANDBOX_*` > default.
  There is no "unlimited": a value outside the range in which Docker applies a real limit
  falls back to the next source. An existing container gets the current limits by
  `docker update`; `docker inspect` must show every limit in force or `provision()` throws.
- **Paths are clamped** (`pathGuard.ts`): absolute paths, NUL bytes and escapes are rejected,
  not re-rooted.
- **The `execute` tool is opt-in** (`sandbox_execute_enabled` on the orchestrator plugin,
  default off). Before it touches a sandbox it applies `defaultCommandPolicy()`, the org floor
  (recursive `rm`, force-push, destructive SQL, fork bombs, pipe-to-shell), in addition to the
  dispatch-time `guardToolCommands`. A policy that cannot be resolved, `require_approval` and a
  command that cannot be fully normalised are refusals. `timeoutSeconds` is clamped down to the
  profile, never up.
- **Proof in two tiers.** Stub tests assert the exact `docker` argv and the refusals; behind
  `SANDBOX_DOCKER_TEST=1` real containers prove blocked egress and enforced limits.

### Consequences

- 🟢 **Good:** A model-written command never runs in the kernel process, has no network by
  default and cannot exhaust the host.
- 🟢 **Good:** Installed tools and files persist per conversation scope without any state in
  the kernel.
- 🔴 **Bad:** Needs a `docker` CLI and a daemon the middleware process can drive
  (`dockerExec.ts` spawns `docker`). A deployment without one cannot enable the tool, and
  access to a Docker daemon is host-level power the operator hands to the middleware.
- 🔴 **Bad:** The durable registry (`PostgresSandboxRegistry`) and the idle reaper
  (`reapOrphanedSandboxes`) exist and are tested, but `harness-orchestrator/src/plugin.ts`
  passes no registry and schedules no reaper: containers of finished scopes stay until
  someone removes them.
- 🔴 **Bad:** `require_approval` has no approval flow yet; such commands are simply refused.
- ⚪ **Neutral:** A container isolates by kernel namespaces, not by a VM; the contract leaves
  room for a stronger backend.
- ⚪ **Neutral:** `execute` declares no `writeCapabilities`; its effects are untyped and are
  not deduplicated on replay.

## Pros and Cons of the Options

### A — Contract, Docker backend, opt-in tool with floor

- 🟢 Enforced, testable, replaceable backend.
- 🔴 Docker dependency; operations (reaping) still open.

### B — In the middleware container

- 🟢 No extra runtime.
- 🔴 One missed pattern in a deny list reaches the vault and the database.

### C — Provider-hosted execution

- 🟢 No infrastructure.
- 🔴 Binds the feature to one provider; data leaves the instance outside the privacy shield.

### D — Container per command

- 🟢 Nothing to reap.
- 🔴 No installed tools or files between calls; a start per command.

## More Information

- Related: [ADR-0016](0016-least-privilege-and-the-agent-envelope.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md) (its "plugin sandbox" is the
  in-process egress policy, not this); [ADR-0067](0067-published-apps-are-immutable-versions-behind-their-own-origin.md).
  Border: orchestrator / tools (the command policy in `@omadia/channel-sdk`).
- Paths: `middleware/packages/harness-sandbox/src/`,
  `middleware/packages/harness-orchestrator/src/tools/executeTool.ts`,
  `middleware/packages/harness-orchestrator/src/sandboxLimitsConfig.ts`,
  `middleware/packages/harness-orchestrator/src/plugin.ts` (registration).
- Tests: `middleware/test/sandbox/{dockerSandbox,dockerSandboxLimits,dockerSandboxRegistry,resourceLimits,sandboxLimitsConfig,pathGuard,agentComputerProfile,executeTool,reaper,contentHash}.test.ts`,
  `middleware/test/sandbox/postgresSandboxRegistry.pg.test.ts`.
