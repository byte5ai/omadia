# 0287 — The audio meeting source is part of the Teams channel plugin and joins as the agent's own tenant user

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers. Design record for #584 Workstream S (wave 6, W36).
  Nothing is built with it; it waits for the owner's confirmation of the licence and join
  questions below.

## Context and Problem Statement

[ADR-0031](0031-audio-meeting-source-split-from-native-facilitators.md) took the audio
meeting source out of epic #2043. What a source has to do is fixed: declare
`transcribed_speech` in the session's capability snapshot and deliver attributed segments
through the existing contract, using `transcription@1` for speech-to-text. The kernel side
is on main (`transcription@1`, the OpenAI realtime and batch adapters, `TranscribeOpts`
hints, `transcribe_recording`).

Not decided: how the agent gets into a live Teams meeting, as whom, how speech is
attributed, and where the code lives. Recorded findings in #584:

- ACS Call Automation cannot join a Teams meeting by link (spike S1, 2026-08).
- The only official raw-audio path without a browser is the Graph application-hosted media
  bot: C#/.NET on Windows Server.
- The owner chose (2026-08-21, 2026-09-02) the ACS Calling SDK in a headless-Chromium
  sidecar on Linux, joining as a Teams user of the tenant, not as an ACS guest.

## Decision Drivers

- An agent is a colleague with its own identity on each channel
  ([ADR-0012](0012-agents-are-virtual-employees.md),
  [ADR-0134](0134-agents-own-bots-on-channels.md)); people should see *which* agent is in
  the meeting.
- Speaker recognition never sets authorship; spoken contributions stay unconfirmed until
  their speaker confirms ([ADR-0026](0026-facilitation-sessions-linked-conversations-and-spoken-contributions.md)).
- Audio processing starts only after the facilitator announced it and no participant
  objected; anyone can stop it at any time; operators can require explicit consent per
  participant; raw audio is not stored (spec 2043 §6.3).
- Transcription runs only through the model gateway
  ([ADR-0017](0017-model-gateway-and-execution-contexts.md)); transcripts pass the privacy
  shield before any model call.
- Cost per meeting and per agent must be bounded and visible.

## Considered Options

Identity:

- **I1 — One tenant user per agent** (own Teams licence, name and avatar from the agent).
- **I2 — One shared service user** for all agents.
- **I3 — ACS guest identity** (shown as external, waits in the lobby).

Attribution:

- **T1 — Mixed stream plus dominant-speaker events** (one transcription session).
- **T2 — Per-participant streams** (one session each, about 6× the cost).

Placement:

- **P1 — In `omadia-channel-teams`**, next to the agent's Teams identity chain.
- **P2 — Its own plugin** (`omadia-audio-meeting-teams`).

## Decision Outcome

Chosen options: **I1, T1, P1** (recommended; owner confirmation pending for I1's licence
cost and for the join trigger).

- **The agent joins as its own tenant user.** The Teams identity chain of ADR-0134 gets one
  more step: a provisioned tenant user per agent that has meeting audio enabled. Only agents
  the operator enables for meetings get one, so licences are bought per agent, not per
  instance. I2 stays the documented fallback for tenants that refuse per-agent licences; it
  cannot show which agent is present and is not the default.
- **Join only on invitation; consent follows spec 2043 §6.3.** The agent sees meetings it is
  invited to (Graph change notifications on its calendar) and joins at meeting start without
  capturing audio. In the meeting chat it announces that it will transcribe (in a
  facilitated session the facilitator makes this announcement). Audio capture starts only
  when no participant objected within the objection window, or, where the operator requires
  it, after every participant consented explicitly. Any participant can stop it at any time
  with a chat command; the agent then stops capturing and says so. Raw audio is not stored.
  Calendar auto-join with immediate capture is not offered.
- **Sidecar on Linux.** A headless-Chromium sidecar with the ACS Calling SDK joins via the
  meeting link, captures remote audio as PCM and hands frames to the plugin over localhost.
  The Windows media bot is not used.
- **Attribution T1 first.** One mixed stream, speaker from the SDK's dominant-speaker and
  participant data. The seam stays neutral so T2 or a diarising provider can be added as a
  configuration later. Segments are attributed, never authored (ADR-0026).
- **Hints from the session.** Roster names, goal and domain terms go into
  `TranscribeOpts.keywordHints` and `context`.
- **Guardrails.** Duration cap per meeting (the facilitation TTL), minute quota per agent,
  minutes in the run trace; the agent leaves when the meeting ends or the cap is reached.
- **Output is text.** The agent writes into the meeting chat. Speaking (TTS) is a separate
  decision and not part of this record.
- **Storage.** Persisted segments are append-only, timestamped and attributed, hashable per
  segment ([ADR-0285](0285-proof-inclusion-ships-as-the-omadia-proof-plugin-on-the-receipt-chain.md)).

Gating spikes before any build: S1' (headless join and audio capture in a real meeting),
S4' (WebRTC egress from Fly and the Azure VM), A-S1 (delegated token for the agent's tenant
user without interactive login), S3' (participant id to roster mapping).

### Consequences

- 🟢 **Good:** People see the agent by name in the participant list; no "external" label, no
  lobby wait.
- 🟢 **Good:** Facilitator, engine and kernel stay unchanged (ADR-0031).
- 🔴 **Bad:** One Teams licence per meeting-enabled agent.
- 🔴 **Bad:** A headless browser sidecar is heavy (memory, Chromium updates) and depends on a
  client SDK Microsoft may change.
- 🔴 **Bad:** T1 attribution degrades on crosstalk; facilitated meetings are its best case.
- ⚪ **Neutral:** Follow-ups: spikes as issues, then a spec in the channel-teams repository.

## Pros and Cons of the Options

### I1 — Tenant user per agent

- 🟢 Matches ADR-0012/0134: one identity per agent per channel.
- 🔴 Licence cost per agent.

### I2 — Shared service user

- 🟢 One licence.
- 🔴 Every agent appears as the same person; breaks ADR-0134's identity model.

### I3 — ACS guest

- 🟢 No licence.
- 🔴 Shown as external, lobby admission every time, cannot post into the meeting chat as
  itself.

### T2 — Per-participant streams

- 🟢 Exact attribution.
- 🔴 About six times the transcription cost; the per-participant path needs the Windows media
  bot.

### P2 — Own plugin

- 🟢 Smaller Teams plugin.
- 🔴 Splits the agent's Teams identity chain across two plugins.

## More Information

- Issue: [#584](https://github.com/byte5ai/omadia/issues/584)
- Related: ADR-0031, ADR-0026, ADR-0134, ADR-0017, ADR-0012; spec
  `specs/2043-native-facilitators/spec.md` §6.1, §6.3.
