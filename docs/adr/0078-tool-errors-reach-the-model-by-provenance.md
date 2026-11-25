# 0078 — Tool errors reach the model by provenance: thrown text is withheld, returned text redacted, refusals are typed

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; implemented in #1265 and #1284 (shielded tool errors),
  `ToolRefusalError` and kernel `ctx.http` refusals in #1423 (#1343)
- **Supersedes:** —

## Context and Problem Statement

The Privacy Shield only ever saw what a tool returned as data. A tool error slipped past it on
two routes: a handler that threw had its message folded into `Error: ${err.message}` by the
dispatch loops, and a returned `Error:` string was passed through un-interned so the model could
read its hint. Neither text is sanitized by construction: an ORM echoes the failing row, a driver
its bound parameters, a remote MCP server whatever its error body quotes. Both reached the
provider wire, the streamed `tool_result` and the persisted session. This record is retroactive.

At the same time the model needs to know *that* and roughly *why* a call failed, a plugin must be
able to refuse a call with a readable reason, and some error-shaped texts are control flow (the
MCP connect prompt). Which error text may a model read?

## Decision Drivers

- No unchecked text from an exception on the provider wire, the stream or the session.
- The model keeps a usable hint, and an operator can recover the full error.
- A refusal written for the model must stay readable.
- Trust must not depend on a text's shape, because a remote server can imitate any shape.

## Considered Options

- **A — One ingestion helper for every dispatch seam; policy by provenance.**
- **B — Forward error messages and rely on general masking.**
- **C — Withhold every error text.**
- **D — Intern errors like data.**
- **E — Recognise errors by pattern anywhere in the result.**

## Decision Outcome

Chosen option: **A** (`toolErrorRedaction.ts`, used by the orchestrator loops, `LocalSubAgent`
and `ToolDispatchService`).

- **Thrown:** the message is never forwarded. The model gets
  `Error: tool \`<name>\` failed with <ErrorClass> (code <code>) [ref <ref>]`; the full error
  goes to the server log under the same ref, which is the turn's correlation id.
- **Unknown outcome, no blind repeat.** The withheld notice also says the outcome is unknown
  and not to repeat a call that changes data; a thrown message is withheld even for a tool the
  operator set to bypass. An identical repeat (same tool, same canonical input) of a call that
  ended that way is refused for the rest of a sub-agent run (`subAgentUnknownOutcome.ts`) and,
  through the request's replay ledger (`turnContext.toolReplayLedger`), for the whole request,
  except for a kernel tool known to be read-only.
- **Thrown refusal:** a `ToolRefusalError` (`@omadia/plugin-api`, `toolErrorNotice.ts`) or a
  kernel `ctx.http` permission error carries a message written for the model. It becomes
  `Error: tool \`<name>\` refused the call: <message>` and then takes the returned-error policy.
  The message is cut at `MAX_REFUSAL_MESSAGE_CHARS` (600). `ToolRefusalError` is recognised by
  its `name`, not by `instanceof`, because a plugin bundles its own copy of the package.
- **Returned `Error:`:** the text goes through the privacy provider's `redactToolErrorText`,
  which replaces spans irreversibly with `[masked:<type>]`. It is withheld whole when it is
  exception-shaped (record echo, stack trace, Postgres detail line), longer than
  `MAX_REDACTABLE_TOOL_ERROR_CHARS` (4096), or when the provider cannot redact. Fail closed.
  The redactor masks the C0 identity types (e-mail, IBAN, phone, address, id number), the
  operator deny-list and C1; `date` and `amount` stay, because they are the hint.
- **Control-flow text is trusted by provenance, never by shape.** The MCP connect prompt passes
  byte-identical only when it is the exact text `McpManager.handleFailure` minted in the same
  dispatch (`mcp/mcpAuthPromptMint.ts`); the MCP input sentinel has its own mint
  (`mcp/pendingMcpInput.ts`); a refusal the kernel authored itself is keyed on a per-dispatch box
  (`KernelRefusalBox`), not on its wording. Any other prompt-shaped text is interned as data.
  `isGuardedControlFlowResult` matches only the `Error:` prefix or a whole result byte-equal to
  a minted prompt, never a marker elsewhere in a result.
- **Order at each seam** (`Orchestrator.dispatchTool`, `guardReplayResult`,
  `ToolDispatchService`, `LocalSubAgent.dispatch`): after the operator bypass and before
  interning; for an intern-exempt tool before the exemption.
- **Wrappers** that catch an exception themselves return the same withheld notice through
  `toolErrorFromException` (`@omadia/plugin-api`) instead of forwarding foreign text.
- **`Error:` prefix is the convention** (`TOOL_ERROR_PREFIX`): both loops key `is_error` off it,
  and a policy refusal (audience floor, dispatch deadline, replay miss) is a tool result, not an
  exception, so the model can explain it or take another route.
- **Receipt:** every handled error writes a PII-free `toolErrors` entry into the turn's privacy
  receipt.
- **Parity default:** with no privacy provider installed nothing is masked at all, tool results
  included, so a thrown message flows raw there. Intern-exempt self tools get no pass for their
  error text.

### Consequences

- 🟢 **Good:** A driver or ORM message can no longer leak a record through an exception.
- 🟢 **Good:** Plugins have one supported way to say "no" readably: throw `ToolRefusalError`.
- 🔴 **Bad:** The model sees only class and code of a thrown error and may give the user a vaguer
  explanation; diagnosis needs the server log and the ref.
- 🔴 **Bad:** A long or record-shaped returned hint is withheld even when harmless.
- 🔴 **Bad:** Without a privacy provider the old raw behaviour remains.
- 🔴 **Bad:** A *successful* result whose data begins with `Error:` is treated as an error.
- 🔴 **Bad (accepted residuals, `docs/security-architecture.md` §6c):** without C1 a name in
  running prose survives redaction; on the subscription-CLI loopback dispatch and for a
  bypassed tool's returned error the text passes raw; two server-side sinks
  (`captureRawToolResult` for routine templates, and the MCP → Knowledge-Graph path) read the
  raw result before the seam.
- ⚪ **Neutral:** Returned-error redaction needs a provider on the `@omadia/plugin-api` 1.20.0
  contract; an older provider causes withholding.

## Pros and Cons of the Options

### A — Policy by provenance

- 🟢 Each class of text gets the least exposure that still works.
- 🔴 Four cases to keep straight at every new dispatch seam.

### B — Forward and mask

- 🟢 Best model-side diagnosis.
- 🔴 Partial regex masking of a record dump is not reliable; names survive it.

### C — Withhold everything

- 🟢 Simplest and safest.
- 🔴 The model can no longer correct a bad argument or explain a refusal.

### D — Intern errors like data

- 🟢 Nothing leaks.
- 🔴 The model narrates success over a masked digest, and a later `v4_render_answer` could
  render the error as a one-row dataset.

### E — Pattern anywhere in the result

- 🟢 Catches errors nested in results.
- 🔴 One planted marker in a cell would unmask a multi-row result.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/toolErrorRedaction.ts`,
  `privacyInternPolicy.ts`, `mcp/mcpAuthPromptMint.ts`,
  `middleware/packages/plugin-api/src/toolErrorNotice.ts`.
- Tests: `middleware/test/orchestrator/toolErrorRedaction.test.ts`,
  `toolErrorExceptionShape.test.ts`, `exemptToolErrorRedaction.test.ts`,
  `mcpAuthPromptProvenance.test.ts`, `mcpInputSentinelPrivacy.test.ts`,
  `chatPathToolErrorText.test.ts`, `middleware/test/privacyToolErrorRedaction.test.ts`.
- Related: ADR-0019 (mask at entry), [ADR-0075](0075-one-request-runs-each-tool-once-and-records-the-delivered-answer.md).
- Border: privacy (the redactor itself lives in the privacy guard).
