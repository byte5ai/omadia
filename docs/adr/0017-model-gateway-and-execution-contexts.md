# 0017 — Model gateway, execution contexts and the plugin sandbox

## Status

Accepted — superseded in part by [ADR-0165](0165-model-gateway-is-an-admission-check-per-adapter.md) (gateway form, system-module pools, CLI under a privacy guard)

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** —

## Context and Problem Statement

Plugins can reach models past every kernel control: the global `fetch` is reachable from
plugins (`platform/pluginContext.ts`), `ctx.llm` calls the provider directly, and the
kernel publishes raw model services (`anthropicClient`, `llm`) that a plugin obtains by
declaring them. Some system modules build their own provider pools. The `claude-cli`
provider runs its own model and tool loop. Unattended work (triggers, routines, jobs)
could therefore spend without limit and bypass the privacy shield, model policy and
audit.

How does every model call stay inside a kernel-checked context with a known owner and
limits?

## Decision Drivers

- Every model call has exactly one accountable context (whose budget, whose policy).
- Privacy shield, model policy and kill switch apply to every call, including plugins.
- Semantic search, re-indexing and transcription must keep working under the lock.
- Runaway protection matters more than per-call cost metering.

## Considered Options

- **A — Kernel model gateway; only model plugins hold credentials; network sandbox**
- **B — Convention plus monitoring** (keep direct access, alert on spend)
- **C — Per-plugin API keys with provider-side limits**

## Decision Outcome

Chosen option: **A**.

- **Only model plugins** (kind `model`) hold model credentials and talk to model APIs, and
  only the kernel's **model gateway** calls them. Operations: `complete`, `embed`,
  `transcribe` (batch and realtime), `run_loop`.
- **Execution contexts.** The gateway refuses a call without one:

  | Context | Used for | Charged to and limited by |
  |---|---|---|
  | Agent turn | an agent's turn, its helpers, capability calls it makes, draft previews | the agent's envelope |
  | Execution scope | actions of an archetype plugin's process | the scope's deadline and budget |
  | Inbound processing | e.g. transcribing a voice message before the turn | the addressed agent |
  | Operator job | admin functions an operator starts (builder chats, issue preview, skill verification, topic regrouping, bulk promotion) | operator-tools budget; never posts to team conversations |
  | Maintenance run | index upkeep (e.g. embedding backfill) | maintenance budget; only `embed`, never posts |

- **Raw model clients and provider pools are never granted to plugins.** System modules
  that build their own pools move onto the gateway.
- **Network sandbox.** A non-model plugin's effective network permission is today's
  (manifest targets, operator targets, optional `public-web` with the private-range
  blocklist) **minus all model provider endpoints**. Sandboxing the global `fetch` is a
  prerequisite for shipping archetype plugins
  ([ADR-0015](0015-agent-archetypes-and-archetype-plugins.md)).
- **`run_loop` (claude-cli)** stays, offered only by a model plugin and called only by the
  agent runtime inside an agent turn: built-in CLI tools off, only the kernel's loopback
  MCP server, every tool call through kernel tool dispatch with the agent's grants and
  the privacy shield, prompt masked before spawn, exact tool-set check, isolated profile
  (`HOME`/`CLAUDE_CONFIG_DIR` with only the subscription login) for every CLI spawn.
- **Runaway protection, not cost metering:** a CLI turn keeps its deadline and idle timeout
  and gains the instance-wide kill switch; unattended work is bounded by trigger caps and
  circuit breakers ([ADR-0020](0020-proactive-agents-with-bounded-triggers.md)). No kernel
  model proxy and no per-call budget gate inside the CLI loop.

### Consequences

- 🟢 **Good:** One choke point for policy, privacy shield, usage attribution and kill switch.
- 🟢 **Good:** A plugin bug cannot silently run up model costs or leak unmasked data to a
  provider.
- 🔴 **Bad:** Every model call site in kernel and plugins must be mapped to a context (the
  deliverable is a table of all call sites).
- 🔴 **Bad:** Plugins that call model APIs directly break until moved onto the gateway.
- ⚪ **Neutral:** Part of #2053 and #2088; acceptance criterion 37.

## Pros and Cons of the Options

### A — Gateway plus sandbox

- 🟢 Enforced, auditable, uniform.
- 🔴 Largest change to the plugin runtime.

### B — Convention plus monitoring

- 🟢 No breaking change.
- 🔴 Detects runaway spend after it happened; no privacy guarantee.

### C — Per-plugin keys

- 🟢 Provider-side limits.
- 🔴 Bypasses privacy shield and model policy; credentials spread across plugins.

## More Information

- Spec A §5.10 ("Enforcement boundary", "Model gateway", "Provider-run loops"); PR #2099
  (runaway protection decision).
- Related: [ADR-0014](0014-plugins-are-only-the-delivery-form.md),
  [ADR-0003](0003-capability-based-multi-provider-middleware.md).
