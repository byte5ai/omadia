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
| Archetype registry, `agents.archetype`, enforced omissions, neutrality block, persona bounds (#2060) | Kernel |
| Stored inbound message events with platform-stated author, message id and revision | Kernel, `conversationMessages` service |
| Delivery of every group message for an active facilitation | Kernel subscription and the channel plugins |
| Posting and direct messages as the facilitator's own identity, `no_identity` instead of another bot | Kernel |
| Every model turn of a facilitator (privacy shield, model policy, discretion, receipts, budgets, deadlines, kill switch) | Kernel, `agentTurn` service |
| Readiness and session capability registries | Kernel, pass-through |
| Tables, lifecycle, contributions, decision methods, scheduler and outbox, transparency, process, visibility, retention, quotas (#2061 to #2065, #2070) | Plugin |
| Sessions, media-adaptive playbook, scoped capabilities (#2076 to #2078) | Plugin, with `omadia-m365-connector` |
| Facilitations view | Plugin UI |
| Facilitators in the agent directory (#2066) | Kernel web-ui |

- Contract: `@omadia/plugin-api` 1.55.0 and `@omadia/channel-sdk` 0.3.0.
- **Bounded timing from the first version:** the plugin runs its own leased scheduler, but
  every model call goes through the kernel's `agentTurn`, which enforces the
  facilitation's deadline, budget and the instance kill switch (AVE §5.12); every
  plugin job carries a deadline bound to its facilitation. The scheduler can move onto
  agent triggers (#2082) later without changing these guarantees.
- No Teams test tenant is available: contract tests run against a simulated transport,
  plus a manual checklist on a real instance whose results are recorded in the release
  issue (§6.2, §9).
- The data model of §5.1 lives in plugin migrations, except the kernel parts above.
- **Kernel contracts** (versioned in `@omadia/plugin-api`), each with its own issue:
  - `conversationMessages`: stored inbound events (author, tenant, channel, message id,
    revision, timestamp, platform-stated). An archetype plugin reads and subscribes only to
    conversations its agents hold a reservation or follow-up permission for; foreign
    conversation or message ids and superseded revisions are refused; access ends with the
    reservation or permission.
  - `agentTurn` and execution authorization: the plugin calls the kernel with agent id,
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
   speaking through the instance's default Teams bot. Nobody can create a named
   facilitator with its own personality, let alone several.
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
| General memory: cross-session recall, automatic capture, learning jobs, the agent memory tree. | A moderator who remembers who argued what last time is not neutral. Its only memory is the state and protocol of each facilitation, bound to that facilitation. |
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
| **Participants** | The humans in the conversation (roster at start, kept current by membership events). | Contribute, change their own contribution while the method allows, object, propose changes, ask for status, stop the facilitation. |

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
| `facilitations` | id, facilitator agent id, channel type, conversation id, initiator principal, goal, format, phase, `state_version`, deadline, timezone, reminder policy, follow-up policy, created/closed timestamps, close reason. Unique: one active facilitation per conversation. |
| `facilitation_sessions` | facilitation id, kind (`async` chat phase, `live` meeting), scheduled start and end, meeting reference (channel meeting id), modality (`chat`, `online`, `hybrid`), capability snapshot (§6.1), consent state for audio and video processing, status. |
| `facilitation_stakeholders` | facilitation id, principal or address, role (`receives protocol`, `invited to follow-ups`), added by, confirmed by the group. |
| `facilitation_steps` | facilitation id, position, kind (`open`, `collect`, `discuss`, `cluster`, `prioritise`, `decide`, `assign`, `close`), title, timebox, decision method and options where the step decides, status. The agenda. |
| `facilitation_participants` | facilitation id, scope (`home` or a session id), principal id (authenticated channel user id), display name, source (`roster`, `joined`), status (`active`, `left`), changed at, changed by event. |
| `facilitation_dod_versions` | facilitation id, version, text, structured criteria where machine-checkable, proposed by, proposal message id, consent state, effective at. |
| `facilitation_contributions` | facilitation id, step id, participant principal, kind (`idea`, `position`, `concern`, `question`, `proposal`, `vote`, `confirmation`, `objection`, `abstention`, `commitment`), payload validated against the step, source message id (unique per facilitation), status (`valid`, `ambiguous`, `superseded`, `withdrawn`), recorded at. |
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
| **Session** (async phase or live meeting) | `scheduled` → `live` → `closed` | Its time slot ends or the group closes it; the session summary is posted, and confirmed only where the method or the definition of done requires it. |
| **Facilitation** | as above | `concluding` when the definition of done is met; `closed` after the final summary was published (and confirmed where required); `following_up` while agreed action items are open; `ended` when all are done or overdue, or the follow-up deadline passed. |

- **invited:** the facilitator's bot is in a group conversation.
- **configuring:** a person in the group asks the facilitator to start; that person is
  the initiator, and the facilitator says so in the group. The facilitator agrees goal,
  definition of done, format and agenda, participants and deadline **in the group**, checks
  readiness of its identity in this channel and conversation (Teams: §6.2; other channels:
  §6.4), then posts the opening handshake (§5.7). The conversation id always
  comes from the inbound turn.
- **active:** every inbound human message is processed in the facilitation's own session
  (§5.3); the scheduler handles time-based events (§5.6).
- **concluding:** the definition of done is met. Contribution and reminder triggers of
  the active phase are cancelled in the same transaction. The facilitator posts the final
  summary (decisions, next steps with owners and due dates, open points). A group
  confirmation is asked only if the method or the agreed definition of done requires it
  (for example consent, a free-text definition of done, or next steps that were not
  confirmed by their owners yet); otherwise the result is published and the facilitation
  closes automatically. (#2071 removed confirmation rounds the model added on its own in
  the plugin's definition-of-done verdict; the old pattern's separate initiator
  confirmation step still exists and goes with it, §8.) Then `closed`.
- **following_up:** only if action items with owners were agreed. A bounded follow-up
  context with its own deadline (last due date plus a grace period set at start, default
  7 days) and its own triggers: reminders to owners before due dates, a status post at the
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
  facilitations and Conductor discussions share one reservation (today
  `conductor_ephemeral_attachments`, unique per conversation). A process releases only its
  own reservation, never an operator binding, and sends only with its own identity to a
  checked target.
- **Conversations:** a facilitation has one home conversation (where it was started).
  A live session may run in another conversation (for example the chat of a scheduled
  Teams meeting): the initiator links it in the home conversation when the session is
  scheduled, and the facilitator confirms the link in both. People in the linked
  conversation who are not participants are added as session participants only; they
  see the session agenda and what is posted in that conversation, never the home
  conversation's history or protocol (§5.8). Contributions are accepted from the home
  conversation and from linked session conversations while the session is `live`.
- **Authorship comes only from authenticated inbound events.** A contribution is recorded
  by `record_contribution(messageId, payload)`: the engine takes author, tenant, channel,
  message id, revision and timestamp from the stored inbound event, never from model
  arguments. Which messages are accepted in which phase is defined by the input matrix
  below; everything else is refused, in particular messages from other conversations,
  messages from before the facilitation started (for example from an earlier one) and
  messages from people who are not eligible for the step.

  | Input | configuring | active: open step | active: closed step | concluding | following_up |
  |---|---|---|---|---|---|
  | Preparation input (topics, pre-reads, agenda remarks) | accepted | accepted | refused | refused | refused |
  | Contribution or change of one's own contribution | refused | accepted (until the step closes) | refused | refused | refused |
  | Confirmation of the final summary | refused | refused | refused | accepted (where required) | refused |
  | Completion message of an action-item owner | refused | refused | refused | refused | accepted |
  | Change proposal to the definition of done or method | accepted | accepted | accepted | refused | refused |
  | Status request, stop | accepted | accepted | accepted | accepted | accepted (stop ends follow-up) |
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
- **Clusters and summaries** are proposals by the facilitator; they become part of the
  record only after the group confirms them.
- **Decisions** are evaluated by the methods of §5.5; **action items** need an owner who
  confirms in their own message and a due date.

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
| Consent | Consent or objection with a reason. | Passes when no objection stands; objections are moderated, then the proposal is put again. | n/a |
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
| Consent with a standing objection | Stays `active`; the facilitator moderates the objection and puts an amended proposal; at the deadline: abort report with the objection |
| Assignment with an unconfirmed name | Stays `active` until the named person confirms or declines; at the deadline: abort report naming the open items |
| Free-text definition of done | Group consent on "the definition of done is met" (§5.7), then the facilitation goes to `concluding` |

**Eligibility per step:** every step declares its electorate: by default the active `home`
participants; a step run inside a live session may declare the session participants
instead. Session-only participants never count as missing for home steps. Membership is
tracked per scope: leaving a meeting chat ends only the session membership, never the home
membership.

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
  definition of done allows it, otherwise an honest abort report. Nothing ends silently:
  a failed step, an exhausted retry budget or TTL expiry produces an abort report.
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
- **Status** on request at any time: phase, who has contributed, who is missing, current
  (or provisional) tally where the method has one, deadline, definition-of-done version.
- **Result** goes to the group first, then to the initiator with the protocol (only if
  the initiator is still an active participant at send time). The
  initiator receives nothing the group was not told about. A machine-checkable result
  needs no extra confirmation by the initiator; a free-text definition of done is
  confirmed by the group (consent) before closing.
- **Changes to the definition of done or the method:** anyone may propose. The
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
| Confirmed stakeholders | Only the confirmed protocol and next steps sent to them (§5.11), filtered per recipient by discretion (AVE §5.11): content whose labels the recipient may not know is left out and the protocol says that something was left out. Recipients are re-checked at every send; a participant who left is no longer a recipient. |
| Other users | Nothing. |
| Operator | Facilitation metadata (facilitator, conversation, phase, counts, timestamps). Contents and protocol only through an audited access with a stated reason. |

Facilitation records and protocol are deleted after a retention period set per instance
(default 90 days), counted from `ended` or `aborted`, never from `closed`, so follow-up is
never cut short. The follow-up horizon is capped by an instance setting (default 90 days
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
| **Protocol dispatch** | Send the confirmed protocol and the agreed next steps of this facilitation to its participants and confirmed stakeholders, through the channel or mail. | Send anything else, to anyone else; read mailboxes. |
| **Follow-up scheduling** | Read free/busy (no event details) of participants and confirmed stakeholders for the follow-up meetings the group agreed; create the invitations with agenda and protocol link. | Read calendar contents; change or cancel other events; invite people the group did not agree on. |

Both run on the instance's existing integrations (for Microsoft 365 the M365 connector)
under facilitation-scoped grants with an explicit lifecycle, independent of whether action
items exist:

| Grant | Issued when | Allows | Revoked when |
|---|---|---|---|
| Protocol dispatch | A session closes or the facilitation closes or aborts | Sending that session's or the final confirmed protocol to the recipients of §5.8 | All sends of that protocol are confirmed, or 7 days passed (a failed send is reported to the initiator) |
| Follow-up scheduling | The group agreed a follow-up meeting | Free/busy and invitations for exactly that meeting | The invitations are sent, or the agreed date passed |
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
- **All messages:** in the home conversation and in live linked session conversations of an
  active facilitation, the facilitator's bot receives every human message; the mention
  gate is lifted for that bot in those conversations only. In `following_up` the gate is
  back on; owners reach the facilitator by mention, card button or direct reply. This needs the app installed in that chat with RSC
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
    a protocol; a stakeholder receives only the confirmed protocol, filtered by
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
16. **Silent voices and balance.** In a discussion step, a participant who has not
    contributed is invited (privately where possible) before the step closes; nobody is
    named in the group as not having contributed.
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

## 10. Work breakdown

Each item becomes one issue in epic #2043; the owner (kernel or plugin) of each part is
given in §0.

1. Agent kind `facilitator`: data model, enforced omissions (grants, memory, assistance,
   consultation, default, persona, fast path), neutrality block and persona bounds (§2).
2. Facilitation engine: tables, lifecycle, one session, authenticated contributions
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
