# 0025 — Facilitation contributions and decisions: electorate, quiet recording, consent, repeats

## Status

Accepted

- **Date:** 2026-11-20
- **Deciders:** Owner (byte5); implemented in `omadia-agent-facilitator` (stream F3,
  byte5ai/omadia-agent-facilitator#47 and #50)
- **Scope:** spec B (`specs/2043-native-facilitators/spec.md`) §5.2, §5.3, §5.5, §5.7,
  §5.14; issues #2061 (without the session part) and #2062

## Context and Problem Statement

The "Changes after review (2026-11-18)" of #2061 and #2062 left gaps between the plugin
engine and spec B: the engine read a roster's `partial` flag once at start and never again;
every ballot was echoed in the group; one message could carry one contribution; a tool call
could store a ballot that differs from the message; unanimous early agreement ended a
consent window; a rule change could not touch a closed step; an unreferenced "stop" or
"erledigt" with several processes in one conversation was taken by whichever process got it.
Most of these are plain spec conformance. This record lists where the implementation had to
fill a gap in the spec or deviates from its wording, so that later work does not undo it.

## Decision Drivers

- Spec B §0: the engine lives in the plugin; the kernel only offers contracts.
- Nothing is decided automatically on a list of people the engine cannot verify.
- The chat reads like a colleague's messages: no echo of every vote (owner, §5.14).
- A closed step and its protocol never change.

## Decision Outcome

### Known electorate (§5.5; criteria 35, 44)

- `facilitations.electorate_source` is fixed at start on a **fresh** roster query
  (`fresh: true`, reading `status`): `platform_roster` when it is `complete` and lists at
  least one person, else `declared_list`. Existing rows without a member list, or with
  participants named by the initiator, are migrated to `declared_list`.
- Platform roster: before every automatic completeness or consent decision (a vote closing
  because everybody voted, "everybody agreed", a proposal's window ending without objection,
  a questionnaire everybody answered, the only participant closing, a consent step at the
  deadline) the roster is asked fresh. Anything but `complete` holds the decision; the group
  is told once; the engine retries with the next contribution or reminder, and a held
  proposal also hourly (one retry at a time) until the deadline, where it fails. A `complete`
  answer brings the participants up to date (missed joins and leaves).
- **Gap filled:** where the initiator named a subset of a complete roster, the named list
  stays authoritative: the fresh roster takes over departures, never additions.
- **Gap filled:** a consent *window* ("nobody objected") is held only by a roster that is not
  `complete`; a named person not yet matched, or a declared list nobody declared, does not
  hold it. "Everybody contributed / agreed" needs every waited-for name matched.
- **Gap filled:** the roster call runs inside the facilitation's unit of work (answer and
  decision belong together) and is bounded to 5 s; no answer in time counts as `unknown`.
- Declared list: participant sources `declared`, `named` (named by a participant, added on
  their own message), `posted` (wrote here, welcomed). Nobody is removed by others; no group
  vote on the list. Without any declared names there is no "everybody": votes are evaluated
  at the deadline, and a person who writes takes part without a welcome.
- Final consent of a closing: the plugin's `finalConsentElectorate` (fresh at the window's
  end, hourly, at most 24 h, then `not confirmed` with "participants could not be
  verified") is called by the closing procedure (#2064, ADR 0024).

### Quiet recording without a reaction contract (§5.3, §5.14)

- The spec wants a reaction "where the channel supports reactions, otherwise nothing". The
  kernel has no contract for a facilitator to react to a message (the channel SDK's
  decorations registry even lists `receipt_reaction` as removed). **Decision:** in v1 a
  contribution in the announced format is recorded with no output at all; confirmations,
  edits and deletions are quiet as well. Free-text readings keep their one confirmation
  question; a declined reading keeps its one-line answer. A reaction becomes possible with a
  future kernel contract (own-identity reaction on a stored message), not by a workaround.

### Contributions (§5.1, §5.3; criteria 23, 50)

- A contribution is keyed by message and part index (`part_index`, unique per live part);
  one message may carry several parts; a new revision before the step closes supersedes all
  parts; free-text parts are confirmed in one question. An edit or deletion of a message
  whose step has closed changes nothing (on record as a late change).
- **Content authenticity:** `facilitation_record_contribution` parses the stored original
  text first; if the text is in the announced format, a tool-call ballot that differs (or a
  ballot for invalid text) is refused; a stated revision that is not the latest is refused.
- **Imports on behalf of others:** recorded as `pending_import` for the named person with
  the importer and the stated origin in the payload; they count only after that person
  confirms in their own message (ack kind `import`); status and protocol show the origin.
  A name that matches several participants is refused with the full names.

### Consent (§5.5, §5.7; criteria 24, 31)

- Full early agreement ends neither a proposal's window nor a consent step's window; a
  consent may be withdrawn until the window ends. A consent step has its own window
  (default from `changeWindowHours`, never past the deadline); at its end without a standing
  objection it closes, with one it stays open for moderation.

### One process per message (§5.3; criterion 29)

- In a conversation with several processes of the same facilitator, an unreferenced state
  change ("stop", "erledigt") that more than one process could accept gets exactly one
  question (asked by one process only: the running one, else the one the message reached)
  and changes nothing. A reply to one process's message decides; "stop" in follow-up ends
  only that follow-up.

### Rule change after a closed step (§5.7; criterion 57)

- A change proposal names the steps it affects. A closed affected step is never re-opened:
  the accepted change adds a new step linked to it (`repeats_step_id`) with the new method
  and fresh contributions, opened at once (an open step goes back to pending and resumes
  after it). Decisions of the old step and action items derived from them become
  `pending_repeat`; their owners are told; when the repeat closes they are replaced.

### Ties (§5.5; #2062)

- **Decision:** v1 knows one tie rule, the runoff among the tied options (window default
  12 h, never past the deadline). The spec says the rule is "fixed at start; default:
  runoff" but names no alternative; none is built until one is specified.

### Lifecycle states `following_up` and `ended` (§5.2)

- **Decision:** they are derived, not stored phases: `phase` stays the moderation lifecycle
  up to `closed`/`aborted` (with the partial unique index "one live facilitation per
  conversation" and the scope/reservation rules bound to it), and `following_up`/`ended`
  follow from `followup_state` and `ended_at` (`lifecycleOf`). Storing them as phases would
  duplicate `followup_state` and change every query on `phase` without changing behaviour.
  Status, UI and protocol show the derived state.

### Consequences

- 🟢 **Good:** no automatic decision rests on a list the channel could not confirm.
- 🟢 **Good:** the group sees questions and results, not a receipt per vote.
- 🔴 **Bad:** a contributor gets no visible acknowledgement until a kernel reaction contract
  exists; status on request shows the count.
- 🔴 **Bad:** a fresh roster query per automatic decision costs a platform call (bounded).
- ⚪ **Neutral:** plugin migrations 0008 (electorate), 0009 (contribution parts, imports) and
  0010 (repeat steps).

## More Information

- Plugin `AGENTS.md` summarises these decisions for contributors.
- Related: [ADR-0022](0022-native-facilitators-as-an-archetype-plugin.md),
  [ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md).
