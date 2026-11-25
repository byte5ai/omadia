# 0125 — Conductor action steps: one flat id catalog, run in the operator's trust class

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; spec 005 (#388), `webhook.post` from #437 (#534), its
  failure semantics from #1703, MCP tools as actions (`mcpActionId.ts`,
  `mcpActionInvoker.ts`) (recorded retroactively from the code on main)

## Context and Problem Statement

An `action` step runs something deterministic: a connector tool, an outbound HTTP call, an
MCP tool. A run has no acting end user, and the engine must not learn about each
integration technology. Three questions needed one answer: how an action is named, with
whose authority it runs, and how a failed action reaches the graph's error path. This
record is retroactive.

## Decision Drivers

- The pure engine stays ignorant of plugins, MCP and HTTP.
- A workflow must not be the one caller that skips a security policy other callers obey.
- A failed delivery must be branchable in the graph, not only fatal.
- The designer, the chat builder and the runtime must agree on what is callable.

## Considered Options

- **A — A flat list of string action ids with prefixed namespaces; operator trust class;
  failures reported in the result with a default postcondition**
- **B — A typed step kind per technology** (`mcp`, `http`, `connector`)
- **C — Run actions as the user who triggered the run**

## Decision Outcome

Chosen option: **A**.

- **An action is a string id** in `step.actionId`. The catalog is the union of plugin
  deterministic-action tool names, the built-in `webhook.post`, and
  `mcp:<serverId>:<toolName>` for discovered MCP tools. The server id is a uuid, so the
  first two colons delimit and a tool name may contain `:`.
- **Operator trust class.** A workflow is operator-authored and its routes share the admin
  gate, so a workflow calling a tool is the operator calling it. There is no acting user in
  a run: only MCP servers with `delegation === 'service'` are callable. The check is an
  allowlist; `per_user` and any unknown value fail closed.
- **Same policy as agent dispatch.** The MCP invoker applies the same scan-verdict and
  disabled-server gate as the agent runtime (`mcpDispatchDenial`) and resolves the server per
  call, so disabling a server bites at once.
- **Catalog equals runtime.** The action ids offered to the builder and designer are
  computed with the same enabled-and-service gate as the invoker, so a `per_user` tool is
  reported as missing instead of failing at run time.
- **`webhook.post` is a built-in,** not a plugin: an ad-hoc POST to an operator-supplied
  URL behind the shared SSRF guard (`webhookOutbound.ts`), with at most 20 headers of 4096
  characters and a 256 KB body. It is deliberately not wired to vault secrets; an
  authenticated call belongs in a connector action.
- **A refusal is reported, not thrown.** `webhook.post` returns `{ ok, status }`; a throw
  would end the run before the engine could take an error path. The effect supplies
  `WEBHOOK_POST_DEFAULT_POSTCONDITION` (`ok` must be true), so a non-2xx is `unmet` and
  fires the step's fallback or ends the run `failed`. A guard rejection, an oversized body
  and a transport error still throw. A step's own postcondition replaces the default.
- **Results are plain data in the run context,** like every other step result; `input`
  strings are interpolated per call, keys never.
- **Unknown action ids stay in a builder draft** as placeholders ("connector missing"),
  reported beside validation rather than deleted by it.

### Consequences

- 🟢 **Good:** New integration technologies join the catalog without touching the engine or
  the graph schema.
- 🟢 **Good:** One MCP policy for agents and workflows.
- 🔴 **Bad:** Workflows cannot call per-user MCP servers at all.
- 🔴 **Bad:** An action runs with operator authority regardless of who triggered the run;
  an event or webhook sender indirectly drives operator-level calls the author wired.
- 🔴 **Bad:** Only `webhook.post` has a default postcondition. Another action that reports
  failure inside its result advances unless the author declares a postcondition.
- ⚪ **Neutral:** Action ids are untyped strings; a typo is caught only where known refs are
  supplied to validation.

## Pros and Cons of the Options

### A — Flat ids, operator trust class

- 🟢 Small engine surface; uniform authoring.
- 🔴 No per-technology typing of inputs.

### B — Typed step kinds

- 🟢 Schema-checked inputs per technology.
- 🔴 Every new technology changes the engine, the schema and every authoring surface.

### C — Run as the triggering user

- 🟢 Least privilege per run.
- 🔴 Cron, webhook and event runs have no user; a human step's responder is not the actor
  of later steps.

## More Information

- Code: `middleware/src/conductor/{mcpActionId,mcpActionInvoker,webhookPostAction,webhookOutbound,realStepEffects,builderCapabilities}.ts`,
  `middleware/packages/conductor-core/src/engine.ts` (`defaultPostcondition`).
- Tests: `middleware/test/conductorMcpAction.test.ts`, `conductorWebhookPostAction.test.ts`,
  `conductorWebhookPostStepOutcome.test.ts`, `conductorBuilderCapabilities.test.ts`.
- Related: [ADR-0005](0005-two-phase-confirmation-for-writes.md),
  [ADR-0041](0041-conductor-webhook-hardening.md),
  [ADR-0131](0131-conductor-pure-engine-decides-the-kernel-performs.md). Border: MCP (ADR-0007 to ADR-0009).
