# 0024 — Facilitation closing procedure, result status and retention

## Status

Accepted

- **Date:** 2026-11-20
- **Deciders:** Owner (byte5); spec author iret77; implemented in `omadia-agent-facilitator`
  (stream F2: #2064, #2078, #2065, #2063, #2070)
- **Supersedes:** —

## Context and Problem Statement

Spec B §5.2 (changes after review, 2026-11-18) defines one closing procedure for every
closing event (a session close, entering `concluding`, an abort): waiting, delivery,
confirmation where required, dispatch, each with its own limit inside an absolute limit of
30 days. Every final protocol carries a result status, kept apart from its delivery status.
Retention counts from `ended`/`aborted` and never deletes what a running closing still
sends. The plugin before this change had one 30-minute confirmation window, closed as soon
as the result was posted, sent stakeholders the participants' protocol, and counted
retention from `closed`.

How does the engine run that procedure deterministically and across restarts, and where
did the spec leave room that the implementation had to fill?

## Decision Drivers

- Moderation never re-opens after `concluding`; nothing is ever marked confirmed that was not.
- Closing documents are immutable and survive later state changes and restarts (§5.6).
- Plugin-first: no new kernel contract unless a plugin cannot own it.
- Session closings (F1) and the facilitation closing use one model.

## Considered Options

- **A — One `closings` table per closing event, driven after every delivery and on every tick**
- **B — Keep the closing in the facilitation row (phase plus flags)**
- **C — Kernel-side closing service**

## Decision Outcome

Chosen option: **A**, in the plugin (migration 0007, `src/engine/closing.ts`,
`src/engine/resultStatus.ts`).

- **Model.** One row per closing event (`result`, `abort`, `session:<id>`) with the frozen
  document and its `document_version`, the current part (`waiting`, `delivery`,
  `confirmation`, `dispatch`, `done`), its limits, the result status (`published`,
  `confirmed`, `not_confirmed` + reason `objection` / `electorate_unverified` /
  `not_delivered` / `stopped`, `aborted`) and the delivery status (`pending`, `delivered`,
  `not_delivered`). Outbox rows of closing documents carry `closing_id` and
  `document_version` instead of a `state_version`; they are dropped only by their closing's
  limits (absolute 30 days; dispatch 7 days from the protocol becoming final).
- **When confirmation is required.** Only a free-text definition of done closed on request
  with more than one participant requires the group's confirmation of the final summary. A
  machine-checkable result and a closing asked for by the only participant are `published`.
  The former `dod_met` consent proposal during `active` is replaced: the facilitation
  concludes and the summary is confirmed inside the closing.
- **Confirmation.** The window (setting `final_confirm_window_hours`, default 24, capped at
  72) starts when the delivery is confirmed. It is decided only at its end, never earlier
  (withdrawing a consent stays possible): a standing objection → `not confirmed
  (objection)`; otherwise the electorate is verified fresh (F3 `finalConsentElectorate`),
  retried hourly for at most 24 h, else `not confirmed (participants could not be verified)`.
  Only consent answers, status and stop are taken in `concluding`.
- **Failed delivery** closes the facilitation `closed` (not `aborted`) with delivery status
  `not delivered` and result status `published` or `not confirmed (not delivered)`; the
  initiator gets the report where possible, the operator a log line and an event.
- **Stop after `concluding`.** The facilitation becomes `closed` (`close_reason = stopped`);
  open windows end; the frozen result is delivered again as document version 2, without a
  consent request, marked `not confirmed (facilitation stopped)` or `published`. No abort
  report, no follow-up, no follow-up invitation. An operator terminate in `concluding` is a
  stop; only the kernel ending the process (agent disabled, deleted, plugin removed) aborts.
- **Abort** opens its own closing (`aborted` from the start) and dispatches its protocol like
  a close; the report lists invitations already sent.
- **Status in the group** gives counts only; a private request by a home participant gets the
  names. After the close the contributors are named (the protocol every participant received
  lists them anyway).
- **Personal acceptance.** A nomination its owner has not accepted at the freeze is an open
  point, never an action item; a later "yes" bound to the nomination is answered once.
- **Stakeholder discretion.** The protocol is built from labelled parts (`protocol`, `talk`,
  `contribution`). Disclosure per stakeholder (`full`, `existence` default, `none`, set when
  the group confirms the stakeholder): `full` knows `protocol` and `talk` (summaries,
  clusters, participants), the others only `protocol` (decisions, next steps, open points,
  header with status). Contributions never go to a stakeholder. A note about withheld parts
  appears from `existence` up. Each stakeholder gets their own mail; the mail job runs
  whenever a confirmed stakeholder receives the protocol, also without `protocol_mail_enabled`.
- **Follow-up and retention.** Follow-up ends at the earlier of last due date + grace
  (`followup_grace_days`, 7) and the horizon (`followup_horizon_days`, 90 after `closed`);
  later due dates are refused when agreed. `ended_at` is stored; retention counts from it.
  The effective deletion time is the later of the retention end and the end of every open
  closing and scope; nothing is purged while one runs. The facilitations view shows it.
- **Quotas.** `facilitator_limits` (`mira: active=5, starts=10; rita: messages=200`) gives
  single facilitators their own limits; the instance limit applies to all together.

### Consequences

- 🟢 **Good:** Every closing event follows the same deterministic, restart-safe procedure;
  F1 uses the same table and module for session protocols.
- 🟢 **Good:** No new kernel contract was needed; grants stay bound to the closing scope,
  which ends with its closing.
- 🔴 **Bad:** A free-text close now keeps the facilitation `concluding` for the window
  (24 h by default) and an objection closes it `not confirmed` instead of re-opening it.
- ⚪ **Neutral:** Session-only participants' visibility, per-session closing scopes and the
  deadline wait for open session closings (criteria 46, 59, 63 session part) are delivered by
  F1 on this model; the result already waits for open session closings (`waiting`).

## Pros and Cons of the Options

### A — Closings table

- 🟢 Immutable documents with version, limits per part, one model for sessions and result.
- 🔴 One more table and an after-dispatch step on every delivery.

### B — Facilitation row

- 🟢 No migration.
- 🔴 Cannot hold several closing events (sessions) or versions; the former cause of
  "closed when posted" and retention from `closed`.

### C — Kernel service

- 🔴 Against plugin-first; the kernel would need to know facilitation documents.

## More Information

Spec B `specs/2043-native-facilitators/spec.md` §5.2, §5.6, §5.7, §5.8, §5.10, §5.11, §9
criteria 16, 20, 26, 30, 34, 37–40, 42–44, 47, 52, 55, 56, 61, 63. Plugin PRs
byte5ai/omadia-agent-facilitator#44, #46 and the closing PR.
