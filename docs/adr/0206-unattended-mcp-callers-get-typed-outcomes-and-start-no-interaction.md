# 0206 — Unattended MCP callers get typed outcomes and start no interaction

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (Welle 5, W09-10; decided after the recheck recommendation, reversible)
- **Supersedes:** — (extends [ADR-0138](0138-mcp-input-required-ends-the-call-and-is-replayed.md) and
  [ADR-0017](0017-model-gateway-and-execution-contexts.md))

## Context and Problem Statement

`McpManager.callTool` returns one string for every outcome. Failures start with `Error:`,
but so may a real result, and the two messages that ask a human for something — the
OAuth connect prompt and the `[mcp_input_required:…]` sentinel — do not. Callers that have
no human therefore read the text and get it wrong: a Conductor step passed the connect
prompt or the sentinel on as its successful result, started a fresh OAuth flow per run
and parked an input request nobody would ever claim (#1909); the Control Center test call
reported a delivered `Error: no match found` as a failure (#1944). Next to that, a
`per_user` server with no caller identity still received the call, and a real tool error
was then explained as "Nothing was sent to the server" (#1906); routines always ran
without an identity, so `per_user` servers never worked for them (#1907); and the call
audit named the orchestrator for sub-agent calls, nobody for API-key calls, and a
placeholder as turn id for the web chat's outer scope (#1921).

How does a caller without a human learn what an MCP call did, and what may such a call
start?

## Decision Drivers

- No caller may decide success by reading tool text.
- A run nobody watches must not start an OAuth flow, store an authorize URL, or park an
  input request.
- What the model and the operator are told has to match what reached the server.
- `callTool(): Promise<string>` is used by plugins (`ctx.mcp`) and adapters; it must keep
  working unchanged.

## Considered Options

- **A — A typed `callToolResult` next to `callTool`, plus an unattended call mode**
- **B — Change `callTool` to return a result object**
- **C — Keep strings, add more prefixes to classify**

## Decision Outcome

Chosen option: **A**.

- **Typed outcome.** `McpManager.callToolResult(cfg, tool, args, replay?, opts?)` returns
  `{ text, status }` with `status` one of `ok`, `tool_error`, `failed`, `auth_required`,
  `input_required`, `blocked`, `outcome_unknown` (ADR-0205). `callTool` returns its `text`.
  Callers that act on the outcome — the Conductor MCP action invoker and the Control Center
  test call — read `status` and never the text. A delivered result is `ok` whatever its
  text says.
- **Unattended mode.** `opts.unattended`, defaulting to `turnContext.mcpUnattended`, marks
  a caller with no human: Conductor action steps pass it, routine runs, trigger firings and
  trigger data actions set it on a fresh turn scope. Every scope that is rebuilt rather than
  spread carries it like `mcpUserKey` (orchestrator turn and stream scopes, plugin
  `ctx.mcp`, skill-bound MCP tools, consultations). In that mode an auth failure never reaches `onAuthFailure` (which begins
  an OAuth flow) and returns a plain `auth_required` refusal; an `input_required` answer is
  not parked and returns an `input_required` refusal. A Conductor step fails on every
  status but `ok`.
- **Blocked before sending.** The auth provider may answer `blockedReason(cfg)` before
  anything is resolved or dialled. The runtime provider and the Builder router's provider
  do so for a `per_user` server **that is OAuth-protected** (`McpOAuthService.isProtected`)
  and has no caller identity; the manager then sends nothing and returns `blocked`.
  Delegation decides whose OAuth token a call carries. A server without OAuth (stdio, open,
  static vault headers) holds no per-user credential to withhold, and blocking it would
  break every identity-less caller (trigger firings, API keys) of the many servers created
  with the `per_user` default. That is a deliberate deviation from #1906's expectation and
  reversible. A failure the server answered (an `isError` result, a JSON-RPC error) is no
  longer turned into an auth prompt only because the call had no token.
- **Routine identity.** A routine records the creating turn's `mcpUserKey` (the
  authenticated session's OAuth key, or the channel identity's IdP subject — never a
  client header) in `routines.mcp_user_key` (routines migration 0007) and runs as it. A
  routine without one keeps failing closed on `per_user` OAuth servers, with a message that
  no longer tells a signed-in owner to sign in. The owner deletes it and creates it again
  from a signed-in chat (a repeat create returns the existing routine).
- **MCP tools as data actions.** A read tool its server declares `readOnlyHint` is now one
  of the agent's own read tools for `deliver_data` (#547). Its rows are the call's
  `structuredContent`, captured for that one call. The identity concern that kept MCP tools
  out of data actions is answered at the call: the fast-path invoker needs an attributable
  caller, and an identity-less or unattended call is refused as above.
- **Audit caller.** `auditCaller` derives the audit row's caller in this order: an explicit
  skill/plugin override, the sub-agent named by `LocalSubAgent` (`mcpSubAgentName`), an
  API-key dispatch (`ToolDispatchCallerContext.principalKind = 'api_key'`, set by the public
  MCP endpoint), the orchestrator turn, the dispatching Agent. A turn id an entry point
  marks `turnIdIsPlaceholder` is recorded as no turn.

### Consequences

- 🟢 **Good:** A workflow step fails visibly when the server wants authorization or input,
  and no run leaves an authorize URL or an orphaned input request behind.
- 🟢 **Good:** Routines can use `per_user` servers as their owner; the audit shows the owner.
- 🟢 **Good:** "Nothing was sent to the server" is now true when it is said.
- 🔴 **Bad:** A routine created before migration 0007 has no identity. It keeps failing on
  `per_user` servers until it is re-created from a signed-in chat.
- 🔴 **Bad:** The recorded identity is the one of the creating turn. If the owner later
  disconnects the server, the routine fails closed like any call without a token; if an
  operator reassigns the routine, it still acts as the creator. An operator who fires a
  routine by hand (`POST /routines/:id/trigger`) runs it with the owner's per-user token.
- 🔴 **Bad:** `routines.user_id` may come from `resolveUserId` (which falls back to a
  header), while `mcp_user_key` always comes from the session or an attested channel
  identity. The two can name different people for a routine created through a client that
  sends the header; the MCP identity is the trustworthy one.
- ⚪ **Neutral:** The fast path's own turn id is still not visible to the audit; its rows now
  carry no turn instead of the placeholder.

## Pros and Cons of the Options

### A — Typed `callToolResult` plus unattended mode

- 🟢 Backwards compatible; callers opt in where the outcome matters.
- 🔴 Two entry points on the manager.

### B — `callTool` returns an object

- 🟢 One entry point.
- 🔴 Breaks `ctx.mcp.callTool` for every out-of-repo plugin and the `NativeTextToolHandler`
  shape MCP tools are registered as.

### C — More text prefixes

- 🟢 No API change.
- 🔴 Tool text is server data; any prefix can be produced by a server, which is exactly how
  #1944 happened.

## More Information

- Issues #1906, #1907, #1909, #1921, #1944.
- Implementation: `middleware/packages/harness-orchestrator/src/mcp/mcpClient.ts`
  (`callToolResult`, `McpCallStatus`, `auditCaller`, `blockedReason`), `turnContext.ts`
  (`mcpUnattended`, `mcpSubAgentName`, `turnIdIsPlaceholder`), `localSubAgent.ts`,
  `middleware/src/conductor/mcpActionInvoker.ts`, `middleware/src/routes/agentBuilder.ts`
  (test call), `middleware/src/plugins/routines/` (migration 0007, `routineTurnScope`),
  `middleware/src/triggers/kernelExecutors.ts`, `middleware/src/index.ts` (`blockedReason`).
- Tests: `middleware/test/mcpTypedOutcome.test.ts`, `conductorMcpAction.test.ts`,
  `routineRunner.test.ts`, `manageRoutineTool.test.ts`.
