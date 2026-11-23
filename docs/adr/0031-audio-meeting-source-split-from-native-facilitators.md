# 0031 — Audio meeting source split from the native facilitator epic

## Status

Accepted

- **Date:** 2026-11-22
- **Deciders:** Owner (decision of 2026-11-22); recorded by stream G2 (#2068)

## Context and Problem Statement

Spec B (`specs/2043-native-facilitators/spec.md`) lists #584 as "audio meetings and
transcription, part of this epic" (§6.1, §6.3, §10 item 14, §13). #584 plans an audio
meeting source: a sidecar joins the meeting as a tenant user with its own licence per agent
and transcribes live with GPT-Live-Transcribe. That needs tenant accounts, licences and a
real-time audio path, none of which the rest of epic #2043 depends on. Should epic #2043 wait
for it?

## Decision Drivers

- Media-adaptive moderation (§6.1) is built so that a facilitator uses whatever a session
  offers. Its moderation grows when a channel or media plugin offers more, and the
  facilitator itself does not change.
- The kernel side of audio already exists. `transcription@1` (`plugin-api`
  `src/transcription.ts`, with cost guardrails) is the speech-to-text capability. The
  capability snapshot per session (#2077, `sessionCapabilities.ts`) has the input
  `transcribed_speech`.
- Tenant users, licences and live audio are an operational and commercial question of their
  own, not a gap in the facilitator.

## Decision Outcome

- **#584 is taken out of epic #2043** and becomes a follow-up project of its own: the audio
  meeting source (sidecar as tenant user, own licence per agent, GPT-Live-Transcribe).
- **Epic #2043 closes without it.** Spoken contributions (§5.3, §6.3; criteria 19 and 62) are
  already handled for any source that delivers transcribed speech. They are recorded as
  unconfirmed until their speaker confirms, and speaker recognition never sets authorship
  (ADR 0026).
- **What a source has to do:** an audio meeting source declares `transcribed_speech` in the
  session's capability snapshot and delivers its segments through the existing contract,
  with `transcription@1` for speech-to-text. The facilitator, the engine and the kernel
  contract do not change for it.
- Wherever spec B names #584 as part of the epic (§6.1, §6.3, §10 item 14, §13), read it
  as a follow-up project from now on. This ADR takes precedence over those mentions.

### Consequences

- 🟢 **Good:** epic #2043 is not blocked by tenant accounts, licences or a real-time audio
  path; audio arrives later as a source plugin, and nothing in the facilitator has to change.
- 🔴 **Bad:** until the audio source ships, live meetings are moderated through chat, cards
  and whatever transcript the channel offers; there is no live listening.
- ⚪ **Neutral:** no code, migration or plugin-api change; `transcription@1` and the snapshot
  contract stay as they are.

## More Information

- #584 (audio meeting source), #2043 (epic), #2077 (session capability snapshot),
  ADR 0026 (spoken contributions, authorship).
