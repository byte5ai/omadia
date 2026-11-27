# 0271 — The public MCP endpoint serves the file producers again, each result behind a detector check

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** Owner (byte5), decision of 2026-11-27 (#2305); wave 6 cluster W33. Reversible
- **Supersedes:** — (refines [ADR-0197](0197-intern-exemptions-may-be-granted-per-tool-operation.md) on
  public servability and [ADR-0142](0142-public-mcp-endpoint-fails-closed-on-privacy.md) on what counts as
  "the boundary was crossed")

## Context and Problem Statement

ADR-0197 made `render_diagram`, `create_xlsx` and `create_docx` intern-exempt: their result is the
produced file's metadata and link. The public MCP endpoint serves only results the shield masked
(`gate.masked()`, ADR-0142), so it stopped offering the three tools (#2261), named as a follow-up:
"serving them again needs a public-gate path for metadata-only exempt results". The owner decided
to offer them again with a masking check per result that passes clean outputs. (The issue text
names ADR-0198; the servability rule it refines is in ADR-0197.)

## Decision Drivers

- A result goes to an internet caller only if a privacy check ran on it (ADR-0142, fail closed).
- Interning the metadata would replace the link with a digest; the tool would be useless.
- A file name the user typed can hold a personal name or e-mail address.

## Considered Options

- **A — Per-result detector check.** The shield's free-text detectors (`redactToolErrorText`, the
  same assembly as prompt masking: baseline, operator deny-list, C1) read the result. Only a clean
  verdict is served.
- **B — Serve the redacted text** the detectors return.
- **C — Keep them off the endpoint.**

## Decision Outcome

Chosen option: **A**.

- `PUBLIC_RESULT_CHECKED_TOOLS` (`publicMcpPrivacy.ts`) lists the three tools;
  `isPubliclyServableTool` admits them. Every other intern-exempt tool stays unservable.
- `PublicMcpPrivacyGate.checkResult` runs inside `validateResult`, before the idempotency store
  retains a body (`validateResult` may now be async). Clean = outcome `redacted`, no span, detector
  not degraded. A span, `withheld`, a degraded C1, a provider without the contract or a throw leave
  `resultChecked()` false, and `assertMaskingCrossed` refuses the call like an unmasked result
  ("privacy masking did not run").
- `assertMaskingCrossed` accepts `masked() || resultChecked()`. A tool error stays the generic tool
  error of ADR-0212.
- The endpoint now finalizes each request's privacy turn once the work settles. Interned datasets
  and detector caches of a public request were never dropped before; the endpoint is stateless
  (ADR-0143), so nothing refers to them later.

### Consequences

- 🟢 **Good:** API callers can produce diagrams and Office files again.
- 🟢 **Good:** the check is the shield's own detector assembly, so an operator deny-list applies.
- 🔴 **Bad:** a file whose name holds a detected name or e-mail address is refused, not served
  with that part masked. Accepted: a masked file name in a link is worse than a clear refusal,
  and the caller can rename.
- 🔴 **Bad:** each call costs one detector run (C1 sidecar when configured).
- ⚪ **Neutral:** the produced file's contents are the caller's own input; the check covers what
  the endpoint returns, not the bytes behind the link.

## Pros and Cons of the Options

### A — Per-result detector check

- 🟢 Fail closed; no change to what the chat path sees.
- 🔴 A false positive refuses a harmless file.

### B — Serve the redacted text

- 🟢 Fewer refusals.
- 🔴 A redaction inside a URL or file name breaks the link silently.

### C — Keep them off

- 🟢 Nothing to build.
- 🔴 Contradicts the owner decision of 2026-11-27.

## More Information

- Tests: `middleware/test/publicMcp/publicMcpResultCheck.test.ts`,
  `middleware/test/privacyInternPolicy.test.ts`
