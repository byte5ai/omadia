# 0198 — A transcript of the user's own upload is prompt-masked, not interned

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Owner (byte5), wave 5 cluster W05-06 (#1985). Decided per the recheck
  recommendation, reversible
- **Supersedes:** —; applies [ADR-0087](0087-transcription-capability-one-provider-consent-and-guardrails.md)
  ("a transcript is untrusted input … passes the privacy masking")

## Context and Problem Statement

`transcribe_recording` returns the transcript of an uploaded recording. Under the Privacy
Shield it was interned like any data-source result
([ADR-0094](0094-privacy-shield-data-plane-boundary.md)): the model got a one-row digest
with the text masked, could not answer a question about the recording it had just
transcribed, and could not read the session log either (#1985). `read_attachment` solves
the same problem for documents by being fully exempt. ADR-0087 says a transcript is
foreign text treated like a channel message, and a recording carries the voices of people
other than the user.

Should a transcript of the user's own upload reach the model fully in clear like
`read_attachment`, pass through prompt masking, or stay interned?

## Decision Drivers

- The tool is useless if the model cannot read what it transcribed.
- A recording holds third parties' speech; detected PII spans should be masked where the
  operator asked for prompt masking ([ADR-0095](0095-prompt-masking-wire-substitution-fail-closed.md)).
- Only the user's own upload may get this treatment. `read_attachment` and
  `transcribe_recording` accept any storage key today (#1960); a key from another chat or
  user must not become readable.

## Considered Options

- **A — Prompt masking for an upload of the current turn**, interning for every other key.
- **B — Full exemption** like `read_attachment`.
- **C — Keep interning** and document that the tool only stores the transcript.

## Decision Outcome

Chosen option: **A**.

- `PROMPT_MASKED_UPLOAD_TOOLS` maps `transcribe_recording` to its `storage_key` input
  field. `isPromptMaskedUploadCall(tool, input, turnUploadKeys)` is true only when the key
  is one of the files uploaded in this turn: the storage keys of the turn's
  `[attachments-info]` block, kept on the turn context as `turnUploadKeys`.
- Such a result goes through `maskUserPrompt` with origin `context`, the path the
  inlined text of an upload takes: PII spans become the turn's surrogates while prompt
  masking is on, the rest stays readable, the answer gets the real values back. A blocked
  mask fails closed: the result is withheld behind `internFailedNotice`. The result's
  `Error:` text is redacted like an exempt tool's.
- A transcript of any other key is interned as before. Sub-agent and plugin dispatch
  seams keep interning it; only the orchestrator's own dispatch knows the turn's uploads.
- The ownership check of #1960 (W00) stays the gate for which keys the tool may read at
  all; this ADR only decides how the text of a current-turn upload reaches the model.

### Consequences

- 🟢 **Good:** the agent can summarize and answer questions about a recording the user
  just uploaded.
- 🟢 **Good:** same behaviour as an inlined upload: masked when the operator enabled
  prompt masking, readable otherwise.
- 🔴 **Bad:** with prompt masking off (the default), the transcript reaches the model as
  spoken, including third parties' names. Accepted: the user uploaded it and asked about
  it, exactly like a document they attach.
- ⚪ **Neutral:** channels that do not write an `[attachments-info]` block give no
  current-turn keys, so their transcripts stay interned until they do.

## Pros and Cons of the Options

### A — Prompt masking for current-turn uploads

- 🟢 Readable text with PII spans masked; matches ADR-0087.
- 🔴 Depends on the channel's upload manifest to know the user's own files.

### B — Full exemption

- 🟢 Simplest; mirrors `read_attachment`.
- 🔴 No masking of third parties' PII even when the operator enabled prompt masking; any
  storage key would be readable while #1960 is open.

### C — Keep interning

- 🟢 No change in exposure.
- 🔴 The tool cannot do its job under the default posture.

## More Information

- `middleware/packages/harness-orchestrator/src/privacyInternPolicy.ts`
  (`isPromptMaskedUploadCall`), `orchestrator.ts` (`maskOwnUploadText`,
  `turnUploadKeysOf`), `turnContext.ts` (`turnUploadKeys`)
- `middleware/test/orchestrator/internExemptionsDispatch1866.test.ts`
- Issues #1985, #1960
