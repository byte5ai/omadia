# 0087 — Speech-to-text is one neutral capability with one active provider; installing it is the consent, and a spend brake is on from the first day

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main; #584 workstreams T and I)
- **Supersedes:** —

## Context and Problem Statement

Voice messages, uploaded recordings and, later, live meetings need speech-to-text.
[ADR-0031](0031-audio-meeting-source-split-from-native-facilitators.md) refers to
`transcription@1` as existing and moved the audio meeting source out of the facilitator
epic; no record says what the capability is. Producing a transcript sends raw audio to an
external endpoint and is billed per minute, and a live stream may never end. What is the
contract, who may provide it, how does an operator agree to audio leaving the
installation, and what limits the spend? This record is retroactive.

## Decision Drivers

- The contract must not carry one vendor's realtime types; other vendors or a local model
  should fit later.
- Raw audio must not leave an installation because a plugin was bundled.
- A stream that is never closed must not bill without limit.
- A transcript is foreign text and must be treated like a channel message.

## Considered Options

- **A — A neutral `transcription@1` capability with batch and stream, one active provider, guardrails in the contract package**
- **B — Transcription inside each channel plugin that needs it**
- **C — Transcription as a tool of the OpenAI LLM adapter**

## Decision Outcome

Chosen option: **A**.

- **Contract** (`plugin-api/src/transcription.ts`): `TranscriptionService` with
  `transcribeFile` (batch) and `transcribeStream` (live). Callers may pass context hints
  (languages, literal terms, free text). A transcript consists of timestamped segments
  with an optional speaker; the speaker comes from the channel or a diarizing provider,
  never from what a caller says about itself.
- **Two names, one rule.** The service registry key is the bare `transcription`
  (`TRANSCRIPTION_SERVICE_NAME`); `transcription@1` is the manifest capability ref. The
  versioned form is never used as a registry key.
- **Exactly one provider is active**; a second `provide` throws. Consumers resolve the
  service per call and degrade when none is installed: the `transcribe_recording` tool
  returns a readable error and does not throw.
- **Consent is the install.** The first provider, `@omadia/transcription-adapter-openai`
  (kind `model`), has a `secret` field, so the built-in bootstrap never installs it
  automatically. Without a key it activates and publishes nothing. The admin page
  `/api/v1/admin/transcription-provider` states before the switch that raw audio goes to
  the configured endpoint, and switches like the embedding page: deactivate, activate,
  verify the capability is published, roll back otherwise. A switch destroys nothing, so
  there is no confirmation step.
- **Guardrails from day one** (`withTranscriptionGuardrails` in
  `plugin-api/src/transcriptionGuardrails.ts`): a cap per call (`max_call_minutes`,
  default 240) and a minute quota per agent (`agent_quota_minutes`, default 600), with
  minutes metered to the operator log. Streams are cut at the cap by a wall-clock
  backstop even if the provider ignores the field. For batch files the cap is advisory,
  because a file's duration is unknown before transcription; the billed duration counts
  against the quota afterwards. The agent key is read before the first yield of a stream.
- **The quota is in memory and per process.** It is a brake, not a ledger; a ledger in
  Postgres is a stated non-goal of the first version.
- **Realtime is experimental.** `transcribeStream` on `gpt-live-transcribe` runs only with
  `TRANSCRIPTION_REALTIME_EXPERIMENTAL`; its consumer, the audio meeting source, is the
  follow-up project of ADR-0031. Batch on `gpt-transcribe` is not gated.
- **A transcript is untrusted input.** It enters a turn as a tool result or channel
  content and passes the privacy masking that every model call site has.
- **Every call passes the model gateway** as operation `transcribe`: the service registry
  wraps the published service (`gateModelService`), and a channel plugin's
  `transcribeFile` before a turn runs as inbound processing
  ([ADR-0017](0017-model-gateway-and-execution-contexts.md)).
- **Batch ingestion converges with live chat:** `transcribe_recording` accepts at most
  25,000,000 bytes and writes speaker-attributed session-log entries, the same artifacts
  a chat produces.

### Consequences

- 🟢 **Good:** Another vendor or a local model can register without a change to the
  contract or to consumers.
- 🟢 **Good:** No audio leaves an installation that did not install and key a provider.
- 🔴 **Bad:** The quota resets on every restart and is per process, so several instances
  each grant the full allowance. Transcription minutes are not in `token_usage`
  ([ADR-0088](0088-usage-ledger-in-usd-with-read-time-price-resolution.md)).
- 🔴 **Bad:** The batch cap cannot stop a long file before it is billed.
- 🔴 **Bad:** One provider for the whole installation; no choice per agent or per language.
- 🔴 **Bad:** `transcribeStream` outside a turn or execution scope is refused by the
  gateway by design (`docs/model-gateway-call-sites.md`, gap 9); live audio needs an
  execution scope.
- ⚪ **Neutral:** The adapter writes its requests by hand, because the OpenAI SDK is
  confined to the LLM adapter ([ADR-0083](0083-neutral-llm-contract-and-wire-format-adapters.md)).

## Pros and Cons of the Options

### A — Neutral capability, one provider, guardrails

- 🟢 One consent surface, one brake, swappable vendor.
- 🔴 Coarse: one provider and an in-memory quota.

### B — Per channel plugin

- 🟢 Each channel picks what fits its audio.
- 🔴 Credentials and audio egress in every channel plugin, which ADR-0017 rules out; no
  common limit.

### C — Part of the LLM adapter

- 🟢 Reuses the provider key.
- 🔴 Ties speech-to-text to one LLM vendor and makes egress implicit with the LLM key.

## More Information

- Related: [ADR-0003](0003-capability-based-multi-provider-middleware.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md),
  [ADR-0031](0031-audio-meeting-source-split-from-native-facilitators.md),
  [ADR-0080](0080-embedding-providers-one-active-declared-vector-space.md).
- Paths: `middleware/packages/plugin-api/src/{transcription,transcriptionGuardrails}.ts`,
  `middleware/packages/transcription-adapter-openai/`,
  `middleware/src/routes/adminTranscriptionProvider.ts`, `middleware/src/platform/modelGatewayServices.ts`,
  `middleware/packages/harness-orchestrator/src/tools/transcribeRecordingTool.ts`.
- Tests: `middleware/packages/plugin-api/test/transcriptionGuardrails.test.ts`,
  `middleware/packages/transcription-adapter-openai/test/*`,
  `middleware/test/adminTranscriptionProviderRoute.test.ts`, `middleware/test/transcribeRecordingTool.test.ts`.
