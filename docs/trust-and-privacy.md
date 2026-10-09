# Trust & privacy

What omadia's trust controls cover, their defaults, and their limits. The
[README](../README.md) gives the short version. The enforcing code paths are in
the [security architecture](security-architecture.md), and
`middleware/test/docsClaimsGuard.test.ts` keeps the statements on this page
tied to the code.

## At a glance

By default, the Privacy Shield keeps the raw results of data-source tools on your
server. It acts in the model requests a turn makes itself, from the agent's
model loop and its sub-agents to the answer verifier's checks, and in the
requests of the memory jobs. In a turn's requests the model works from an
identity-free digest of each tool result, apart from a few exempt tools such
as `read_attachment` (it refuses tables) and any tool an operator sets to
bypass the shield, and gets tool errors redacted, apart from the errors a
bypassed tool returns. The earlier answers a channel
replays and recalled context are masked there whatever the settings. Your own
messages, text from uploads and the user messages a channel replays are masked
there only once you switch on prompt masking
(`mask_user_prompt`, default off). The inbound security screener and turn
scoring get the turn's text as the turn's model saw and wrote it, masked by
the same rules. The stored memories and earlier turns the memory jobs send to
their own model (the recall relevance judge, the session briefing,
topic-cluster naming, the inconsistency detector and the Teams topic detector)
are masked whatever the settings, and a job that cannot mask skips its model
call. Every other model call sends its text as it is, with prompt masking on
or off. That covers the embedding of stored memories and plugin calls through
`ctx.llm` such as the canvas composer and the plan runner. Images you attach go to an
image-capable model unmasked,
and agents on the Claude subscription CLI run without the shield. The
exceptions are listed under [Trust & privacy architecture](#trust--privacy-architecture).
An optional answer verifier, off by default, checks an answer against its
sources only when one of its trigger patterns matches, such as a euro amount,
an accounting reference or a date written as `2026-10-02`. An answer whose
only figures come in other formats, like `$500` or `October 2, 2026`, is not
checked unless an aggregate keyword such as `total` stands in it. In its
default `shadow` mode the verifier only records a verdict. On the Postgres
backend, each turn in which the shield acted appends a hash-chained receipt.
Writing it is best-effort: a failed write is logged, and the turn completes
without a receipt.

## Controls and defaults

| Capability | What you get |
|---|---|
| 🛡️&nbsp;**Privacy&nbsp;Shield** | Raw results of data-source tools stay behind a data-plane boundary. The shield acts in a turn's own model requests, from the agent's loop and its sub-agents to the verifier's checks, and in the memory jobs' requests. In a turn's requests the LLM works from an identity-free digest of each tool result and gets tool errors redacted or withheld, and a result the shield cannot intern is withheld. `guarded` by default, with `bypass`, `per_tool` and a per-MCP-server bypass as opt-ins and an org-wide clamp (`OMADIA_PRIVACY_FORCE_GUARDED`) that also covers knowledge-graph ingestion of MCP results. `read_attachment` (uploaded documents; it refuses tables and points the model to `query_dataset`) and a short allowlist of the agent's own tools return their results in clear, while their errors are redacted or withheld like any tool's; the errors a bypassed tool returns reach the model as they are. The answers a channel replays as chat history and recalled context are masked there whatever the settings, because an answer the shield rendered carries real values. Your messages and the user messages a channel replays are masked there only while prompt masking (`mask_user_prompt`, off by default) is on, so by default they reach the model as typed. The inbound security screener and turn scoring get the turn's text as the turn's model saw and wrote it. The stored text the memory jobs send to their own model (the recall judge, the session briefing, cluster naming, the inconsistency and topic detectors) is masked whatever the settings, and a job that cannot mask skips its model call. Every other model call sends its text as it is, with masking on or off, from the embedding of stored memories to plugin calls through `ctx.llm` such as the canvas composer and the plan runner. Attached images go to an image-capable model unmasked, and the Claude subscription CLI (`claude-cli`) runs without the shield. |
| ✅&nbsp;**Answer&nbsp;verification** | Optional and off by default (`verifier_enabled`). Once switched on, it checks an answer against the run's own sources only if one of its trigger patterns matches, such as a euro amount, an accounting reference like `INV/2026/0042` or a date written as `2026-10-02`, and records a verdict. Figures in other formats, such as other currencies or English-format dates, match no trigger pattern unless the answer also holds an aggregate keyword such as `total` and a number of three or more digits. An answer in which the verifier finds nothing to check is `skipped`, a verifier that could not run is `unavailable`, and `approved` means that every claim the verifier extracted was checked and confirmed. The default mode, `shadow`, only records. `enforce` holds each answer until its verdict and delivers an answer the verifier confirmed. It withholds an answer with a refuted claim, a missing or invented source citation or data the run never fetched, and an answer the verifier could not check because it could not run, every check failed or the Privacy Shield kept the answer from it. An answer whose claims it could not all confirm, with none of them refuted, goes out with a note that its statements could not be confirmed automatically. An answer that no trigger pattern matched, or in which the extraction found no claim, goes out unchecked in `enforce` too, and so does a turn that carries an input card. |
| 🧮&nbsp;**Excel&nbsp;from&nbsp;real&nbsp;rows** | `create_xlsx` writes the real rows behind a `datasetId` into the workbook server-side, so they never pass through the model, and adds sums and pivots as Excel formulas. omadia runs no spreadsheet engine of its own: the workbook asks the spreadsheet application to recalculate when it opens the file, and that application computes every formula result. |
| 🧾&nbsp;**Traces&nbsp;and&nbsp;receipts** | The call-stack viewer shows a run step by step, with each tool call and decision. That trace is best-effort telemetry, so a run can lack one. Privacy receipts (`/operator/receipts`, Postgres backend) are hash-chained and written best-effort, one for each turn in which the privacy shield acted. A failed write is logged and not retried, and a receipt that was never written leaves no gap in the chain. |
| 🧩&nbsp;**Hash-pinned&nbsp;plugins** | Plugins are ZIP files. Their dependencies are bundled in the ZIP or come from the omadia image. A registry download must match the SHA-256 listed in that registry's index. There is no publisher signature yet, so trust rests on the registries you configure and the ZIPs you upload. Installed plugin code never comes from npm at runtime. §4 of the [security architecture](security-architecture.md) lists where omadia itself runs npm, including the Builder template that previews load. |

## Where the code lives

- **Privacy Shield**: a data-plane boundary that interns the raw results of
  data-source tools and gives the LLM an identity-free digest of them, with the
  limits listed under [Trust & privacy](#trust--privacy-architecture)
  ([`harness-plugin-privacy-guard`](../middleware/packages/harness-plugin-privacy-guard),
  [`privacyMode.ts`](../middleware/packages/plugin-api/src/privacyMode.ts))
- **Answer verifier** (optional, off by default): checks answers that match
  its trigger patterns, such as euro amounts and dates, against their sources
  and records a verdict. In `enforce` mode it withholds an answer with a
  refuted claim or one it could not check, sends an answer whose claims it
  could not all confirm with a note saying so, and lets an answer that matched
  no pattern go out unchecked
  ([`harness-verifier`](../middleware/packages/harness-verifier),
  [`verifierService.ts`](../middleware/packages/harness-orchestrator/src/verifierService.ts))
- **Office files**: `create_xlsx` / `create_docx` build real spreadsheets and
  documents server-side, resolving dataset rows without routing them through the
  model; the spreadsheet application calculates the formulas when it opens the
  file ([`harness-plugin-office`](../middleware/packages/harness-plugin-office))

## Trust & privacy architecture

Three subsystems let omadia put real data in front of an LLM and stand behind the
answer:

- **Privacy Shield (data-plane boundary)**: the raw results of data-source tools
  are interned behind the boundary, and the LLM works from an identity-free
  digest of them. A result the shield cannot intern is withheld, and the model
  gets a notice in its place. `guarded` is the default. Setting a plugin to
  `bypass` or `per_tool`, or flagging an MCP server for privacy bypass, is an
  explicit opt-in, and `OMADIA_PRIVACY_FORCE_GUARDED` clamps each of them back
  to `guarded` org-wide for the results the model gets. The clamp covers the
  knowledge-graph ingestion of MCP results too: while it is set, an MCP server
  flagged for both ingestion and privacy bypass stores a value-free note of
  each result's shape instead of up to 8,000 characters of the raw result.
  Pseudonyms resolve back to real
  values only at materialization. Each bypass is recorded on the turn's
  receipt on a best-effort basis (the bypass applies even when recording it
  fails), and receipts are persisted best-effort.

  The shield acts in the model requests a turn makes itself, which are
  the agent's model loop, its sub-agents and the verifier's requests about
  the answer, and in the requests of the memory jobs (below). Under `guarded`
  it replaces each tool result in a turn's requests with the
  digest. It redacts the `Error:` text a tool returns, or withholds it whole,
  and it withholds the message of a tool that throws. It masks prompt text
  only while an operator has switched on prompt masking (`mask_user_prompt`,
  default off). The user's message, text inlined from uploads, the user
  messages a channel replays and a direct-line relay are
  then masked, and so is the text the turn's routing, fact-extraction and
  memory-excerpt passes read. Masking finds values such as e-mail addresses,
  IBANs, phone numbers, amounts and dates by pattern, plus the terms on the
  operator's deny-list, and names only through the optional C1 detector. If
  the pattern pass fails, the request is blocked instead of being sent
  unmasked. If C1 fails during a turn, the rest of that turn runs on the
  patterns alone, and names only C1 would find reach the model as typed.
  With masking off, the user's own message, text inlined from uploads and
  the user messages a channel replays (`priorTurns`) reach the model as
  typed. The earlier answers a channel replays, as the Teams and Telegram
  channels do, and recalled context, which carries answers stored with their
  real values, are masked whether prompt masking is on or off, because an
  answer the shield rendered carries real values the model never saw: e-mail addresses, IBANs, phone numbers, postal addresses and ID
  numbers by pattern, the deny-list terms and names through C1, while dates
  and amounts stay readable. The reply gets the real values back.

  Some tool results skip the digest and the redaction. The text of an
  uploaded document that `read_attachment` returns (it refuses an upload it
  recognises as a table by type or name, CSV or XLSX, and points the model
  to `query_dataset`) and the results of a short
  allowlist of the agent's own tools (`memory`, the stored-process tools,
  `suggest_follow_ups`, `ask_user_choice`) reach the model in clear, and so
  do the errors these tools return or throw. A tool an operator set to bypass
  hands the model its result and the errors it returns as they are, while a
  message it throws is still withheld.

  Under the default security posture (`auto`), the inbound security screener
  sends the user's message, the user messages a channel replays and the names
  and types of attached files to the agent's own model, or to a screening
  proxy the operator configured, on every turn that carries an upload. It gets
  them masked like the turn's own model call: the messages and the file names
  go through the turn's prompt masking, so they arrive as typed while
  `mask_user_prompt` is off, and a turn whose masking fails is refused before
  anything is screened. At the default capture level, the memory plugin sends
  each turn it stores to its own provider for a significance score, as the
  turn's model saw and wrote it: the message masked like the prompt and the
  answer with the shield's surrogates, not the real values restored for you.

  The memory plugin's jobs send stored memories and earlier turns, which hold
  real values, to its own provider: the recall relevance judge filters
  recalled context, the session briefing summarises an earlier session,
  topic-cluster naming and the inconsistency detector compare memories, and
  the Teams topic detector reads the previous exchange. With a privacy guard
  installed that text is masked whether prompt masking is on or off, like a
  replayed answer: e-mail addresses, IBANs, phone numbers, postal addresses
  and ID numbers by pattern, the deny-list terms and names through C1. The
  judge and the briefing run inside the turn and mask through its map; the
  other jobs run outside a turn and mask through a map of their own per run.
  A session summary, a cluster name or an inconsistency summary gets the real
  values back. If masking fails, or the installed privacy guard predates it
  (privacy guard 0.8.0), the job skips its model call; without a privacy
  guard the jobs send the text as stored.

  Every other model call sends its text as it is, with prompt masking on or
  off. A significance backfill an operator starts over stored turns sends them
  as stored. With the OpenAI-compatible embedding adapter, stored turns and
  memories are embedded at that provider as stored, real values included, and
  masking them is still open. Through `ctx.llm`, the canvas composer and the plan-runner's
  planning check send the user's message before the turn starts. Images the
  user attaches are not masked in any request, because the shield reads text
  only. Agents on the Claude subscription CLI (`claude-cli`) run without the
  shield, and `agents.privacy_profile` is not a shield setting
  ([`docs/security-architecture.md`](security-architecture.md) §3a, §6b,
  §6c, §6d, §6f, §7b).
  Spec: [`specs/001-privacy-shield-v4/`](../specs/001-privacy-shield-v4/).
- **Answer verification (optional)**: off by default (`verifier_enabled`), and
  switching it on also needs an API key for the verifier's model provider. The
  verifier checks an answer only if one of its trigger patterns matches
  (`shouldTriggerVerifier`). The patterns look for euro amounts, accounting
  references such as `INV/2026/0042`, dates written as `2026-10-02` or
  `02.10.2026`, percentages, hour and day counts such as `42,5 Stunden`, and an
  aggregate keyword such as `Summe` or `total` in an answer that also holds a
  number of three or more digits. A figure in any other format, such as
  `USD 50,000`, `$500`, `October 2, 2026` or `3 unpaid invoices`, matches none
  of them on its own. The patterns are regular expressions over the whole
  answer, so the keyword and the number need not belong together:
  `Total: $500` is checked, `$500` alone is not. For an answer that matches,
  the verifier checks the claims its extraction model lists against the run's
  sources and records a verdict. An answer in which it finds nothing to check
  is `skipped`, and a verifier that
  could not run is `unavailable`. Neither is reported as `approved` or shown as
  verified. A claim no checker takes, claims beyond the per-answer cap, text
  beyond the part of the answer the claim extractor reads, and a returned claim
  that does not quote the answer or is too long to check whole all stay in the
  verdict as not checked, so such an answer is at most partly verified. No
  claim is shortened to fit a check, and a claim the extraction model leaves
  out is not seen by any check. In the default `shadow` mode the verifier only
  records, and every answer goes out as written. `enforce` holds each answer
  until its verdict, on the stream too. It delivers an answer the verifier
  confirmed. It replaces an answer with a refuted claim, a missing or invented
  citation or data the run never fetched, and one it could not check (the
  verifier could not run, or every check failed), with a notice that the
  answer was withheld. An answer whose claims it could not all confirm, none
  of them refuted, goes out with a note that its statements could not be
  confirmed automatically. An answer that no trigger pattern matched, or in which
  the extraction found no claim, goes out unchecked in `enforce` too, unless a
  check that needs no extraction blocks it (a failure the answer reports
  without evidence from this turn, a tool result that broke its declared
  schema, missing citations for knowledge-graph evidence). A withheld answer
  is still stored and can reach a later turn's context.
  `enforce` gives a contradiction at most one correction retry, none on canvas
  streams or with `verifier_max_retries` set to 0, and on the non-streaming
  path it gives a borderline answer a second sample. Both re-generate the
  answer from the first run's recorded tool results. They replay every
  recorded external call and execute none of those calls again. A sub-agent
  whose data the shield interned runs again, but its own tool calls replay
  too, and a re-entry that needs a new call other than a kernel read is
  abandoned. Without that replay ledger, which `enforce` binds only when it
  may re-enter, the MCP client retries a call once after a transport failure,
  so an MCP write whose reply was lost can run twice. An answer the shield
  rendered with real values is never sent to the verifier, so `enforce`
  withholds it, unless the turn carries an input card: the card exemption runs
  first, and a turn with an input card goes out unchecked, a rendered answer
  included. Agents on the Claude subscription CLI and routines are not
  verified ([`docs/security-architecture.md`](security-architecture.md)
  §6e, §7c).
- **Office files from real rows**: when a specialist agent returns a
  `datasetId`, `create_xlsx` resolves the rows server-side and writes them into
  the workbook without passing them through the model. Sums and pivots go in as
  Excel formulas, and omadia does not evaluate them. A formula cell carries no
  cached result, and the workbook asks the spreadsheet application to
  recalculate on open, so the application that opens the file computes every
  figure. A formula that would reach outside the workbook is refused. `.docx`
  output is laid out from the text the model writes and computes nothing.

