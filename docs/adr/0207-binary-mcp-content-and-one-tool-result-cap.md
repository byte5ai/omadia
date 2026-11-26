# 0207 — Binary MCP content never reaches a model as text, and one tool-result cap holds with or without the shield

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (Welle 5, W09-10; decided after the recheck recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

`renderToolResult` turned every MCP content block that is not text into `JSON.stringify(block)`.
An `image` block therefore reached the model as base64 text: under the Privacy Shield it
was interned as a one-cell dataset the model could not read, and on a bypassed server a
512×512 PNG produced a 1.1 MB provider request that the provider refused as too long
(#1920). Separately, the shield's intern cap (`MAX_INTERN_CHARS`, 200 000 characters) was
the only bound on a tool result: a bypassed server, a sub-agent that ran in bypass, or a
turn without a privacy guard passed a 400 KB result to the provider in full.

What may a model receive from binary MCP content, and what bounds a tool result that the
shield does not intern?

## Decision Drivers

- The shield masks text; an image can show personal data it cannot see (ADR-0094).
- A provider request must not fail or cost a fortune because of one tool result.
- Behaviour must not depend on whether the shield happens to be installed.

## Considered Options

- **A — A type/size placeholder now; provider image blocks only for unmasked servers, later**
- **B — Provider image blocks for every MCP image now**
- **C — Keep base64 text, cap it like any text**

## Decision Outcome

Chosen option: **A**.

- **Binary content.** An MCP `image` or `audio` block and a `resource` with a `blob`
  become `[<kind>: <mime type>, <n> bytes — not shown to the model]`. Base64 never reaches
  a model as text.
- **Images under a guarded posture.** An image is not passed to a model while the shield
  masks the server's results: the shield cannot check its contents. Turning an image into a
  provider image block (downscaled) is allowed only for a server whose bypass is in force
  (ADR-0092), and is a follow-up that needs the tool-result path to carry non-text parts.
- **One cap on the orchestrator dispatch path.** A tool result the shield does not intern —
  operator bypass, a sub-agent's bypassed narration, no privacy guard installed — is cut to
  `MAX_TOOL_RESULT_CHARS` (200 000, the shield's own intern cap) with a notice telling the
  model it was cut (`capToolResultText`). An interned result keeps the shield's bound. A
  kernel or plugin tool's `_pending*` directive (canvas, choice card) is left whole, since
  the kernel parses it after the call; an MCP server's text is never exempt. Not covered yet:
  intern-exempt kernel tools under a guard, and the standalone `ToolDispatchService` path
  (sub-agent CLI, public MCP), which keeps its own bounds.

### Consequences

- 🟢 **Good:** No more provider refusals or runaway cost from a single image or a huge
  bypassed result; the model learns that a file exists.
- 🔴 **Bad:** A model still cannot look at an MCP image, also on a bypassed server, until the
  follow-up lands.
- ⚪ **Neutral:** Native plugin tools on those three paths are capped too; 200 000 characters
  is far above what a tool normally returns.

## Pros and Cons of the Options

### A — Placeholder now, image blocks for unmasked servers later

- 🟢 Closes the failure today with a small, contained change.
- 🔴 Leaves the useful half (seeing the image) for later.

### B — Image blocks for every MCP image

- 🟢 The model can use images right away.
- 🔴 Sends unmasked pixels under a guarded posture; needs provider-adapter work in every
  wire format.

### C — Base64 as capped text

- 🟢 No new code path.
- 🔴 A cut base64 string is useless and still costs tokens.

## More Information

- Issue #1920.
- Implementation: `middleware/packages/harness-orchestrator/src/mcp/mcpClient.ts`
  (`renderToolResult`, `binaryBlockPlaceholder`),
  `middleware/packages/harness-orchestrator/src/toolResultCap.ts`, `orchestrator.ts`
  (`dispatchTool`).
- Tests: `middleware/test/mcpStructuredContent.test.ts`, `middleware/test/mcpResultSafety.test.ts`.
- Related: [ADR-0092](0092-privacy-postures-bypass-and-org-clamp.md), [ADR-0094](0094-privacy-shield-data-plane-boundary.md).
