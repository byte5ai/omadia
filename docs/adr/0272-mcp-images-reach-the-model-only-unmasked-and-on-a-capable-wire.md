# 0272 — An MCP image reaches the model as an image only where no shield masks the server and the wire carries it

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (Welle 6, W33; decided after the recheck recommendation, reversible)
- **Supersedes:** — (carries out the follow-up named in [ADR-0207](0207-binary-mcp-content-and-one-tool-result-cap.md))

## Context and Problem Statement

ADR-0207 made binary MCP content a text placeholder (`[image: image/png, n bytes — not shown to
the model]`) and allowed a real image block only for a server whose bypass is in force, as a
follow-up that needed the tool-result path to carry non-text parts. Every tool handler returns a
string, and every scan of a `tool_result` (nudges, choice cards, routine lists, the MCP input
card, the loop guard) reads that string. The OpenAI Chat Completions and Responses wire mappings
refuse an image part inside a tool result. How does an MCP image reach the model without
widening the string contract and without breaking a provider that cannot carry it (#1920)?

## Decision Drivers

- A shield that masks a server's results cannot check an image's contents (ADR-0207).
- Tool handlers and every result scan keep their string contract.
- A provider whose wire refuses an image in a tool result must never get one.
- Bounded: a single image must not blow the provider request (the #1920 400 "prompt is too long").

## Considered Options

- **A — Side channel per dispatch, attached on the wire copy.** `McpManager` records a
  successful call's eligible images into a per-dispatch capture; the orchestrator attaches them
  to the `tool_result` only when the result went to the model unmasked and the provider
  declares `toolResultImages`.
- **B — Widen the handler contract** to return content parts.
- **C — Keep the placeholder** everywhere.

## Decision Outcome

Chosen option: **A**.

- `mcpBinaryContent.ts`: `recordMcpImages` (called by `McpManager` on a successful result)
  collects up to 4 images per call of type PNG, JPEG, GIF or WebP, valid base64, at most
  3 750 000 decoded bytes each (Anthropic's 5 MB base64 limit). Others stay placeholders. No
  downscaling: an image above the limit is not sent.
- `Orchestrator.dispatchTool` opens the capture around the dispatch. The dispatch marks an MCP
  tool's result as unmasked on two branches only: operator bypass in force (ADR-0092, after
  the room's field-rights check) and no privacy guard installed. Under a guard that masks the
  server, the capture is dropped.
- The images go to `ToolDispatchMeta.modelImages` and are attached in both tool loops (`runTurn`
  and `chatStream`) to the copy of the `tool_result` that is pushed into `messages`: text first,
  with each attached image's placeholder reading `— attached as an image]`, then one image block
  per image. Every scan before and after keeps reading the text.
- New optional provider capability `toolResultImages` (`@omadia/llm-provider-api`). The
  Anthropic adapter sets it; unset means text only. Images are attached only when the agent's
  vision setting and `toolResultImages` of the provider **this turn runs on** (routed primary or
  fallback, `orchestratorExecution`) are both true; an unknown execution attaches none.
- One budget per provider request: at most 4 images and 8 000 000 decoded bytes across all calls
  of the batch. Before the next request, images of earlier iterations go back to their text
  (`stripModelImages`), so an image is sent once. An image whose placeholder the result cap cut
  is not attached.
- Not covered: sub-agents (`LocalSubAgent`), the CLI path, and `ToolDispatchService` callers
  (public MCP, loopback) keep the placeholder.

### Consequences

- 🟢 **Good:** a model can look at an image a bypassed (or unguarded) MCP server returned.
- 🟢 **Good:** OpenAI-family providers never get an image part they refuse.
- 🔴 **Bad:** a later iteration sees only the text of an earlier image. Accepted: the model
  described it when it saw it, and re-sending would cost the image tokens on every step.
- ⚪ **Neutral:** an operator who switches a server to "Unmasked" now also lets its images reach
  the model; the badge's meaning ("results go to the model unmasked") covers it.

## Pros and Cons of the Options

### A — Side channel per dispatch

- 🟢 No handler, plugin-api or scan changes; the decision sits where bypass is decided.
- 🔴 One more per-dispatch capture next to `mcpStructuredCapture`.

### B — Content parts from handlers

- 🟢 General.
- 🔴 Touches every handler, the replay ledger, the hooks and every result scan.

### C — Placeholder only

- 🟢 Nothing to build.
- 🔴 MCP image tools stay useless (#1920).

## More Information

- [ADR-0207](0207-binary-mcp-content-and-one-tool-result-cap.md), [ADR-0092](0092-privacy-postures-bypass-and-org-clamp.md)
- Tests: `middleware/test/orchestrator/mcpToolResultImages.test.ts`
