# 0298 — A file tool that delivers only into the turn's answer declares no effect

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** wave 6 cluster W32 (#2338), after the W37 live tests.
- **Supersedes:** —

## Context and Problem Statement

The discretion integration egress ([ADR-0019](0019-discretion-as-information-flow-control.md),
`guardIntegrationEgress`) checks every plugin tool that declares `write`, or that declares
nothing (`unknown`), against every label of the turn. Headless Office (`create_xlsx`,
`create_docx`) declared nothing. A web chat turn can carry a context label from another
conversation of the same person, for example from recall or memory, and that label's readers
are not `everyone`. Office has no readership declaration, so every Office export in such a turn
was refused with `integration_undeclared`, even in a fresh chat. The text answer of the same
turn went out, because the people egress lets the person see what they may know. Which egress
decides about a tool that only produces a file for the answer?

## Decision Drivers

- Office renders in-process and stores the file in the instance's own object store; no other
  system receives the data. The file reaches the person through the answer (signed link).
- `guardAnswerEgress` and `guardStreamedDone` rebuild a withheld answer without any attachment or
  file ([ADR-0177](0177-tool-outputs-are-delivered-per-turn.md)).
- An undeclared tool stays checked like a write: the contract-step default is not loosened.

## Considered Options

- **A — Declare `side_effects: none` for tools whose data goes nowhere but into the answer.** The
  integration egress skips them; the people egress decides about the answer and its files.
- **B — A kernel readership row for Office.** The operator would declare readers for a system
  that has no readers of its own; every instance would need it.
- **C — Exempt kernel-bundled plugins from the integration egress.** Too broad: a bundled plugin
  may send data to another system (Diagrams does, see below).

## Decision Outcome

Chosen option: **A**, because the file goes exactly where the answer goes, and no other system
gets the data.

- `@omadia/plugin-office` declares `create_xlsx` and `create_docx` as
  `capabilities[].side_effects: "none"` in its manifest.
- The rule for any tool: `none` only when neither the tool's input nor its output leaves the
  instance except as part of the answer (a file, an image, a card). A tool that sends data to
  another system declares `write`, and the integration egress checks it against the operator's
  readership declaration.
- **Diagrams declares nothing in its manifest.** `render_diagram` sends the diagram source, chart
  data included, to the Kroki endpoint the operator configured, which may be a public service.
  Its effect follows that endpoint and is declared at activation
  ([ADR-0299](0299-an-internal-kroki-renderer-is-a-reader-inside-the-instance.md)): `none` for a
  renderer inside the instance, otherwise the write-like check.
- The object store keeps the file under the person and chat that produced it
  ([ADR-0187](0187-generated-files-are-recorded-and-deleted-with-their-owner.md)).

### Consequences

- 🟢 **Good:** Office works in every turn whose answer may reach the person.
- 🟢 **Good:** The undeclared default (checked like a write) is unchanged for every other tool.
- 🔴 **Bad (accepted residual):** On the streaming and the CLI path the tool's own `tool_result`
  event carries the signed link (the tool output) to the client before `done`. When
  `guardStreamedDone` withholds the answer, `text_retract` and the rebuilt `done` remove the text
  and the attachments, but the link stays in the client's tool trace and works while it is valid
  ([ADR-0176](0176-signed-download-links-are-bound-to-their-route.md), bearer link). Raw tool
  output in the trace affects read tools in the same way; it is a known gap of the streamed
  trace, tracked in #2342, not new to Office.
- 🔴 **Bad:** A withheld answer can leave an object in the bucket until the chat is deleted or the
  bucket's lifecycle rule expires it.
- ⚪ **Neutral:** Diagrams in a turn with a foreign label is refused while its Kroki endpoint is
  external (ADR-0299).

## Pros and Cons of the Options

### A — Declare `none`

- 🟢 Uses the existing manifest field and the existing answer egress.
- 🔴 Relies on the plugin's own declaration; a wrong `none` skips the integration check.

### B — Kernel readership row

- 🟢 No manifest change.
- 🔴 Declares readers for a system that has none; one row per instance.

### C — Exempt bundled plugins

- 🟢 No declaration at all.
- 🔴 Exempts bundled tools that send data out as well (Diagrams to Kroki).

## More Information

- Issue #2338 (found by the wave 5+6 live tests, W37); follow-up #2342 (streamed tool trace).
- Code: `middleware/packages/harness-plugin-office/manifest.yaml`,
  `middleware/packages/harness-orchestrator/src/discretion/toolFlow.ts`.
- Test: `middleware/test/discretion/fileToolsEffect2338.test.ts`.
