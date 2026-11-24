# 0026 — Facilitation sessions: linked conversations, binding close and spoken contributions

## Status

Accepted

- **Date:** 2026-11-20
- **Deciders:** Owner (byte5); spec author iret77
- **Refines:** [ADR-0022](0022-native-facilitators-as-an-archetype-plugin.md) for sessions
  (spec 2043 §5.2, §5.3, §6.1, §6.3; issues #2076, #2077, #2089)

## Context and Problem Statement

A facilitation runs asynchronous phases in its home conversation and live sessions
(meetings). The spec's review changes (2026-11-18) require that a session may run in its
own conversation (the chat of a scheduled Teams meeting), that people only in that chat
never see the home conversation, that the link is authorized from inside the target, that
reading follows the session's state, that every agreed session ends bindingly, and that
speech never sets authorship. Before this decision sessions ran only in the home
conversation, `endSession()` posted no summary, `confirming` was never written, and spoken
contributions were attributed to the transcript's speaker name by a model tool.

Which parts does the kernel guarantee, which does the plugin own, and how do spoken
contributions get an author?

## Decision Drivers

- Plugin-first (ADR-0022): the kernel keeps only what a plugin cannot safely own.
- Read access to a conversation is the most sensitive thing a plugin is handed; it must
  follow the session state, not the plugin's goodwill.
- Authorship comes only from authenticated inbound events (spec §5.3).
- Restart-safe, idempotent, one closing model for sessions and facilitations (F2's
  result status model).

## Considered Options

- **A — Kernel holds the session state of a session reservation and enforces the read
  table; link requests are typed kernel events; the plugin runs sessions, closings and
  transcripts**
- **B — The plugin chooses subscription modes per session** (the state before: the plugin
  could read `all` in a session conversation whose session had not started)
- **C — A separate kernel "session" entity with its own lifecycle**

## Decision Outcome

Chosen option: **A**.

| Part | Owner |
|---|---|
| Session state of a `session` reservation (`scheduled`, `live`, `confirming`, `closed`, `cancelled`) and its transitions; `live` only with the conversation's readiness for every message (criterion 60) | Kernel, `executionAuthorization.setSessionState` (migration 0107) |
| Read table: `scheduled` addressed, `live`/`confirming` all, `closed`/`cancelled` none; reservation released at `closed`/`cancelled`; sending into a released session conversation only from a `closing` scope, in `confirming` only consent/status/stop | Kernel hub and execution service |
| Link request: a mention in a conversation no process of the agent reads goes to the archetype plugin as a typed `LinkRequest` (not stored, no read access); a session conversation is reserved only with such a request from exactly that conversation (criterion 48), atomically with its scope targets (criterion 45) | Kernel, `conversationMessages@2.onLinkRequest`, `reserveConversation({ linkRequestId })` |
| Superseded revisions marked on every read path (`superseded`, `latestRevision`) | Kernel hub |
| Which facilitation a link names, home-participant check, session choice, confirmations in both conversations, readiness checks at link and before `live`, session participants, guest status | Plugin `sessionLinks.ts`, `privateMessages.ts` |
| Binding close per session: frozen summary as closing event `session:<id>` in the closings table, `confirming` only where the method or definition of done requires it, consent window from delivery, sessions at every terminal transition | Plugin `sessionClose.ts` |
| `transcript_segment` consumption: participant-bound source → that principal is the author, counts after confirming exactly that revision; shared source → unattributed, adoption of exactly that revision recorded as "adopted from the transcript" | Plugin `transcript.ts` |

Details:

- The kernel guarantees that a link request was made inside the target conversation by
  the stated author; whether that author may link (an active home participant naming the
  facilitation) and the readiness check at link time are the plugin's. Before `live` the
  kernel checks readiness itself.
- Of the sending table the kernel enforces the released states (only a `closing` scope)
  and `confirming` (consent, status, stop, essential and protocol messages); in
  `scheduled` and `live` the plugin keeps to the table.

- A process takes back its own **home** conversation after losing the reservation without a
  link request, never after an operator released it; the link requirement is for session
  conversations.
- The kernel answers the turn of a link request with the plugin's short answer (for
  example the refusal of a guest), so the facilitator's model never improvises it.
- An ad-hoc meeting nobody scheduled or linked (D26) ends silently as before; every agreed
  or linked session ends with its summary.
- The session confirmation window survives the facilitation's conclusion and close
  (criterion 51); stop or abort ends it at once with `not confirmed (facilitation stopped)`
  and re-sends the document without a consent request.
- `facilitation_record_spoken` is removed: a model naming a speaker is exactly the
  speaker recognition the spec forbids as authorship.

### Consequences

- Good: reading a meeting chat is bounded by the kernel; a plugin cannot read `all` in a
  scheduled session or anything after its close.
- Good: one closing model (F2) for session protocols and facilitation results.
- Bad: no channel produces `transcript_segment` events yet (Teams has no real-time audio
  in this instance, #584); spoken contributions are exercised with a simulated source.
- Session electorate (spec §5.5), added 2026-11-20 in the plugin (migration `0011`): a
  linked session fixes the source of its member list when it is linked (the meeting chat's
  roster if `complete`, otherwise a declared list); members include home participants who
  are in the chat. A step run inside a live session may declare that session's participants
  as its electorate (only before any contribution); then they alone count, guests included,
  and people only at home are not eligible. Session-only participants never count for home
  steps; leaving the meeting chat ends only the session membership. Before an automatic
  decision of a session step the session's roster is asked for fresh. No kernel contract
  was needed: the existing `conversationRosters` service answers for any conversation.
- The media consent of a linked session (spec §6.3) is asked in its chat and decided by the
  session's members; anyone there, a guest too, can object or stop listening.

## More Information

- Spec: `specs/2043-native-facilitators/spec.md` §5.2, §5.3, §6.1, §6.3, criteria 3, 22,
  38, 45, 46, 48, 49, 51, 59, 60, 62.
- Kernel: `middleware/src/execution/sessionConversationStore.ts`,
  `middleware/src/channels/linkRequestRouter.ts`,
  `middleware/src/channels/conversationMessages/sessionReadTable.ts`,
  `middleware/src/channels/conversationMessages/supersededMarks.ts`, migration
  `0107_session_conversations.sql`, plugin-api 1.81.0.
- Plugin `omadia-agent-facilitator`: migration `0008_session_conversations.sql`,
  `src/engine/sessionLinks.ts`, `sessionClose.ts`, `transcript.ts`.
