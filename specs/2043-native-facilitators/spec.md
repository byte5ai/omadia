# Native facilitators: impartial moderators as an agent archetype

> **Status: DRAFT for owner sign-off.** This document implements nothing. It defines the
> facilitator as an agent archetype, added to the system by the archetype plugin
> `@omadia/agent-facilitator` (rewritten as 1.0.0, §0), and cuts the work into issues. It builds on
> [`agents-as-virtual-employees`](../2042-agents-as-virtual-employees/spec.md) (cited as
> AVE, invariants INV-1 to INV-11). Terms as defined in
> [`docs/terminology.md`](../../docs/terminology.md).
>
> **Measured against** kernel `origin/main` @ `f727a83c`, `omadia-agent-facilitator`
> 0.6.0 @ `a7c93a1`, `omadia-channel-teams` 0.35.0 @ `e1aacfc`. Reviewed adversarially by
> a second model family (Codex) on 2026-11-18; its findings are incorporated. §12 lists
> what is unverified.

## 0. Owner amendment: an archetype plugin (2026-11-18)

The facilitator is its own agent archetype (AVE §5.10). The archetype is added to the
system by an **archetype plugin**, `omadia-agent-facilitator`, rewritten as 1.0.0. This is
not the old model: the old plugin was a capability attached to a normal agent; the
archetype plugin adds a class of agent whose agents the operator creates and the kernel
runs. As much logic as possible lives in the plugin; the kernel keeps what a plugin
cannot safely own.

| Part | Owner |
|---|---|
| Archetype registry, `agents.archetype` (#2088), enforced omissions, neutrality block, persona bounds (#2060) | Kernel |
| Stored inbound message events with platform-stated author, message id and revision | Kernel, `conversationMessages` service |
| Delivery of every group message for an active facilitation | Kernel subscription and the channel plugins |
| Posting and direct messages as the facilitator's own identity, `no_identity` instead of another bot; allowed targets from reservation and follow-up permissions (#2091) | Kernel |
| Every model turn of a facilitator (privacy shield, model policy, discretion, receipts, budgets, deadlines, kill switch) | Kernel, `agentTurn` service |
| Readiness and session capability registries (#2091) | Kernel, pass-through |
| Tables, lifecycle, contributions, decision methods, scheduler and outbox, transparency, process, visibility, retention, quotas (#2061 to #2065, #2070) | Plugin |
| Sessions, media-adaptive playbook, scoped capabilities (#2076 to #2078) | Plugin, with `omadia-m365-connector` |
| Facilitations view | Plugin UI |
| Facilitators in the agent directory (#2066) | Kernel web-ui |

- Contract: `@omadia/plugin-api` 1.55.0 and `@omadia/channel-sdk` 0.3.0.
- **Bounded timing from the first version:** the plugin runs its own leased scheduler for
  the facilitator's triggers (agent triggers in the sense of AVE §5.12, not plugin jobs).
  Every action needs the kernel's execution authorization (#2090), which carries one of
  bounded scopes. Each scope carries its own deadline, budget **and** the targets it may
  send to, so an action is authorised and addressed by the same scope:

  | Scope | Until | Allowed targets |
  |---|---|---|
  | `configuring` | the handshake is posted (atomic switch to `active`), at most 72 h after the start request (configurable); then `aborted` with a short note | home conversation, linked session conversations in `scheduled`, direct replies to the initiator, private status answers |
  | `active` | the facilitation's deadline; extended only by the bounded deadline wait of §5.6 (then only consent answers to open session summaries, status requests and stop) | home conversation, linked session conversations in `scheduled`, `live` or `confirming`, private reminders to participants, private answers to a participant's status request |
  | `closing` (one per closing event: each session close, entering `concluding`, abort; own id) | the closing procedure of §5.2 (waiting, delivery, confirmation, dispatch), each part with its own limit; absolute limit 30 days after the event | home conversation, the session conversations of this facilitation, the protocol recipients of §5.8, private status answers |
  | `scheduling` | the agreed follow-up meeting's invitations are sent, its date passed, or the facilitation is stopped or aborted | the invitees confirmed by group consent |
  | `follow_up` | the follow-up deadline | the home conversation, the owners of open action items, private status answers |

  "Private status answers" means: the private chat of an active participant who asked the
  facilitator for this facilitation's status there (§5.3), with that status only.

  The scopes exist independently of the reservation and of whether action items exist. An
  expired scope never re-opens moderation. The scheduler can move onto
  agent triggers (#2082) later without changing these guarantees.
- No Teams test tenant is available: contract tests run against a simulated transport,
  plus a manual checklist on a real instance whose results are recorded in the release
  issue (§6.2, §9).
- The data model of §5.1 lives in plugin migrations, except the kernel parts above.
- **Kernel contracts** (versioned in `@omadia/plugin-api`), each with its own issue:
  - `conversationMessages` (#2089): stored inbound events (author, tenant, channel, message id,
    revision, timestamp, platform-stated). An archetype plugin reads and subscribes only to
    conversations its agents hold a reservation or follow-up permission for, plus private
    messages to the facilitator from active participants of a running facilitation,
    limited to status requests and reminder replies (§5.3); foreign
    conversation or message ids and superseded revisions are refused; access ends with the
    reservation or permission. Every read path (single event, list, subscription replay,
    resume, model-context building) is bound to the process id and returns only events
    received while that process held its reservation or permission in that conversation
    (for a session conversation: from its link on); events of an earlier process in the
    same conversation are never returned to a later one.
  - `agentTurn` and execution authorization (#2090): the plugin calls the kernel with agent id,
    process id (facilitation), phase, purpose, emission type and a budget reservation.
    The kernel verifies that the agent has the plugin's archetype, that the process belongs
    to it and is in a phase that allows the action, the deadline, the budget (reserved
    atomically, including helpers and guards) and the kill switch. This covers every
    action of the plugin's scheduler, not only model calls: model-free posts, deliveries
    and checks also need a valid execution authorization with deadline and run counter,
    and stop with the kill switch.
- Where this section and the rest of the spec disagree, this section holds.

## 1. Why this exists

A standard agent has an agenda by design: it works for one or more users and pursues
their interests. That is its purpose. Teams also run processes that need moderation:
decisions, votes, prioritisations, role assignments, retrospectives. A standard agent
can hardly moderate them. The obstacle is not skill but **role and acceptance**. An agent
that switches into a "facilitator mode" may moderate neutrally by construction, but
people know no such thing from working with humans. They distrust it, and a distrusted
moderator cannot fill the role.

omadia therefore has **native facilitators**: a special kind of agent that never serves
one or more users the way a standard agent does. It only moderates, so it never gets into
a conflict of interest, and it is committed to one goal only: a successful moderation.
Like every omadia agent it should feel like an ideal human colleague, here one with a
moderator role (AVE §1).

Two things are broken today, and both must be fixed for the next release:

1. **Facilitators are not entities of their own.** From the user's view they are a
   sub-role: a plugin of kind `agent` that the kernel attaches to an agent as the tool
   `query_facilitation`, auto-provisioned as one fixed agent named "omadia Facilitator",
   speaking through the instance's default Teams bot. An operator can configure standard
   agents with their own name and personality and attach the facilitation plugin to them
   (the manifest allows several instances), but they stay standard agents with a
   moderation tool: no archetype of their own, no enforced neutrality boundaries and no
   reliable own sender for proactive messages.
2. **They do not work in practice.** In a field test (November 2026: four people, ranked
   vote 3/2/1 points, deadline, Teams group chat) the result was right, but the way there
   broke trust: wrong "still missing" messages, reminders after completion, a restart
   because the definition of done could not be changed. §4 traces each failure to code.

Facilitation as a capability plugin attached to a normal agent is conceptually wrong. A
facilitator is like a derived class of an agent, an archetype of its own (§0): it inherits what makes an agent a virtual employee, adds what moderation
needs, and deliberately omits what would make it partial.

## 2. The facilitator archetype

`agents.archetype = 'facilitator'`, registered by the archetype plugin (§0, AVE §5.10). An
operator creates facilitators like agents:
as named virtual employees with a configurable personality, one or several per instance.
One facilitator can run facilitations in several conversations at the same time. The
archetype is fixed at creation: an agent never switches between `standard` and
`facilitator`, so no
facilitator carries memory, grants or loyalties from a former life as a standard agent.

### 2.1 Inherited from agent

- Identity: display name, short and long description, avatar, accent colour.
- Configurable personality: persona axes, culture presets, verbosity, language; within
  the neutrality bounds of §2.4.
- Own channel identities: its own Teams bot via the existing provisioning (#860). A
  facilitator never speaks through another agent's identity.
- Model policy, AI disclosure, audit, speaker stamping, identity guard (AVE §5.5).

### 2.2 What a facilitator does

A facilitator leads a group through a process to an outcome the group owns. Counting
votes is one small tool in that work, not its centre. Its job, like a good human
facilitator's:

| Mode | What it does |
|---|---|
| **Prepare** | Agrees goal, definition of done, format, participants, stakeholders and timeline; drafts the agenda; collects topics and pre-reads from participants ahead of a meeting; sends the agenda in time (§5.4, §6.3). |
| **Design the process** | Proposes a format and agenda that fit the goal; the group confirms or adjusts it (§5.4). |
| **Moderate** | Opens and closes each step; asks open, systemic questions; uses round-robin for important points; invites silent voices by name, appreciatively and never exposing them; keeps dominant voices in balance; mirrors the state through reflective summaries; separates positions from people in conflicts and makes interests visible before options; brings the discussion back to the goal. |
| **Diverge and converge** | Collects ideas, positions and concerns; proposes clusters and summaries for the group to confirm; leads the group to a decision with a method that fits (§5.5). |
| **Keep time and focus** | Holds timeboxes per step, the meeting slot and the overall deadline; parks off-topic points in a visible parking lot and brings the group back to the current step; proposes to close or extend a step. |
| **Run live sessions** | Moderates online and hybrid meetings with whatever the channel offers: live polls, speaking order, hand raises, a visible agenda and timer, balance between people in the room and people remote (§6.3). |
| **Record** | Keeps the protocol: path to the result, decisions with their rationale, open points, insights, and action items with owner and due date. |
| **Close bindingly** | Ends every session and the facilitation with a confirmed summary: decisions, next steps with owner and due date, open points; the group confirms it where the method or the agreed definition of done requires that; otherwise it is published and the facilitation closes. |
| **Report and follow up** | Posts the result to the group, sends the protocol to participants and named stakeholders, schedules agreed follow-up meetings, reports to the initiator, and reminds owners of action items until their due date. |

To do this it has:
- the **facilitation engine** (§5): durable state per facilitation (agenda and steps,
  participants, contributions of every kind, decisions, action items, definition of done
  with versions, protocol), deterministic evaluation, scheduling and reports;
- **group presence:** in a conversation it facilitates, it receives every human message,
  not only messages that mention it (§6.2);
- the **moderation playbook** as fixed core behaviour (the techniques above), tuned by
  the facilitator's personality within the neutrality bounds (§2.4).

### 2.3 Deliberately omitted

| Omitted | Why |
|---|---|
| Business capabilities: plugin, MCP and native tool grants to company data (ERP, CRM, knowledge graph, mail, files). | Information power makes a moderator partial. Only facilitation tools, the roster and the narrow facilitation-scoped capabilities of §5.11 are available. |
| Acting for a user: delegated per-user tokens, "on behalf of" actions. | It serves no one. |
| General memory: recall across facilitations, automatic capture, learning jobs, the agent memory tree (the state and protocol of the same facilitation, including its earlier sessions, stay available). | A moderator who remembers who argued what last time is not neutral. Its only memory is the state and protocol of each facilitation, bound to that facilitation. |
| Assistance outside a facilitation (questions, tasks, 1:1 help). | It is not an assistant. Such requests get a friendly refusal that names what it does. Preparation, facilitation and follow-up messages of its own facilitations are not assistance. |
| Consulting other agents, and being consulted or attached by them (AVE §5.4). | A partial agent behind the facilitator would make it partial; a facilitator inside a partial agent would not be accepted. |
| Being the default agent, identity switching, the fast lane. | Each would let it answer for someone or as someone else. Working modes that add moderation methods (AVE §5.2) are allowed; they never change who speaks. |
| A private channel to the initiator that the group does not know about. | Everything the initiator receives is disclosed to the group (§5.7). |

The kernel enforces every row: grants and consultation grants to a facilitator are refused
at write time; the memory tool, recall, capture and learning jobs are not wired for
`archetype = 'facilitator'`; the routes for default agent and fast lane reject it; the
working-mode routes accept moderation modes and refuse any identity replacement. Which
messages its runtime accepts is decided by the input matrix of §5.3 for each of its
facilitations; anything outside its facilitations gets the refusal or the setup flow.

### 2.4 Neutrality contract

A fixed boundary block is compiled into every facilitator's prompt after the operator's
identity sections and cannot be removed or overridden through identity, instructions or
persona settings:

- no opinion on content; structure the path, the group decides;
- never votes, never weights a contribution, treats every participant the same;
- names who is missing only in neutral form and privately where possible (§5.6);
- discloses the report target and everything sent to the initiator;
- stops on "stop" from the group as announced.

Persona axes stay configurable within bounds that keep the contract credible (for example
no high sarcasm or drama, sycophancy guard on). The kernel validates the bounds; the
identity editor shows them. Operator instructions for a facilitator are checked against
the contract at save time (for example "favour the sales team" is refused).

## 3. Roles in a facilitation

| Role | Who | Rights |
|---|---|---|
| **Facilitator** | One facilitator agent per facilitation. | Designs the process with the group, moderates, records, keeps time, leads to decisions, reports and follows up (§2.2). |
| **Initiator** | The person who starts the facilitation in the group (§5.2). | Sets goal and initial definition of done, agrees format and agenda with the group; may propose changes; receives the report. No extra say over contributions, participants or rules once the facilitation is active. |
| **Participants** | The humans in the conversation (platform roster or declared list at start, §5.5, kept current by membership events). | Contribute, change their own contribution while the method allows, object, propose changes, ask for status, stop the facilitation. |

## 4. Measured ground truth: why it does not work

Kernel paths relative to the kernel repo; plugin paths relative to
`omadia-agent-facilitator`; Teams paths relative to `omadia-channel-teams`.

| # | Defect | Effect in the field test | Evidence |
|---|---|---|---|
| F1 | In group chats Teams drops every message that does not @mention the bot (card actions excepted). It records the conversation and resolves the turn's agent first, then drops the message before the turn is handled or any conversation event is emitted. | Votes without a mention are never seen: wrong "still missing". | Teams `src/teamsBot.ts:890-917` |
| F2 | The facilitator agent is a standard agent; the facilitation tools sit behind `query_facilitation`, a nested sub-agent loop. Progress exists only if the chat model remembers to call `facilitation_progress`. | Stale progress, false nudges. | kernel `middleware/src/plugins/dynamicAgentRuntime.ts:529-614`; plugin `src/toolkit.ts` |
| F3 | Progress is one boolean plus one free-text line (≤1,000 characters); there is no participant or contribution state. | "Who is missing" is guessed by a model. | plugin `src/toolkit.ts:44,273,288` |
| F4 | The hourly assess tick runs in its own session (`conductor:<runId>:<stepId>`) without the chat. | The tick judges a summary, not the conversation. | kernel `middleware/src/conductor/realStepEffects.ts:177-183` |
| F5 | Nudges do not check whether the definition of done is met; they are limited only by the enabled flag, the phase, a 45-minute cooldown after the last progress and a cap of 12. | Reminders after completion. | plugin `src/toolkit.ts:36-41,327-391` |
| F6 | The loop stops after 24 assess rounds (about 24 h at the hourly tick); the deadline exists only as prompt text and TTL. | A vote with a deadline beyond 24 h aborts early. | kernel `middleware/src/conductor/patterns/facilitation.json` (`stepAttempts.moderate < 24`) |
| F7 | A met definition of done waits up to 24 h for the initiator's confirmation; the pattern configures no reminder or initial notice. | No automatic close; the result may never be confirmed. | kernel `facilitation.json` (step `confirm`, `PT24H`); `middleware/src/conductor/awaitWorker.ts:25-30` |
| F8 | The final report is a DM to the initiator role only; the group sees nothing; the DM fails without a prior 1:1 chat with the bot. | The group never sees its result. | plugin `src/reporting.ts:46-48`; Teams `src/teamsGroupPrimitives.ts:276-282` |
| F9 | The definition of done is frozen in the run payload; stop and restart loses the binding and group posting. | Restart needed, then broken. | kernel `middleware/src/conductor/ephemeralRunService.ts`; plugin `src/startTool.ts:135,180,266` |
| F10 | A failed step or TTL expiry ends the run without a report. | The facilitation vanishes. | kernel `middleware/src/conductor/runExecutor.ts:372-390`; `middleware/src/conductor/ephemeralReaper.ts:82-87` |
| F11 | Proactive posts use the default bot (`conversationSend` without `asChannelKey`). | The facilitator is not a distinct sender. | kernel `middleware/src/channels/conversationSendService.ts:55` |
| F12 | `facilitation_start` and `facilitation_status` fall back to the latest facilitation when no conversation id is given (progress, nudge and stop refuse when ambiguous); for `bot_present` the first person who mentions the bot becomes the initiator. | Wrong chat for a start, wrong initiator. | plugin `src/stateStore.ts:253-262`, `src/toolkit.ts:105-121`; Teams `src/teamsBot.ts:700-713` |
| F13 | The persona is seeded once and never updated; the `moderation_style` setting is parsed but used nowhere. | Playbook and style changes never take effect. | plugin `src/setup.ts:46-53`, `src/config.ts` |
| F14 | Ephemeral-run quotas are keyed by the plugin id: by default 3 active runs and 10 starts per hour for the whole instance (configurable). | Several facilitators share one budget. | kernel `middleware/src/conductor/ephemeralRunService.ts:333-349`, `middleware/src/config.ts:421-425` |

The kernel already has the right precedent: **discussions**
(`middleware/src/conductor/discussionService.ts`, `middleware/src/conductor/sayService.ts`)
take the conversation from the inbound turn, keep a bounded transcript in the run, and
post as the agent's own bot (`asChannelKey`), refusing with `no_identity` rather than
borrowing another bot.

## 5. Target design

### 5.1 Data model (plugin migrations; kernel parts per §0)

| Table | Holds |
|---|---|
| `facilitations` | id, facilitator agent id, channel type, conversation id, initiator principal, goal, format, phase, `state_version`, deadline, timezone, reminder policy, follow-up policy, home electorate source (`platform_roster` or `declared_list`, §5.5; sessions store their own), created/closed timestamps, close reason. Unique: one active facilitation per conversation. |
| `facilitation_sessions` | facilitation id, kind (`async` chat phase, `live` meeting), scheduled start and end, meeting reference (channel meeting id), modality (`chat`, `online`, `hybrid`), capability snapshot (§6.1), consent state for audio and video processing, status. |
| `facilitation_stakeholders` | facilitation id, principal or address, role (`receives protocol`, `invited to follow-ups`), added by, confirmed by the group. |
| `facilitation_steps` | facilitation id, position, kind (`open`, `collect`, `discuss`, `cluster`, `prioritise`, `decide`, `assign`, `close`), title, timebox, decision method and options where the step decides, status. The agenda. |
| `facilitation_participants` | facilitation id, scope (`home` or a session id), principal id (authenticated channel user id), display name, source (`roster`, `declared`, `named`, `posted`, `joined`), status (`active`, `left`), changed at, changed by event. |
| `facilitation_dod_versions` | facilitation id, version, text, structured criteria where machine-checkable, proposed by, proposal message id, consent state, effective at. |
| `facilitation_contributions` | facilitation id, step id, participant principal, kind (`idea`, `position`, `concern`, `question`, `proposal`, `vote`, `confirmation`, `objection`, `abstention`, `commitment`), payload validated against the step, source event key (the kernel's inbound event id from #2089: one per message revision, card answer or reaction) and part index (unique together per facilitation), status (`valid`, `ambiguous`, `superseded`, `withdrawn`), recorded at. |
| `facilitation_clusters` | step id, label, member contribution ids, proposed by the facilitator, confirmed by the group (yes/no). |
| `facilitation_decisions` | facilitation id, step id, statement, method, result, rationale, decided at. |
| `facilitation_action_items` | facilitation id, decision id, description, owner principal (confirmed by the owner), due date, status, follow-up reminders sent. |
| `facilitation_events` | append-only protocol of messages posted, reminders, changes, decisions, reports. |
| `facilitation_outbox` | pending channel sends with idempotency key, target, payload, required phase and `state_version`, attempts. |

The 16 KiB run-state blob and the plugin's in-memory store are replaced. State survives
restarts because it lives in these tables.

### 5.2 Lifecycle

```
invited → configuring → active → concluding → closed → following_up → ended
                              ↘ aborted (stop, deadline without result, error)
```

States exist on three levels, each with its own rules:

| Level | States | Ends when |
|---|---|---|
| **Step** (agenda item) | `open` → `closed` (or `extended`) | Its own evaluation (§5.5) or the group closes it; a closed step accepts no further contributions. |
| **Session** (async phase or live meeting) | `scheduled` → `live` → (`confirming`) → `closed`, or `scheduled` → `cancelled` | Its time slot ends or the group closes it; the session summary is posted. Only where the method or the definition of done requires confirmation, the session stays `confirming` for the consent window (§5.7), in which its conversation accepts consent answers, status requests and stop, nothing else. |
| **Facilitation** | as above | `concluding` when the definition of done is met; `closed` after the final summary was published (and confirmed where required); `following_up` while agreed action items are open; `ended` when all are done or overdue, or the follow-up deadline passed. |

- **invited:** the facilitator's bot is in a group conversation. Outside a facilitation the
  facilitator answers questions addressed to it (what it does, how to start) in ordinary
  kernel agent turns under its envelope; these turns hold no process, no reservation and
  no facilitation tools except starting one.
- **configuring:** a person in the group asks the facilitator to start; that person is
  the initiator, and the facilitator says so in the group. The authenticated request
  creates the facilitation in `configuring` and, in the same transaction, takes the
  conversation's reservation and opens a `configuring` execution scope (provisional
  deadline 72 h, configurable, with its budget), so preparation that needs several turns
  survives restarts. A request without goal or deadline is enough: agreeing them is the
  work of this phase. Posting the handshake switches atomically to `active`: phase change,
  the `active` scope with the agreed deadline, and the end of the `configuring` scope. If
  the `configuring` scope runs out, the facilitation ends as `aborted` with one short note
  and releases the reservation. The facilitator agrees goal,
  definition of done, format and agenda, participants and deadline **in the group**, checks
  readiness of its identity in this channel and conversation (Teams: §6.2; other channels:
  §6.4), then posts the opening handshake (§5.7). The conversation id always
  comes from the inbound turn.
- **active:** every inbound human message is processed in the facilitation's own model
  context (§5.3); the scheduler handles time-based events (§5.6).
- **concluding:** the definition of done is met (also when it is evaluated exactly at the
  deadline). In one transaction: contribution and reminder triggers of the active phase are
  cancelled, an immutable result record is written and a `closing` scope for it is opened;
  moderation never re-opens. The closing then runs the closing procedure below. The final
  summary contains decisions, next steps with owners and due dates, and open points. A
  group confirmation is asked only if the method or the agreed definition of done
  requires it (for example consent or a free-text definition of done); otherwise the
  result is published. (#2071 removed confirmation rounds the model added on its own in
  the plugin's definition-of-done verdict; the old pattern's separate initiator
  confirmation step still exists and goes with it, §8.) The facilitation becomes `closed`
  when the closing procedure has set the result status; the reservation is released then.
- **Closing procedure** (for each closing event: a session close, entering `concluding`,
  abort; each in its own `closing` scope, §0). Every part has its own limit, counted from
  the part's start:
  1. *Waiting* (only for the result of `concluding`): until every session closing of this
     facilitation that requires confirmation has ended. Meanwhile the facilitation keeps
     the reservation and accepts only consent answers to those session summaries, status
     requests and stop. Bounded by those session closings' own limits.
  2. *Delivery* of the closing document: at most 7 days.
  3. *Confirmation*, only where required: the consent window (default 24 h, at most 72 h)
     starts when delivery is confirmed, also after the deadline, and follows the group
     consent procedure of §5.7. The consent decision needs a `complete` electorate
     (§5.5): with the platform roster it is queried fresh at the window's end and then
     hourly, at most 24 h; if it never becomes `complete`, the result is `not confirmed`
     with the reason "participants could not be verified".
  4. *Dispatch* of the final protocol to the recipients of §5.8: at most 7 days.

  The result status and the delivery status are separate (§5.11). If delivery fails at
  the end of part 2, the delivery status is `not delivered`, the result status is
  `published` where no confirmation was required and `not confirmed` (reason: not
  delivered) where it was; initiator and operator are told where possible.
  **Stop or abort** ends the closing procedure of every open session atomically: open
  consent windows close, no further consent answers are accepted, an undelivered session
  summary is sent without a consent request and marked `not confirmed` (reason:
  facilitation stopped), and the abort report says so. No consent request is ever sent
  that can no longer be answered. **Sessions at every terminal transition** (entering
  `concluding`, stop, abort, the end of the `configuring` scope, error), in the same
  transaction: a `scheduled` session becomes `cancelled` with one short note in its
  conversation; a `live` session is closed and its summary enters the closing procedure
  (on stop or abort without a consent request); a `confirming` session continues its
  closing procedure (on stop or abort ended as above). The reservation of every session
  conversation and the subscriptions bound to it are released as soon as the session is
  `closed` or `cancelled`; a `confirming` session keeps them at the regular close until
  its confirmation has ended, and loses them at once on stop or abort. Afterwards only
  its `closing` scope may still deliver its closing documents.
  **Only on stop or abort**, in the same transaction, every `scheduling` scope and
  follow-up scheduling grant of the facilitation is revoked and pending invitation jobs
  are cancelled: no further free/busy query, no further invitation. Invitations already
  sent stay; the abort report lists them, and cancelling them is a separate request of
  the initiator. At the regular close agreed follow-up invitations still go out.
  **Stop after `concluding`** applies the same rule to the facilitation's own closing:
  an open final consent window ends, no further answers are accepted, the frozen result
  is delivered (or re-delivered) without a consent request, with result status `not
  confirmed (facilitation stopped)` where a confirmation was required and `published`
  otherwise; no separate abort report is created. A stopped facilitation never enters
  `following_up`: its follow-up grants and reminder jobs are revoked in the same
  transaction, and it goes to `ended` once the result's delivery part has ended. Nothing
  else about the result changes.
- **following_up:** only if action items with owners were agreed; without them the
  facilitation goes from `closed` straight to `ended`. A bounded follow-up context with
  its own deadline: the earlier of (last due date plus a grace period set at start,
  default 7 days) and the instance's follow-up horizon (default 90 days after `closed`;
  due dates beyond the horizon minus the grace period are refused when agreed). `ended_at`
  is stored and its own triggers: reminders to owners before due dates, a status post at the
  agreed time, and acceptance of completion messages from owners (authenticated message in
  the facilitation's home conversation, a card button or a direct reply to the reminder).
  It accepts nothing else, holds only the follow-up grants of §5.11, and revokes them at
  `ended`.
- **Sessions:** within `configuring` and `active`, a facilitation can run asynchronous
  phases in the chat and live sessions (meetings) with their own time slot (§6.3);
  preparation happens before a live session, follow-up after the close.
- **closed / ended / aborted:** result or honest abort report to the group and the
  initiator. The exclusive conversation reservation is released at `closed` (or
  `aborted`), so a new facilitation or discussion can start while follow-up continues;
  follow-up keeps only a non-exclusive permission to remind owners and post status in the
  home conversation, tied to its facilitation id, until `ended`. Protocol retained per
  §5.8.

### 5.3 One model context, authenticated contributions

- Moderation runs in the facilitation's own model context. There is no separate assess
  context that sees only a summary. ("Session" in this spec always means an asynchronous
  phase or a live meeting, §5.2.)
- **Reservation:** a conversation can host one running process at a time; native
  facilitations and agent discussions share one reservation (today
  `conductor_ephemeral_attachments`, unique per conversation). A process releases only its
  own reservation, never an operator binding, and sends only with its own identity to a
  checked target.
- **Conversations:** a facilitation has one home conversation (where it was started).
  A live session may run in another conversation (for example the chat of a scheduled
  Teams meeting): the initiator links it in the home conversation when the session is
  scheduled (in `configuring` or `active`). The link request must come from inside the
  target conversation: a home participant of the facilitation addresses the facilitator
  there with an authenticated message that names the facilitation; that message proves
  the person's membership in the target conversation. A request made only from the home
  conversation, or from someone who is not a home participant, takes nothing and gets
  one short answer. The facilitator then confirms the link in both conversations.
  Readiness of the facilitator's identity is checked for the session conversation itself
  (for Teams the chat-specific permission to read all messages, §6.2) when it is linked
  and again before the session goes `live`; if it is missing, the session does not go
  `live`, the facilitator says what is missing in the home conversation, and the home
  conversation is not affected.
  Linking takes the session conversation's own reservation in the same transaction; if another process (another facilitation or an agent discussion) holds it,
  the link fails and the facilitator says so in the home conversation. The session
  conversation's reservation is released when the session reaches `closed`; its closing
  documents then go out under its `closing` scope. Reading a linked conversation needs
  this reservation. People in the linked
  conversation who are not participants are added as session participants only; they
  see the session agenda and what is posted in that conversation, never the home
  conversation's history or protocol (§5.8).
- **Linked session conversations by session state** (delivery, reading and sending follow the
  same table):

  | Session state | Delivered to and read by the facilitator | Facilitator may send |
  |---|---|---|
  | `scheduled` | Messages addressed to it (link confirmation, questions) | Link confirmation, agenda, preparation |
  | `live` | Every human message | Moderation |
  | `confirming` | Every human message; only consent answers, status and stop take effect | Consent request, status |
  | `closed` | Nothing | Session protocol under the `closing` scope only |

  Contributions to steps are accepted only from `live` sessions and the home conversation,
  as the input matrix below says.
- **One action item per completion.** Within one facilitation, a completion message must
  also map to exactly one action item: through its reply to that item's reminder, an
  explicit reference, or because its author owns only one open item. Otherwise the
  facilitator asks once which item is meant; nothing changes until it is clear.
- **One process per message.** In a conversation where several processes of the same
  facilitator exist (a new facilitation while older ones are in `following_up`), a message
  that changes state ("erledigt", "stop", a consent answer) must map to exactly one
  process: through its reply reference, its card, an explicit reference to the
  facilitation, or because only one process can accept it. If several match, the
  facilitator asks once which one is meant; nothing changes until it is clear.
- **Authorship and content come only from authenticated inbound events.** A contribution is
  recorded by `record_contribution(eventId, revision, parts)`: one inbound event may yield
  several contributions (for example three ideas in one message), each with its part
  index; a repeated call with the same event and revision creates no duplicates; a new
  revision of a message received before its step closes supersedes all parts of the
  earlier revision (clusters are only built after the step closed, so no cluster points
  to a superseded part); free-text parts are confirmed by their author in one question
  listing all parts. The engine takes the
  authenticated actor, tenant, channel, event id, revision, timestamp **and the original
  event content** from the stored inbound event (#2089), never from model arguments. Event
  kinds: a transcript segment from a live session (authenticated media source of that
  session, session id, stable segment id and revision, transcribed text; the recognised
  speaker is only a hint and never authorship: the part is stored unattributed and
  `ambiguous` and counts only when a participant confirms exactly that segment revision
  as theirs by an authenticated message or card; a confirmation by another person or of
  an older revision counts nothing), a text message (original text), a card or poll answer (structured value with the
  card, the proposal id and its version), a reaction (emoji with its target message). For
  text in the announced format the engine parses the original text deterministically; for
  card and poll answers it uses the stored structured value; it refuses a payload that
  differs, never synthesises text from a structured answer, and ignores an answer to an
  outdated proposal version. A reaction confirms an interpretation only if it is the
  author's own reaction on the facilitator's confirmation question for exactly that
  interpretation.
  A payload the model interpreted from free text is stored as `ambiguous` with the
  message's revision and counts only after its author confirms exactly that
  interpretation; a confirmation of an outdated revision is refused. Which messages are accepted in which phase is defined by the input matrix
  below; everything else is refused, in particular messages from other conversations,
  messages from before the facilitation started (for example from an earlier one) and
  messages from people who are not eligible for the step.

  | Input | configuring | active: open step | active: closed step | concluding | following_up |
  |---|---|---|---|---|---|
  | Preparation input (topics, pre-reads, agenda remarks) | accepted | accepted | refused | refused | refused |
  | Contribution or change of one's own contribution | refused | accepted (until the step closes) | refused | refused | refused |
  | Consent answer to an open proposal (§5.7), including a session summary in `confirming` | accepted | accepted | accepted | accepted | refused |
  | Confirmation of the final summary | refused | refused | refused | accepted (where required) | refused |
  | Completion message of an action-item owner: in the home conversation, by card, or as a direct reply to that owner's reminder (bound to the owner, the reminder and the facilitation) | refused | refused | refused | refused | accepted |
  | Change proposal to the definition of done or method | accepted | accepted | accepted | refused | refused |
  | Status request, stop | accepted | accepted | accepted | accepted | accepted in the home conversation and as a reply to a reminder; stop ends only this facilitation's follow-up |
  | Status request in a private chat with the facilitator, from an active participant | accepted | accepted | accepted | accepted | accepted |

  A private message to the facilitator reaches a facilitation only if its author is an
  active participant of exactly one running facilitation of this facilitator (otherwise
  one question which one is meant); only a status request or a reply to a reminder is
  processed there, answered in that private chat with that facilitation's status only.
  The answer follows the asker's participant scope (§5.5, §5.8): a home participant gets
  the facilitation's status including the names of who is missing; a session participant
  gets only the status of the sessions they belong to (agenda, session state, time slot),
  never names, tallies or anything of the home conversation. Several memberships give the
  union of what each scope may see, nothing more; a person who left a scope gets nothing
  of it after leaving. Anything else in the private chat is an ordinary agent turn
  outside the facilitation (§5.2 `invited`). A person who is not an active participant
  gets no status.
- **Edits:** an edited message produces a new revision; the latest revision received
  before its step closes counts, and the facilitator confirms the change to its author.
- **Effect:** a contribution in the announced format counts at once. A contribution the
  facilitator interpreted from free text counts only after its author confirms the short
  reply (a reply or reaction), so a misread can never conclude a facilitation.
- A participant can only make their own contribution. "Anna agrees too", quoted ballots
  and forwarded messages are not Anna's contribution. Contributions on behalf of others
  (for example older votes from a screenshot) count only after the person confirms them
  in their own message.
- Recording is quiet: a contribution in the announced format gets a reaction (for example
  👍) where the channel supports reactions, otherwise nothing. Only a contribution the
  facilitator interpreted from free text gets a short reply to its author to confirm
  ("A > C > B, right?"). No public echo of every vote.
- Ambiguous input triggers exactly one clarifying question to that person; the
  contribution stays `ambiguous` and does not count until resolved.
- The model never computes counts, "who is missing" or whether a machine-checkable
  definition of done is met; the engine does, from the tables.
- Deterministic first (AVE INV-11): reminders, time-keeping posts, status, tallies,
  handshake and protocol assembly are templates filled by the engine without a model; the
  model is used for moderation language, summaries, cluster proposals and understanding
  free text.

### 5.4 Formats and process

A facilitation runs an agenda of steps. The facilitator proposes an agenda that fits the
goal; the group confirms or adjusts it in the handshake. v1 ships these formats as
templates; each is an editable agenda, not a fixed script:

| Format | Typical agenda |
|---|---|
| Decision | open, collect options and positions, discuss, decide, close |
| Prioritisation | open, collect items, cluster, prioritise, close |
| Role or task assignment | open, list items, collect candidates, assign (confirmed by the named person), close (#330 scenario) |
| Idea collection | open, collect ideas, cluster, prioritise, assign next steps, close |
| Retrospective | open, collect what went well and what did not, cluster, discuss, decide actions, assign owners, close |
| Alignment | open, collect positions and concerns, discuss, summarise, confirm by consent, close |

What the engine keeps deterministic, and the model never computes:
- **Participation balance** per step: who has contributed and who has not, so the
  facilitator can invite silent voices at the right moment (privately where the channel
  allows, never exposing anyone) and balance dominant ones.
- **Step progress and timeboxes:** the facilitator closes or extends a step on time and
  says so.
- **Clusters and intermediate summaries** are proposals by the facilitator; they become part
  of the record after group consent (§5.7). Session and final summaries follow the
  conditional rule of §5.2: confirmed only where the method or the definition of done
  requires it, otherwise published.
- **Decisions** are evaluated by the methods of §5.5; **action items** need an owner who
  confirms in their own message and a due date. A group confirmation of a summary
  confirms the account of the result, never a person's acceptance of a task: a nomination
  the named person has not accepted stays an open point ("proposed for Anna, not
  accepted"), gets no reminders and starts no follow-up; only that person's own
  authenticated acceptance turns it into an action item, and only until the result is
  frozen at `concluding`. After that the nomination stays an open point in the protocol;
  the facilitation does not track it (people can start a new facilitation for it).

### 5.5 Decision methods (v1)

Decision methods are used in steps of kind `decide`, `prioritise` and `assign`. The close
rules and the evaluation table below apply to such a step; the facilitation as a whole
concludes when its definition of done is met, usually when its last step is closed. All
contributions in v1 are **open**: participants can see who contributed what, as in
the chat itself. Secret ballots are out of scope for v1.

| Method | Valid contribution | Counting | Tie |
|---|---|---|---|
| Ranked vote | Distinct options with ranks 1..n; partial rankings allowed. | Configurable points per rank (default 3/2/1); missing ranks score 0. Duplicate options or ranks are refused with a hint; an empty ballot is not a contribution. | Fixed at start; default: runoff vote among the tied options. |
| Single choice | One option. | Most votes. | As above. |
| Approval | Any non-empty set of options. | Most approvals. | As above. |
| Consent | Consent or objection with a reason. | Uses the group-consent procedure of §5.7: the step closes only after its window without a standing objection; full early agreement does not end the window, and consents may be withdrawn until it ends. | n/a |
| Assignment | One name per item (for example per role), confirmed by the named person. | Done when every item has one confirmed name. | n/a |

Every method also accepts an explicit abstention, which counts as a contribution and
scores nothing.

**Changing a contribution:** allowed until its step closes. With
the default close rule ("evaluate when every participant has contributed"), the last
contribution triggers evaluation; the alternative close rule "evaluate at the deadline"
keeps changes possible until the deadline, and status shows a provisional result.

**Participation complete is not result valid.** When a step's close rule fires, the engine
evaluates the step and moves on by this table. A pending change proposal (§5.7) always takes
precedence: no evaluation concludes while one is open; the proposal is decided first,
within its window and never past the deadline.

| Evaluation outcome | Next state |
|---|---|
| Clear result (ranked, single, approval) | The step closes with this result; the agenda continues with the next step. The facilitation reaches `concluding` only when its definition of done is met. |
| Tie | Runoff round among the tied options with the same method; deadline = the earlier of the original deadline and the runoff window set at start (default 12 h); at the deadline without a decision: abort report naming the tie |
| Consent window ended without a standing objection | The step closes with the decision; grants derived from it may be issued |
| Consent with a standing objection | Stays `active`; the facilitator moderates the objection and puts an amended proposal; at the deadline: abort report with the objection |
| Assignment with an unconfirmed name | Stays `active` until the named person confirms or declines; at the deadline: abort report naming the open items |
| Free-text definition of done | Group consent on "the definition of done is met" (§5.7), then the facilitation goes to `concluding` |

**Eligibility per step:** every step declares its electorate: by default the active `home`
participants; a step run inside a live session may declare the session participants
instead. Session-only participants never count as missing for home steps. Membership is
tracked per scope: leaving a meeting chat ends only the session membership, never the home
membership.

**Known electorate.** Automatic completeness ("everyone has contributed") and consent
decisions need a complete, current participant list from one of two sources, fixed at start:

- **Platform roster:** the channel's roster query, asked with `fresh: true` (bypassing any
  cache; Teams caches it for 5 minutes today, `src/teamsRoster.ts:39`) and returning
  `complete`, `partial` or `unknown` with its time (#2091). Teams today returns an empty or
  partial list on errors (`src/teamsRoster.ts:85`, `src/teamsGroupPrimitives.ts:256` in
  `omadia-channel-teams`); that counts as `partial` or `unknown`. Before every automatic
  completeness or consent decision the engine queries it fresh; if the answer is not
  `complete`, no automatic decision is taken, the facilitator says so once and retries at
  the next contribution or reminder.
- **Declared list:** if the platform roster is not `complete` at start, the initiator names
  the participants while the facilitation is `configuring`. The facilitator posts the list
  in the conversation; anyone in it can name a missing person, who is added when that
  person confirms by an authenticated message; a person who posts an authenticated
  message in the conversation and is not on the list is added and welcomed. Removal only
  by the person's own leave (or the platform's leave event). No group consent is needed,
  because adding is never blocked and nobody is removed by others.

The source is fixed per participant scope and never changes within it: the home scope
fixes it at start; every linked session scope fixes its own when it is linked (the session
conversation's platform roster if `complete`, otherwise a declared session list named by
the home participant who linked it, posted in the session conversation, with the same
adding rules). Home participants are never changed by a session's list.

**Membership changes:** a person who joins the conversation becomes a participant and is
welcomed with the current state; a person who leaves becomes `left`, their contribution
stays counted, and both changes are announced. "Every participant" means every `active`
participant.

### 5.6 Time, reminders and concurrency

- Timing runs on the agent trigger mechanism of AVE §5.12: a hook on new messages in the
  facilitation's conversation, timers for time-keeping only while a live session runs,
  wakeups for reminders and follow-ups; all bound to the facilitation and ending with
  it, each with deadline and budget.
- The scheduler runs from the facilitation's deadline, not from a round count.
- Reminder policy default: deadline minus 24 h and minus 2 h; configurable per
  facilitator and per facilitation; announced in the handshake.
- A reminder goes out only if a step is waiting for contributions and the phase is
  `active`. In the group it is neutral ("two contributions are still open"); the people
  who are missing are reminded by direct message where the channel allows it.
- Step timeboxes: when a step's timebox ends, the facilitator summarises and proposes to
  close or extend it; the group decides.
- Action-item follow-up runs in the `following_up` context of §5.2, with its own triggers
  bound to that context, not to the active phase.
- At the deadline the engine closes with the state at that moment: a result if the
  definition of done allows it, otherwise an honest abort report. Order at the deadline:
  first every `live` session is closed and its closing procedure opened; then the engine
  decides whether to wait. **Exception, bounded:**
  if session closings that require confirmation are still open at that point, the
  `active` scope is extended until they have ended (bounded by their own `closing`
  limits); meanwhile only consent answers to those summaries, status requests and stop
  are accepted, nothing else changes. Then the definition of done is evaluated once with
  their outcomes: met → `concluding`; not met (for example a summary `not confirmed`,
  also for an unverifiable electorate or a failed delivery) → abort report naming it. Nothing ends silently:
  a failed step, an exhausted retry budget or TTL expiry produces an abort report.
- **Two kinds of outbox entries.** *State-bound messages* (reminders, prompts, status
  posts) carry the required phase and `state_version`; a send re-checks both, and a stale
  entry is dropped or recomputed from the current state, never sent. *Closing documents*
  (session summary or protocol, result, abort report) are immutable: they carry their
  closing event id, document version and `closing` scope instead, and are retried while
  that scope is valid, whatever the moderation's current `state_version`; recipients are
  re-checked at every send (§5.8).
- **Concurrency:** contribution, phase and definition-of-done changes are atomic
  transactions that bump `state_version`. Inbound messages are idempotent by message id
  and revision. Scheduler jobs run under a lease.
- **Serialisation point:** every state change and every send of a facilitation runs under
  a per-facilitation lock (database advisory lock on the facilitation id). A send
  re-checks phase and `state_version` under the lock and holds it until the channel call
  returns; a contribution arriving meanwhile waits. The guarantee is therefore exact: a
  reminder is never sent **after** the contribution that makes it obsolete was committed.
  If the send took the lock first, the reminder goes out and the contribution is processed
  right after it; the facilitator then confirms the contribution, so nobody is left
  confused.
- **Delivery classes:** channels give no exactly-once guarantee (the Teams adapter
  reports `delivered` once `sendActivity` returns, `src/teamsGroupPrimitives.ts:285-287`
  in `omadia-channel-teams`). Every send is recorded in `facilitation_outbox` before the
  call. *Droppable* messages (reminders, nudges) are at-most-once: an attempt with unknown
  outcome after a crash is never retried. *Essential* messages (handshake, result, abort
  report) are at-least-once: retried until confirmed, accepting a rare duplicate.

### 5.7 Transparency, reporting and rule changes

- **Opening handshake** in the group, short and natural, like a human facilitator opening
  a meeting: who it is, the goal, how the group will get there (format, method, deadline),
  who receives the result, and that anyone can ask for the rules or the status or stop it
  at any time. The full rules (definition of done, tie rule, reminder times, follow-up)
  are given on request or where they matter, not as a block of status.
- **Status** on request at any time: phase, how many contributions are open, current (or
  provisional) tally where the method has one, deadline, definition-of-done version. In
  the group the facilitator never names who is missing, also on request; a home
  participant who asks in a private chat with the facilitator gets the names (session
  participants get only their sessions' status, §5.3). Who has contributed is
  shown only where the method's visibility makes contributions public anyway.
- **Result** goes to the group first, then to the initiator with the protocol (only if
  the initiator is still an active participant at send time). The
  initiator receives nothing the group was not told about. A machine-checkable result
  needs no extra confirmation by the initiator; a free-text definition of done is
  confirmed by the group (consent) before closing.
- **Group consent** (one procedure for everything the group must agree to: agenda, clusters,
  intermediate summaries, summaries where required, stakeholders, follow-up meetings,
  changes to the definition of done or method): a versioned proposal with its electorate
  (the eligible participants of the scope, §5.5), posted in the conversation; it passes
  when no eligible participant objects within its window (set at start, default 12 h,
  never past the deadline; shorter for a live session, default 5 minutes; the confirmation
  of a session or final summary uses its own window inside that event's `closing` scope
  instead and may end after the deadline, see §5.2; the evaluation at the deadline waits for
  open session closings as defined in §5.6); objections and
  agreements count only from authenticated messages or card answers; an objection blocks
  until it is resolved; withdrawing a consent before the window ends is allowed. A model's
  statement that "the group agrees" never counts. Grants of §5.11 are issued only from a
  passed consent record.
- **Changes to the definition of done or the method:** anyone may propose. A proposal
  names the steps it affects. A closed step is never re-opened: if the change affects
  it, the group decides with the change whether that step is repeated; a repeat is a new
  step linked to the old one, with the new method and fresh contributions, while the old
  step and its protocol stay unchanged and its old contributions never count in the new
  step. Results derived from the old step (decisions, assignments, action items) are
  marked "pending repeat" and are replaced by the new step's outcome when it closes;
  owners of items that no longer hold are told. The
  facilitator puts the proposal to the group as a consent decision: it takes effect when
  no active participant objects within the window set at start (default 12 h, never past
  the deadline), and it is announced with its new version. An objection is moderated like
  any other. Contributions stay valid unless the change affects them; the facilitator
  names who needs to act again. Owner decision **OD-F2**.

### 5.8 Visibility and retention

| Who | Sees |
|---|---|
| Active participants | Everything of the facilitation: handshake, contributions, status, protocol. |
| Participants who left | What was posted while they were members; nothing after. |
| Initiator | The same as participants, plus the report, as long as they are an active participant. Leaving the conversation ends the initiator role: later contributions and the report are no longer sent to them; the group is told. |
| Session-only participants | The session agenda and what was posted in the linked session conversation; the session summary. |
| Confirmed stakeholders | Only the facilitation protocol with its result status and next steps sent to them (§5.11), filtered per recipient by discretion (AVE §5.11): the filter works on whole, separately labelled parts of the protocol (decisions, next steps, contributions, summaries); a model-written summary carries all labels of its turn, so if the recipient may not know one of them, the summary is withheld as a whole or regenerated from permitted parts only. A note that something was left out appears only where the recipient's disclosure level is at least `existence`; with `none` there is neither content nor a hint. Recipients are re-checked at every send; a participant who left is no longer a recipient. |
| Other users | Nothing. |
| Operator | Facilitation metadata (facilitator, conversation, phase, counts, timestamps). Contents and protocol only through an audited access with a stated reason. |

Facilitation records and protocol are deleted after a retention period set per instance
(default 90 days), counted from `ended` or `aborted`, never from `closed`, so follow-up is
never cut short. The effective deletion time is the later of that end and the end of
every scope of the facilitation that is still running (`closing`, `scheduling`,
`follow_up`); plugin tables, outbox and the kernel's stored events use this same
computation, and the settings view shows the effective time. The follow-up horizon is capped by an instance setting (default 90 days
after `closed`); an action item with a due date beyond it is refused visibly when it is
agreed, not accepted silently; the result summary in the chat stays where the
channel keeps it.

### 5.9 Neutrality in the runtime

- Facilitators run without business capabilities and without general memory (§2.3),
  enforced at grant and wiring time.
- The neutrality block (§2.4) is compiled by the kernel after the operator's sections and
  cannot be shadowed.
- The facilitator's tools are the engine's tools only: propose and adjust the agenda,
  open and close steps, record contribution, propose cluster or summary for confirmation,
  ask clarification, invite a silent voice, post to group, remind, record decision,
  record action item, propose and decide changes, status, close, abort.

### 5.10 Quotas

Quotas are per facilitator and per instance (active facilitations, starts per hour,
messages per facilitation), configurable, with defaults that let several facilitators
work in parallel. Reaching a quota produces a `system` notice in the conversation.

### 5.11 Facilitation-scoped capabilities

A facilitator holds no business capabilities (§2.3). Closing and following up still need
two narrow capabilities, granted by the kernel to `archetype = 'facilitator'` only and bound to
one facilitation:

| Capability | Allowed | Never |
|---|---|---|
| **Protocol dispatch** | Send the session protocols and the facilitation protocol of this facilitation, each only to its own recipients and visibly marked with its result status (published, confirmed, not confirmed with the objection, or abort report), and its agreed next steps to its participants and confirmed stakeholders, through the channel or mail. | Send anything else, to anyone else; read mailboxes. |
| **Follow-up scheduling** | Read free/busy (no event details) of participants and confirmed stakeholders for the follow-up meetings the group agreed; create the invitations with agenda and protocol link. | Read calendar contents; change or cancel other events; invite people the group did not agree on. |

**Two kinds of protocol.** A *session protocol* covers one session; its recipients are
that session's participants and the home participants; stakeholders never receive it. The
*facilitation protocol* is the final protocol of the whole facilitation; its recipients
are the home participants and the confirmed stakeholders, and it is dispatched only at the
facilitation's close or abort. Protocol dispatch (above) sends each kind only to its own
recipients.

**Result status** of a final protocol (either kind): `published` (no confirmation required), `confirmed`
(consent window passed without a standing objection, with a verified electorate), `not
confirmed` (with its reason: standing objection, participants could not be verified, not
delivered, or facilitation stopped) or `aborted` (abort report). **Delivery status** is
separate: `delivered` or `not delivered`, per document. A protocol is *final* when its
result status is set; *dispatchable* means final and inside its `closing` scope. All
statuses are sent to the same recipients (§5.8), each visibly marked with its reason;
nothing is ever marked confirmed that was not.

Both run on the instance's existing integrations (for Microsoft 365 the M365 connector)
under facilitation-scoped grants with an explicit lifecycle, independent of whether action
items exist:

| Grant | Issued when | Allows | Revoked when |
|---|---|---|---|
| Protocol dispatch | That session's or the facilitation's protocol becomes final (published, or its confirmation window ended), or the facilitation aborts | Sending that protocol to the recipients of §5.8, within the `closing` scope of the same event | All sends of that protocol are confirmed, or 7 days after it became final (a failed send is reported to the initiator) |
| Follow-up scheduling | The group agreed a follow-up meeting | Free/busy and invitations for exactly that meeting | The invitations are sent, the agreed date passed, or the facilitation is stopped or aborted |
| Follow-up reminders | The facilitation enters `following_up` | Reminders to owners and status posts | `ended` or stop |

Every use is audited and listed in the protocol. Pending sends survive restarts through the
outbox (§5.6).

## 6. Channels, meetings and media

### 6.1 Media-adaptive moderation

What a facilitator can perceive and do is limited by the channels and media the instance
offers, not by the facilitator. It uses what is technically available and adapts its
moderation to it; when access to channels or media grows, its active moderation grows
with it, without changes to the facilitator itself.

- Every session has a **capability snapshot**, declared by the channel and media plugins
  through one contract (the `MeetingSource` abstraction of #330 and #584), and refreshed
  when it changes during a session:

  | Inputs | Outputs |
  |---|---|
  | text messages with author; reactions; poll and card answers; presence and join/leave; hand raise; transcribed speech with speaker attribution; shared documents | text posts; cards and live polls; private messages; a visible agenda, timer or parking lot (pinned message, tab or whiteboard); spoken voice; screen or whiteboard content |

- The playbook maps each moderation technique to the best available means, for example:
  live vote as a poll card if cards exist, otherwise as chat ballots; time-keeping as a
  spoken cue if voice output exists, otherwise as a post and a visible timer; speaking
  order through hand raises if available, otherwise through a round-robin list in the
  chat.
- Where it matters for the session, the facilitator says in one natural sentence what it
  can perceive (for example "I follow the chat and the polls, not the call itself"), so
  nobody assumes more.
- A missing capability is never an error of the facilitator: it chooses the next best
  means and says what it cannot do.

### 6.2 Teams (first channel)

- **Own identity required:** a facilitator needs its own Teams identity (#860
  provisioning); without one it cannot start a facilitation and says so. No default-bot
  fallback.
- **Message delivery** follows the input matrix and the session-state table of §5.3: in
  the home conversation the facilitator's bot receives every human message while the
  facilitation is `configuring`, `active` or `concluding`; in linked session conversations
  as the session state says (`scheduled`: messages addressed to it; `live` and
  `confirming`: every human message; `closed`: none). The mention gate is lifted for that
  bot in exactly these cases. In `following_up` the gate is back on; owners reach the
  facilitator by mention, card button or direct reply to a reminder. This needs the app installed in that chat with RSC
  `ChatMessage.Read.Chat` consented there; the manifest request alone is not enough.
- **Readiness check at start:** the facilitator verifies installation and RSC consent in
  the chat and its ability to post; if something is missing it says exactly what and
  does not start.
- **Proactive posts** go out as the facilitator's own bot (`asChannelKey`) and support
  @mentions.
- **Direct messages** use conversation references stored per bot; first contact needs
  the app installed for the user. Where that is not possible, reminders stay neutral in
  the group and the facilitator says so.
- **Contract tests** run against a simulated Teams transport (no test tenant is available,
  §0): message without mention, missing consent, first-contact DM, blocked DM, restart, two
  facilitator bots in one chat. Before release the same scenarios are checked manually on a
  real instance with a written checklist, and the results are recorded in the release
  issue.

### 6.3 Online and hybrid meetings

A facilitation can contain live sessions (meetings) between asynchronous phases:
preparation before, follow-up after.

- **Preparation:** the facilitator drafts the agenda, collects topics and pre-reads in the
  chat, proposes timeboxes, and sends the agenda before the meeting.
- **During the session:** agenda and timer where the channel has a native place for them
  (pinned message, meeting tab), otherwise mentioned naturally in the moderation; opening
  with goal and rules in a few sentences, speaking
  order, focus moderation with a parking lot, live polls, reflective summaries per step,
  balance between people in the room and people remote (remote voices are asked first
  when a room dominates).
- **Binding close:** a summary of decisions, next steps with owner and due date, and open
  points, confirmed by the group only where the method or the definition of done requires
  it; then protocol dispatch and follow-up scheduling (§5.11).
- **Authorship in live sessions:** a vote or commitment counts when it comes through an
  authenticated input (poll, card, chat message) or when its owner confirms the protocol
  entry. Contributions recognised from speech are recorded as unconfirmed until then.
- **Consent for audio and video:** processing of a call's audio or video starts only after
  the facilitator announced it in the session and no participant objected; anyone can
  stop it at any time. Raw audio and video are not stored; only the protocol is kept.
  Operators can require explicit consent per participant (for example for works-council
  agreements).
- **Teams first:** meeting chat and cards are the baseline; presence, hand raises,
  in-meeting surfaces and real-time audio follow as the Teams plugin supports them (#584
  for audio). Which Teams APIs deliver which input or output is evaluated in the Teams
  issue and not assumed here.

### 6.4 Other channels

Facilitation must not work only in Microsoft Teams (AVE §5.14, channel parity). Slack,
Discord and Telegram are part of the same release scope as Teams, each with its own issue:
- one identity (bot or app) per facilitator, so the facilitator appears as its own
  colleague;
- delivery of every human message in a facilitated group to the facilitator's bot;
- every function through plain text: contributions and votes as chat messages, polls as
  native polls where the channel has them, otherwise as text ballots; reactions where
  available.

Which platform setting delivers all group messages (for example a bot's privacy mode in
Telegram, message-content access in Discord, event scopes in Slack) is evaluated in each
channel issue and not assumed here. Where a channel cannot meet a requirement, the gap is
documented there with the closest available behaviour, and the facilitator says in the
chat what it cannot do.

## 7. Operator and user surfaces

- **Operator UI:** "Facilitators" next to "Agents" in the agent directory: create, name,
  avatar, personality within bounds, language, default methods and reminder policy,
  Teams identity. The facilitations view shows which facilitator runs each facilitation,
  its phase and counts; contents only through the audited access of §5.8; terminate.
- **Users** see the facilitator as its own colleague in the channel: own name, own icon,
  its own handshake. An initiator starts a facilitation by adding a facilitator to the
  group and asking it there.

## 8. Migration

There are no customer installations yet (owner, 2026-11-18), so nothing is migrated or
kept compatible.

- The plugin `omadia-agent-facilitator` is rewritten as 1.0.0, an archetype plugin (§0).
  It is not archived; byte5ai/omadia-agent-facilitator#17 changes accordingly.
- The old Conductor path goes: the `facilitation` pattern (whatever its version, v6 since
  #2071), `facilitationAdmin`, the `facilitation-` scoped roles, the old panel and the
  facilitator use of `agentProvisioning.ensureAgent`. Kernel services other features use
  (ephemeral runs, discussions, `say`) stay.
- Internal test instances drop their auto-provisioned facilitator agent and create
  facilitators through the new flow.
- Issues #8 to #16 in `omadia-agent-facilitator` are closed as superseded.

## 9. Acceptance criteria

1. **Field scenario (decision format with a vote).** Facilitator "Mira" in a Teams group with four people, ranked vote
   3/2/1, deadline three days out. All four vote, two without mentioning the bot: every
   vote is recorded (a vote in the announced format gets a reaction or nothing; a vote
   interpreted from free text gets one short confirmation question to its author); status names the missing people correctly
   after every vote; the fourth vote concludes the facilitation; no reminder is sent
   afterwards; the result is posted in the group and sent to the initiator; a middleware
   restart between the second and third vote changes nothing. End-to-end test with a
   simulated Teams channel and a fake clock.
2. **Deadline.** Same setup with three votes: one reminder at deadline minus 24 h (the
   missing person addressed privately, the group neutrally), one at minus 2 h, honest
   close at the deadline; no abort before.
3. **Races and delivery.** Both orders of the last vote and a due reminder are tested: vote
   committed first, no reminder is sent; reminder sent first, the vote is processed right
   after and confirmed to its author. A crash after commit and before send: an essential message is
   sent after restart, a reminder is not. A lost send confirmation: the result is retried,
   a reminder is not. Last vote and deadline at the same time: one evaluation, one report.
4. **Authorship and currency.** "Anna agrees too" from Bert records nothing for Anna; a
   quoted or forwarded ballot records nothing; a tool call with a foreign message id, a
   non-participant's message or a message from before the facilitation started is
   refused; an edited ballot counts in its latest revision; a ballot interpreted from free
   text counts only after its author confirms the echo.
5. **Methods and evaluation.** Table-driven tests for every method and every row of the
   evaluation table in §5.5: full and partial ranking, duplicate option, empty ballot,
   abstention, change before conclusion, tie with runoff and runoff timeout, consent with
   objection, assignment confirmed and declined, a pending change proposal blocking
   conclusion.
6. **Ambiguity.** An ambiguous ballot gets exactly one clarifying question and is not
   counted until resolved.
7. **Definition-of-done change** without restart: proposal, consent window, objection
   blocks, success announced with version, survives restart.
8. **Membership.** A participant who joins mid-way is welcomed and counted; one who
   leaves keeps their contribution and is no longer "missing"; an initiator who leaves
   before the end receives neither later contributions nor the report.
9. **Several facilitators.** Two facilitators with different names and personalities in
   two chats at the same time, and one facilitator in two chats at the same time: every
   post comes from the right bot, state never crosses facilitations.
10. **Omissions.** Granting a business plugin, a consultation grant or a memory tool to a
    facilitator is refused; a 1:1 request for help gets the refusal; the same person in
    two facilitations is never referred to across them.
11. **Visibility.** A user who is neither participant nor confirmed stakeholder cannot read
    a protocol; a stakeholder receives only the final protocol with its result status, filtered by
    discretion; a participant who left receives nothing sent after leaving; operator
    content access is audited.
12. **No silent end.** A failed step or reached TTL produces an abort report in the group;
    a reached quota produces a `system` notice.
13. **Teams contract tests** of §6.2 pass against the simulated transport, and the manual
    checklist on a real instance is recorded as passed; the field scenario (criterion 1)
    also passes in Slack, Discord and Telegram through plain text.
14. **Retrospective.** A four-person retrospective: ideas collected without mentions,
    clusters proposed and confirmed by the group, two actions decided, each with an owner
    who confirmed and a due date; the protocol lists decisions with rationale and the
    action items; the owner is reminded before the due date.
15. **Assignment (#330 scenario).** Five roles, each ends with exactly one name confirmed
    by that person; a declined nomination reopens the role.
16. **Silent voices and balance.** In a discussion step (`discuss`), a participant who has not
    contributed is invited (privately where possible) before the step closes; nobody is
    named in the group as not having contributed, also not when someone asks for the
    status in the group; the same question in a private chat gets the names.
17. **Timebox.** When a step's timebox ends, the facilitator summarises and the group
    decides to close or extend; no step closes silently.
18. **Online meeting with chat and cards only.** Agenda drafted and sent before the meeting,
    topics collected in the chat, a live poll as a card during the session, time-keeping
    posts and a parking lot, a binding close with next steps confirmed by the group, the
    protocol sent to participants and two stakeholders, a follow-up meeting created from
    free/busy; the handshake says the facilitator does not hear the call.
19. **Adaptation.** The same facilitation gains transcribed audio mid-session (simulated
    capability change): the facilitator announces it, waits for consent, then records
    spoken contributions as unconfirmed until confirmed; no restart.
20. **Scoped capabilities.** The facilitator cannot read calendar contents or mailboxes and
    cannot invite people the group did not confirm. Each grant ends at its own revocation
    event of §5.11, tested directly at that event, also without action items and after a
    restart: the scheduling grant when the invitations are sent or the date passed, the
    dispatch grant when sends are confirmed or after 7 days, the reminder grant at
    `ended`.
21. **Multi-step and follow-up.** A prioritisation step closes with a winner and the
    agenda continues to an assignment step instead of concluding; after `closed`, a
    restart, and an owner's later completion message in the home conversation, the
    owner's pending reminder is not sent and the status post shows the item done.
22. **Meeting chat.** Preparation in group chat A, live session in meeting chat B linked
    from A, follow-up in A: contributions from B count during the session only; a person
    only in B never sees A's history.
23. **Content authenticity.** A tool call with a genuine message id but a ballot that differs
    from the message's text is refused; a confirmation of an interpretation of an older
    revision is refused.
24. **Group consent.** A model statement that the group agrees issues no grant and changes
    no record; one objection within the window blocks the proposal; consent passes after the
    window without objection.
25. **Execution scopes.** After the facilitation's deadline no moderation action runs, but
    the abort report is still delivered within the `closing` scope, also after a restart
    during delivery; a later follow-up reminder runs within the `follow_up` scope.
26. **Follow-up horizon.** Without action items the facilitation goes from `closed` to
    `ended`; a due date beyond the horizon minus the grace period is refused when agreed;
    a due date just inside it is followed up and retention starts at `ended`.
27. **Closing and session confirmation.** An abort without action items still delivers the
    abort report to the home conversation in `closing`, also after a restart; a session
    summary that needs consent is confirmed in its linked conversation after the slot
    ended while the facilitation stays `active`, and a late vote there is refused.
28. **Follow-up replies.** One facilitator follows up two facilitations for the same
    person; each direct reply completes only the action item of its reminder, and a stop
    in reply to one reminder ends only that facilitation's follow-up.
29. **Session paths and process correlation.** In each of Teams, Slack, Discord and
    Telegram: the link is confirmed in the session conversation before the session starts;
    a consent answer without a mention after the slot ended counts; a late vote is
    refused; stop works during `confirming`. With two facilitations in `following_up` and a
    new one active in the same conversation, an unreferenced "stop" or "erledigt" gets one
    question and changes nothing until answered.
30. **Stakeholder filter and completion mapping.** A mixed protocol is sent to stakeholders
    with disclosure levels `full`, `existence` and `none`: `full` gets all parts it may
    know, `existence` gets a note that something was left out, `none` gets neither content,
    derived summaries nor a hint. One owner with two open action items writes an
    unreferenced "erledigt": neither item closes, one question is asked.
31. **Consent step and closing scopes.** All participants agree early to a consent
    decision and one objects before the window ends: the step stays open and no grant is
    issued. Two sessions close during the same active facilitation: each protocol is sent
    under its own `closing` scope with its own 7-day limit, independently, also across a
    restart.
32. **Result at the deadline.** A valid result evaluated exactly at the deadline, and a
    failed send shortly before the deadline followed by a restart after it: the result is
    published, no moderation re-opens, no abort is needed.
33. **Structured inputs.** A card answer without text counts; a manipulated answer value is
    refused; another person's reaction confirms nothing; an answer to an outdated proposal
    version changes nothing.
34. **Final confirmation after the deadline.** A result that needs confirmation is reached
    exactly at the deadline and delivered after a restart: the confirmation window starts
    after delivery; without a standing objection at its end the facilitation closes
    confirmed (also when nobody answers), with a standing objection it closes "not
    confirmed"; moderation never re-opens. The `closing` scope stays valid while the
    window runs, also when all sends were confirmed at once; a last session ending exactly
    at the facilitation's deadline gets its summary window; a delivery confirmed one hour
    before the 7-day limit still gets its full window, and the protocol dispatch to
    stakeholders after the window's end still runs, including a retry after a failed first
    send and a restart in between; nothing is sent after the absolute limit.
35. **Unknown roster.** With a partial roster at start the initiator's declared list is
    used; a missing person named by someone else and confirming is added, a person posting
    without being on the list is added, and the completeness decision counts both. With
    the platform roster, a join event missed within the roster cache's lifetime is found
    by the fresh query before the next automatic decision; a fresh query answering
    `partial` blocks the automatic decision until a later query is `complete`.

36. **Preparation.** A first request without goal or deadline ("help us prepare a
    retrospective") opens `configuring` with reservation and scope; a preparation over
    several turns survives a restart; the handshake switches to `active` atomically; an
    abandoned preparation ends `aborted` with one note after its 72 h and frees the
    conversation; a question to the facilitator outside a facilitation is answered without
    taking a reservation.
37. **Acceptance stays personal.** The group confirms a final summary (or stays silent)
    while a named owner has not accepted their task: the task stays an open point without
    reminders, also after a restart; an acceptance by that owner before `concluding` turns
    it into an action item; an acceptance after the result is frozen changes nothing and
    the facilitator says so once; with only unaccepted nominations the facilitation goes
    from `closed` to `ended`.

38. **Closing documents survive later changes.** A session protocol send fails at
    `state_version` 10; contributions and a phase change follow; after a restart the same
    protocol version is delivered; a reminder computed before the changes is not sent.
39. **Private status and result status.** An active participant asks for the status in a
    private chat without a prior reminder and gets it; a non-participant gets nothing; a
    participant of two running facilitations is asked which one. Stakeholders receive a
    published, a confirmed, a not-confirmed and an aborted protocol, each marked with
    its status.

40. **Pending session confirmation at the close.** A session summary that needs
    confirmation fails to deliver; the facilitation's definition of done is met
    meanwhile; after a restart the summary is delivered and an objection arrives within
    its window: the objection counts, the session closes "not confirmed", only then the
    final summary goes out; the same with and without action items.
41. **Private status in every phase.** A participant who is neither initiator nor owner of
    an action item asks privately in `configuring`, `active`, `concluding` and
    `following_up` and gets the status each time.

42. **Closing limits.** A session summary is delivered one hour before its 7-day limit
    while the facilitation is already `concluding`; its full window runs; afterwards the
    final summary is delivered and dispatched within its own limits, also with a restart
    in between.
43. **Stop during closing.** Session close, failed send, stop, restart: the session summary
    goes out without a consent request, marked "not confirmed (facilitation stopped)"; the
    same with a window already open: later answers are refused; nothing is ever
    confirmed automatically after a stop.
44. **Unverifiable electorate and failed delivery.** Complete roster at start, roster
    permanently `partial` at the end of a final window without objection: result `not
    confirmed` (participants could not be verified) after the bounded retries. A result
    that never gets delivered has delivery status `not delivered` and result status
    `published` or `not confirmed (not delivered)`.

45. **Linked session in preparation.** A meeting chat is linked before the handshake,
    confirmed and prepared there, also across a restart; a second process linking the
    same chat at the same time, or a chat held by an agent discussion, gets neither the
    reservation nor read access.
46. **Session guest status.** An active session-only participant asks privately "who is
    still missing?" and gets only their session's status, no names, tallies or goals of
    the home conversation; a home participant gets the full answer; a person with both
    memberships gets each scope's part; after leaving, nothing more.
47. **Stop before invitations.** A follow-up meeting is agreed, its invitations not yet
    sent; stop and restart: no free/busy query and no invitation follow; the abort report
    is delivered and lists any invitations already sent.

48. **Link authorization.** An initiator who is not a member of the target conversation
    cannot link it, even with the facilitator's bot installed there: no reservation, no
    messages; a link requested by a home participant inside the target conversation
    works, also across a restart and against a concurrent link attempt.
49. **Sessions at the end.** With sessions in `scheduled`, `live` and `confirming`, each
    followed by a restart: on stop, the end of the `configuring` scope or an error,
    scheduled sessions are cancelled, live ones closed and every session conversation is
    free at once; at the regular close, scheduled ones are cancelled, live ones closed,
    and a `confirming` session's conversation becomes free only after its confirmation
    has ended (criterion 51). In all cases the ended process receives no new messages
    after the release.
50. **Several contributions per message.** A message with three ideas becomes three
    contributions that land in different clusters; a retry creates no duplicates; an edit
    before the step closes replaces exactly that message's parts.

51. **Session confirmation across the close.** A session summary awaits confirmation when
    the facilitation reaches `concluding`; after a restart an objection in the session
    conversation counts; only then is that conversation free again.
52. **Stop during the final closing.** Stop before the final summary is delivered and
    during its consent window, each followed by a restart: no unanswerable request, no
    later automatic confirmation, exactly one result document with status `not confirmed
    (facilitation stopped)` and no abort report next to it; a pending follow-up invitation
    survives a regular close but not a stop.
53. **No reading across processes.** Two facilitations one after another in the same
    conversation with old events still stored: the second gets none of the first's events
    on any read path; the first can still resume its own closing. Overlap: F1 is in
    `following_up` while F2 runs in the same conversation; a completion message or status
    request clearly bound to F1 changes only F1 and appears neither in F2's event list,
    replay nor model context, also after a restart. The process mapping applies before
    delivery, replay and model-context building.
54. **Session electorate.** A session with an unknown roster is linked during `active`
    while the home scope uses the platform roster: its declared session list is used for
    its decisions and confirmation; home participants stay unchanged.
55. **Stakeholders.** A confirmed stakeholder receives an agreed invitation and the final
    protocol but no contributions, status or anything else of the running facilitation.

56. **Stop with action items.** Confirmed action items exist, stop arrives during
    `concluding`, restart, clock moved past every reminder time: the result is delivered,
    no follow-up starts, no reminder is sent, the facilitation is `ended`.

57. **Change after a closed vote.** The vote is closed and assignment runs; the group
    changes the voting method: a linked repeat step opens without a restart, old votes do
    not count, the decision and assignments derived from it are "pending repeat" until the
    repeat closes and are then replaced; affected owners are told.
58. **Agent disabled or deleted.** A facilitator is disabled, and another deleted, while
    processes are in `configuring`, `active`, `concluding` and `following_up`; after a
    restart and re-enabling: no reservation is left, no model call or invitation follows,
    each process is `aborted` with its reason, the `system` notice appears, and nothing
    resumes.

59. **Definition of done waits for the last session.** The definition of done requires the
    confirmed protocol of the last session, which ends exactly at the deadline: with
    consent → result; with an objection, a permanently unknown roster, or a failed
    delivery → abort report naming it; each also after a restart.
60. **Session readiness.** The home conversation is ready; the linked meeting chat
    receives mentions but lacks permission for all messages: the session does not go
    `live` and the home conversation is told; after the permission is granted, the
    session runs including contributions without mention. The same per transport
    adapter (Teams, Slack, Discord, Telegram).
61. **Retention and open scopes.** Retention of one day, a failed closing send, restart, a
    later successful attempt inside the `closing` scope: nothing is deleted early; after
    all scopes ended the data is deleted.

62. **Spoken contributions.** A transcript segment attributed by speaker recognition to
    the wrong person does not count when that person or someone else confirms it; a
    confirmation of an older segment revision counts nothing; the right person's
    confirmation creates exactly one valid contribution, also after replay and restart.
63. **Session protocol vs facilitation protocol.** A first session closes while the
    facilitation continues: its participants get the session protocol, stakeholders get
    nothing; only the facilitation's close dispatches the facilitation protocol to them.

## 10. Work breakdown

Each item becomes one issue in epic #2043; the owner (kernel or plugin) of each part is
given in §0.

1. Facilitator archetype (`agents.archetype = 'facilitator'`): data model, enforced omissions (grants, memory, assistance,
   consultation, default, persona, fast path), neutrality block and persona bounds (§2).
2. Facilitation engine: tables, lifecycle, one model context, authenticated contributions
   (§5.1-5.3).
3. Moderation process: formats as agenda templates, steps and timeboxes, participation
   balance and silent voices, clusters and summaries confirmed by the group, decisions
   and action items, protocol, action-item follow-up (§2.2, §5.4, §5.6).
4. Decision methods and deterministic counting (§5.5).
5. Scheduler, outbox and concurrency: deadline-based reminders and close, no silent end
   (§5.6).
6. Transparency: handshake, status, results to group and initiator, consent-based rule
   changes (§5.7).
7. Visibility, retention and quotas (§5.8, §5.10).
8. Operator UI for facilitators and the facilitations view (§7).
9. Removal of the plugin path: Conductor pattern, provisioning, roles (§8).
10. End-to-end and race acceptance suite (§9).
11. `omadia-channel-teams`: all messages for an active facilitator, readiness check,
    proactive posts as own bot with mentions, per-bot DM references, contract tests against
    a simulated transport plus a recorded manual checklist (§6.2).
12. `omadia-agent-facilitator`: rewrite as archetype plugin 1.0.0 (§0, §8).
13. Meetings: sessions, preparation, live moderation, binding close (§6.3).
14. Media-adaptive moderation: capability snapshot contract and playbook mapping (§6.1,
    with #584 for audio).
15. Facilitation-scoped capabilities: protocol dispatch and follow-up scheduling (§5.11);
    M365 connector scopes in `omadia-m365-connector`.
16. `omadia-channel-teams`: Teams meetings for facilitators (meeting chat, cards and live
    polls, presence, later audio) (§6.3).

## 11. Owner decisions

**Decided by the owner (2026-11-18), all as recommended:**
- OD-F1: a facilitator needs its own channel identity before it can facilitate; no
  default-bot fallback.
- OD-F2: anyone may propose a change to the definition of done or the method; the group
  decides by consent within a window; the facilitator announces the new version.
- OD-F3: private reminders by direct message where the channel supports them; the group
  only gets neutral reminders.
- OD-F4: retention after close is an instance setting, default 90 days.
- The facilitator archetype is delivered by an archetype plugin (§0).

## 12. Not verified

- What Teams shows the initiator for an open Conductor human step today (F7).
- Whether RSC `ChatMessage.Read.Chat` consent can be obtained in every customer tenant
  without admin involvement.
- Field-test logs were not available; §4 derives every defect from code.

## 13. Related

#330 (original facilitator epic, plugin model, `MeetingSource` abstraction), #584 (audio meetings and transcription, part of this epic), #860
(per-agent Teams identity), #1018 (agent-to-agent in chats), #1035 (communication
profile), `discussionService` (native precedent), `omadia-agent-facilitator` #8 to #16.
