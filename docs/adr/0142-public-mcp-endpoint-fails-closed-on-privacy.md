# 0142 — On the public MCP endpoint an unmasked tool result is refused, never served

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; issue #542 with the two-pass security review of #550
- **Supersedes:** —

## Context and Problem Statement

Tool dispatch outside the chat loop goes through `ToolDispatchService`, which replicates the
chat path's data-plane boundary at parity: raw capture, intern exemption, operator bypass,
interning by Privacy Shield. Parity includes behaviour that is acceptable for an agent reading
its own tool results inside the install and wrong for a third party calling over HTTP: an
operator bypass hands results through raw, some tools are exempt from masking by design, and
without a privacy provider results pass unchanged. This record is retroactive. Which privacy
posture applies when the reader of a tool result is an external API caller? (Border: Privacy
Shield.)

## Decision Drivers

- The caller is not the agent: reasons for clear text that hold for the agent do not transfer.
- A failure of the privacy provider must not turn into a disclosure.
- The chat path's behaviour must not change.
- A refusal must be distinguishable from a result, and must not carry result content.

## Considered Options

- **A — Close every unmasked path at the endpoint, with a gate around the dispatcher and a
  filter on the allowlist; leave `ToolDispatchService` untouched.**
- **B — Parity with the chat path.**
- **C — Change `ToolDispatchService` to fail closed for every caller.**

## Decision Outcome

Chosen option: **A** (`middleware/src/mcp/publicMcpPrivacy.ts`, applied in
`publicMcpServer.ts` and `wirePublicMcp.ts`).

- **Masking fails: the call is refused.** The dispatcher on its own would return a "withheld"
  notice as the tool's answer. The endpoint wraps `internToolResultV4` so it never throws,
  records the failure, returns `MASKING_FAILED_PLACEHOLDER`, and then discards the result. The
  caller learns that the call failed and nothing of the result.
- **Operator bypass does not extend here.** `checkBypass` is pinned to `undefined`. A
  per-plugin or per-server bypass was configured for internal use; it cannot be configured to
  reach this endpoint.
- **Intern-exempt tools are never servable.** `memory`, `read_attachment`, `query_processes`,
  `ask_user_choice` and the rest of the fixed set are handed over in clear before the privacy
  handle is consulted, so they are removed at the allowlist (`isPubliclyServableTool`),
  whatever a binding lists.
- **No privacy provider: `tools/call` refuses.** `tools/list` still works. The escape hatch is
  `PUBLIC_MCP_ALLOW_WITHOUT_PRIVACY_MASKING` (default `false`), meant for an install whose
  allowlisted tools provably carry no personal data. Without the gate no handler runs at all:
  the server refuses a dispatcher that cannot receive it (`requirePrivacyHandle`).
- **Tool errors.** A handler that throws is answered with the dispatcher's withheld notice
  (class name, sanitised code, request id as log reference). A returned `Error:` text is never
  served: the gate answers redaction with `withheld` and the result is refused like any other
  unmasked one.
- **Sub-agents inside a tool run under the same gate.** A domain tool's model loop gets
  `handle.forNestedCalls()` as ambient handle: inner results are interned before the
  sub-agent's model sees them, and the bypass stays off.

### Consequences

- 🟢 **Good:** There is no configuration in which this endpoint serves an unmasked tool result
  except the one named flag for installs without a privacy provider.
- 🟢 **Good:** The chat path is untouched; the stricter rule lives in one module.
- 🔴 **Bad:** Callers receive identity-free digests with placeholders, not the upstream rows;
  integrations must be written against the digest.
- 🔴 **Bad:** A privacy provider outage makes every `tools/call` fail; that is the intended
  direction, and not retryable in a tight loop.
- 🔴 **Bad:** Tools an agent can use in chat may be unavailable here by construction.
- ⚪ **Neutral:** The guarantee is stated per entry point in `docs/security-architecture.md` §6c.

## Pros and Cons of the Options

### A — Endpoint-level gate and allowlist filter

- 🟢 Stricter rule exactly where the untrusted reader is.
- 🔴 A second place that must stay in step with the dispatcher's seams.

### B — Parity with chat

- 🟢 No extra code.
- 🔴 Bypass, exemption and a missing provider each hand raw data to an API caller.

### C — Fail closed in the dispatcher for everyone

- 🟢 One rule.
- 🔴 Changes chat, routines and sub-agents, where exemptions exist so the agent can read its
  own state.

## More Information

- Related: [ADR-0143](0143-public-mcp-endpoint-is-stateless-and-default-deny.md); ADR-0019.
- Tests: `middleware/test/publicMcp/publicMcpPrivacy.e2e.test.ts`,
  `publicMcpPrivacyGate.test.ts`, `publicMcpMaskingAssertion.test.ts`,
  `publicMcpSubAgentPrivacy.test.ts`.
