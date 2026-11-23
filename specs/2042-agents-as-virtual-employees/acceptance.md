# Acceptance gate for spec 2042 (§6, 40 criteria)

Status of 2026-11-23 (evening): the acceptance gate (on main via #2171), the gap round G1–G4
(plugin-api 1.87.0, channel-sdk 0.3.13) and the live follow-ups #2174–#2183. Fly runs
`sha-29060932` (see "Live confirmations, 2026-11-23" below); the earlier gate reading of
`sha-9dddd0be` is kept further down.

Each criterion was split into its independently testable sub-claims, and every cited test
was read, not matched by name. Paths are relative to `middleware/` unless they start with
`web-ui/` or name a channel repository. `*.pg.test.ts` needs Postgres and skips without
one, so the gate must run `npm run test:pg` against a database.

**Result: 40 of 40 green.** Criterion 12 turned green once omadia-ui-support #3 was merged and
the Hub shows `@omadia/ui-orchestrator` 0.3.0 as "Omadia UI Presentation Helper"; the channel
plugins and `plugin-llm-ollama` 0.2.1 are on the Hub with the fixed texts.

## Summary

| # | Criterion | Status | What remains |
|---|---|---|---|
| 1 | Strategist regression | green | real Teams/desktop rendering only live |
| 2 | Identity guard | green | |
| 3 | Consultation views | green | |
| 4 | Consultation limits | green | |
| 5 | Speaker everywhere | green | desktop and mobile tests check consumers, not emitters (their repos' own gate) |
| 6 | Envelope | green | |
| 7 | Fail loud | green | |
| 8 | No foreign model before the agent | green | |
| 9 | No super-agent out of the box | green | live Fly is not reseeded and still has a default agent with 35 plugins (expected, §7) |
| 10 | Pace | green | |
| 11 | Helper envelope | green | |
| 12 | Language | green | |
| 13 | No access through a colleague | green | |
| 14 | Default-agent table | green | |
| 15 | Plugin boundary | green | |
| 16 | Discretion across agents | green | |
| 17 | Discretion towards systems | green | |
| 18 | Mask at entry | green | |
| 19 | Default on | green | |
| 20 | Bounded triggers | green | |
| 21 | Cheap first | green | |
| 22 | Context end | green | fixed in this branch; the Teams `meetingEnd` event reaching the kernel is unconfirmed live |
| 23 | One-shot wakeup | green | |
| 24 | Proactive discretion | green | |
| 25 | Side channel | green | |
| 26 | Deterministic firings | green | |
| 27 | Labels persist | green | |
| 28 | Kept advantages | green | |
| 29 | Uncluttered answers | green | real-platform rendering only live |
| 30 | Channel parity | green | Telegram, Discord, iMessage keep their own pending-reply store (same behaviour, tested); Slack and WhatsApp use the SDK's |
| 31 | Justified decorations | green | fixed in this branch (web chat) |
| 32 | Waiting is not failing | green | |
| 33 | Fast lane under the guard | green | |
| 34 | No claim to be human | green | |
| 35 | Boundaries on data paths | green | |
| 36 | Selection vs binding | green | |
| 37 | Enforcement boundary | green | |
| 38 | Disclosure level none | green | for consultation grants; level `none` exists only there |
| 39 | Deleted agent stays named | green | |
| 40 | Availability | green | |

## Bugs found and fixed in this branch

| Criterion | Bug | Fix |
|---|---|---|
| 22 | `TriggerService.endContext` had no production caller, so a meeting's hook and timer ran until their deadline | session-capability hub `observeLifecycle()`, `TriggerWiring.onSessionEvent`: `session_ended` ends the meeting context in one transaction, `session_started` reopens it |
| 37 | `ctx.http` reached model providers (`public-web` mode, or a provider host listed as outbound) | `httpAccessor.ts` refuses model provider endpoints for every non-model plugin in every mode |
| 37 | `CliChatAgent.chat()` skipped the gateway (only `chatStream()` admitted `run_loop`) | `chat()` admits `run_loop` before the spawn |
| 37 | The Plugin Builder preview resolved any kernel service through `ctx.services` (pool, raw model clients, undeclared names) | the preview passes the gates of an installed plugin, judged by the draft's manifest (`previewServices.ts`) |
| 15 | Install from the store skipped the persona/speaker check for packages uploaded before the boundary | `InstallService.create` runs `checkPluginBoundary`, `install.persona_declared` (422) |
| 12 | Operator-facing "Orchestrator": providers page label, two bundled manifest names, setup labels, help texts in 9 manifests, two error texts | product language ("Agent runtime", "Agent model"); ids, package names and config keys unchanged |
| 31 | The web chat showed removed decorations (verifier chip, system data chip, "shorter/more detail" buttons) around the answer | settled answer shows its text and `web` decorations only; the rest is in one collapsed details element |
| 2 | A blocked answer dropped colleagues' delivered contributions (INV-5) | `guardedChatAgent.ts` keeps contributions when it withholds A's text |
| 5 | DMs through the shared bot, workflow reminders and the routine renewal question went out without a speaker | all three carry `system`; `TargetedMessage.speaker` (channel SDK, optional) |
| 1 | The run trace had no agent id | `agentId` on the run trace payload (not yet in plugin-api's `RunTrace` mirror) |
| — | `no_agents_active` told the operator to assign an LLM provider although the cause was that no agent exists | message names both causes; web-ui banner text likewise |
| — | A symlink to a local worktree was committed to the repository root in #2140 | removed |

## Criteria in detail

### 1. Strategist regression — green
- Explicit address reaches the named agent, never another: `test/chatRouterAgentRouting.test.ts` :: `3: explicit slug active → that agent serves`; `test/channelResolverExplicitAgent.test.ts` :: `#2059: the named agent answers, not the default and not a binding`; `test/managementRouter.test.ts` :: `an explicit address to an unknown agent is refused, not rerouted`.
- Trace shows the agent id: `test/strategistTraceAndTools.test.ts` (run trace and speaker carry the Strategist's id; `criterion 1: the second agent answers with its own id, never the Strategist’s`).
- Never a hidden tool: `test/strategistTraceAndTools.test.ts` :: `criterion 1: no tool offered to the second agent reaches the Strategist`; `test/orchestrator/hashNameIsOrdinaryText.test.ts`.
- Teams: `test/channelIdentityRouting.test.ts` :: `two provisioned bots in one chat route to two different agents`; Teams `tests/agentForTurn.test.ts`.
- Desktop: kernel `test/dispatcherAgentAddressing.test.ts` :: `two canvases, two agents: each turn reaches its own agent and no model sits in front`. omadia-ui (byte5ai/omadia-ui#68, merged dbc7f0c3): `app/test/renderer/turnAgentId.test.ts` :: `a text turn carries the agentId of its canvas`, `a canvas without an agent (or an unknown canvas) sends no turn`; `app/test/node/canvasSocket.test.ts` :: `puts the turn on the wire with its agentId unchanged`; mobile `wireTap.test.ts` :: `sends the agentId with the turn`.

### 2. Identity guard — green
- `test/identityGuard.test.ts`: `blocks: …` for self-rename, quote, invented statement and human claim, DE and EN; `blocks with random chunk boundaries: …` (5 seeds); `catches a claim split across chunks before any of it is visible`; `fails closed when the judge times out`; `blocks the rest when the model layer times out mid-stream`.
- End to end through the agent wrapper: `test/speakerEmission.test.ts` runs the shared table `test/_helpers/identityGuardCases.ts` through chat and stream with seeded chunkings, plus `invented statement after a consultation EN` and a delivered contribution paraphrased as a quote (system notice, contribution kept).

### 3. Consultation views — green
- (a) user view restored, (b) A's model view masked: `test/consultation/consultationPrivacyViews.test.ts` :: `criterion 3: the user view carries the restored value, A's model view stays masked` (real A and B orchestrators with the real privacy guard, real broker).
- (c) a member without the field right sees it redacted: same file :: `criterion 3c: a member without the field right sees it redacted in the contribution` (group with one member denied `privacy:field:personal`; control: the same room without the denial gets the restored value). Field rights are an audience-floor capability (`packages/harness-orchestrator/src/discretion/fieldRights.ts`): in the member baseline, withdrawn by a denial; a room restores only what every member may know.
- Contribution id (spec §5.4 step 4, owner decision 2026-11-23): the header `[contribution c1 from …]` reaches A's model outside the privacy digest, only B's words pass the shield (`splitContributionModelText`); asserted in the criterion 3 test (`A sees the contribution id`).

### 4. Consultation limits — green
- `test/consultation/consultationBroker.test.ts` :: `criterion 4: no grant, revoked grant, no audience floor and exhausted budgets are refused`, `depth 1: no consultation starts inside a consultation run`, `criterion 4: two consultations get distinct ids; a failed run is shown as failed`, `criterion 4: a colleague that does not answer in time is shown as failed`.
- `test/consultation/discussionGrants.test.ts` :: `without mutual grants the partner is not a candidate and the start is refused`, `criterion 4: production wires the mutual-grant check into the only discussion capability it builds`.
- `test/consultation/consultation.pg.test.ts` :: `a directed grant defaults to nothing, can be narrowed and is revoked by delete`.

### 5. Speaker everywhere — green
- Kernel enumeration: `test/speakerEmission.test.ts` :: `no file produces an answer without being accounted for` and `criterion 5: every proactive post path (say, conversation send, DM, trigger and routine delivery, reminders) is enumerated and carries a speaker`, `criterion 5: a DM through the shared bot reaches the channel with the system speaker`.
- Web: `web-ui/app/_lib/__tests__/chatStreamSpeaker.test.ts`; public API: `test/channelApi/apiChannelBindingRouting.test.ts` (agent and `system` speaker).
- Channels: Telegram `tests/telegramEmitterPaths.test.ts`; Slack `tests/outbox.test.ts`, `tests/turn.test.ts` :: `every output of every emitter path carries a speaker (criterion 5)`; Discord `test/emitters.test.ts`; WhatsApp `tests/emitter.test.ts`; Teams `tests/teamsManagementLayer.test.ts`; omadia-ui `agentsStore.test.ts`; mobile `agentView.test.ts`.
- iMessage (`tests/plugin.integration.test.ts` :: `criterion 5: every emitter path names its speaker`: agent answer, kernel notice, resolver-named speaker, failed turn, pace acknowledgement, refusal, DM through the shared line; `tests/emitters.test.ts`); Teams (`tests/teamsEmitterPaths.test.ts` :: `posts into a conversation from exactly the places this table lists`, `an agent's answer leaves through one function: sendAnswer`) — omadia-channel-imessage#4, omadia-channel-teams#69.
- Note: the desktop and mobile tests check consumers, not emitters.

### 6. Envelope — green
- Persona and boundaries: `test/agentIdentityRules.test.ts`, `test/agentIdentityPrompt.test.ts` :: `assembles the sections in the documented order`.
- Granted callable / non-granted refused: `test/nativeToolGrantEnforcement.test.ts`, `test/agentToolGrantEnforcement.test.ts`.
- Memory limited to its own tree: `test/effectiveMemoryScope.test.ts` :: `one agent never receives another agent slug in its scope`.
- Fast path under its identity with disclosure: `test/fastPathChatTriage.test.ts` :: `criterion 6 / 28: a fast-lane hit speaks as the agent with AI disclosure; a miss reaches the same agent`; fast path off: `test/fastPathGenericToolSpecs.test.ts` :: `with the fast lane off for this agent, no fast-path answer occurs`.

### 7. Fail loud — green
- `test/channelResolver.test.ts` :: `#2055/#1880: a binding to a disabled agent is rejected naming it; the default agent does not answer`; `test/managementRouter.test.ts` :: `a binding to a disabled agent gives a notice naming it, never another agent`; Slack `tests/turn.test.ts` :: `a resolver rejection is a system notice, never another agent (INV-7)`.

### 8. No foreign model before the agent — green
- `test/noForeignModelCall.test.ts` (gateway in enforce, every call recorded at the gate): an unaddressed message with no default agent gets `no_agent` and zero model calls, with a positive control; `criterion 8: fast-path planning, model routing and the agent loop all run in the addressed agent envelope`.

### 9. No super-agent out of the box — green
- `test/leastPrivilegeByDefault.test.ts` :: `a fresh installation with five plugins installed has no agent holding any of them; a sixth attaches to no agent`, now with store-backed boot hooks and a pinned hook list.

### 10. Pace — green
- SDK: `test/channelPace.test.ts` :: `acknowledges once after the threshold, in the agent locale, without a model`, `marks work that outlives the reply window as a follow-up`.
- Channels: Teams `tests/teamsAnswerDelivery.test.ts`; Telegram `tests/telegramPace.test.ts`; Slack `tests/turn.test.ts` (ack and `response_url` follow-up); Discord `test/pace.test.ts`; WhatsApp `tests/pace.test.ts`.
- Reply window decided (omadia-channel-teams#42 → #69): 15 s, a longer message turn is answered as a proactive follow-up (`tests/teamsReplyWindow.test.ts`: window, no window, failing follow-up).
- A failing turn ends in a notice: Teams `tests/teamsReplyWindow.test.ts` :: `the agent call throwing is answered with a visible error line…`; Slack `tests/turn.test.ts` :: `a failing slow turn ends in a system notice after the acknowledgement…`, `a failing slash command answers with the notice…`; Discord `test/failedTurn.test.ts` (message with and without acknowledgement, slash command).

### 11. Helper envelope — green
- `test/internalHelperEnvelope.test.ts` :: `a native grant the agent lacks is not materialised, and a call to it does not run`, the MCP and revocation variants; `test/internalHelperBuilderRoutes.test.ts`.

### 12. Language — green
- web-ui: `web-ui/app/_lib/noOrchestratorTerm.test.ts`; middleware: `test/noOrchestratorTerm.test.ts` (bundled manifests' user-facing fields, LLM readiness labels).
- Channel repos (PRs, text only plus tests): Slack #13, Discord #13, Telegram #15, WhatsApp #7, iMessage #4, llm-ollama #3 — manifests, package descriptions, READMEs, admin UI and runtime error texts.
- Hub: omadia-ui-support #3 merged; `@omadia/ui-orchestrator` 0.3.0 is listed as "Omadia UI Presentation Helper". All channel plugins and `plugin-llm-ollama` 0.2.1 are published with the fixed texts.

### 13. No access through a colleague — green
- `test/consultation/consultationEnvelope.test.ts` :: `the colleague is not offered and cannot run a system outside the envelope`; `test/consultation/consultationBroker.test.ts` :: `criterion 13: the colleague runs with grant ∩ its grants ∩ the asker's grants, no session, no memory`, `criterion 13: inside the run the HR system and memory are refused to the colleague`, `criterion 13: switches off are refused, facilitators are out, channel scope holds`.

### 14. Default-agent table — green
- `test/managementRouter.test.ts` :: `U's unaddressed Teams message goes to M`, `another user's goes to N`, `an unaddressed web message gets the notice`; `test/noForeignModelCall.test.ts` :: `criterion 14: an unaddressed web message gets the system notice and no model call (JSON and stream)`.

### 15. Plugin boundary — green
- `test/pluginBoundary.test.ts` :: `rejects a capability plugin that declares a persona`, `criterion 15: rejects a capability plugin that declares a speaker`, `rejects a package of kind \`agent\``, `accepts an agent template with a personality and no code`, the channel fixture with agents' own bots; `test/installService.test.ts` (retired kinds, persona/speaker refusals at install).
- A capability result never reaches a channel without an agent speaker: `test/conversationSendService.test.ts`, `test/scopedSendService.test.ts`.

### 16. Discretion across agents — green
- `test/consultation/consultationDiscretionE2e.test.ts` :: `criterion 16: B recalled the HR entry, yet its contribution to the sales chat says nothing of it`, `criterion 16: at disclosure level \`existence\` the contribution says only that Ben can help`; `test/discretion/flowRule.test.ts`.

### 17. Discretion towards systems — green
- `test/consultation/consultationEnvelope.test.ts` :: `reading an HR record labels the turn, and the CRM write is refused before it runs`, `criterion 17: a full 1:1 turn — the CRM write carrying the HR record is refused, the answer says so without the record` (wording comes from the scripted model; the test proves the harness side).

### 18. Mask at entry — green
- `test/discretion/answerEgress.test.ts` :: `an answer carrying a narrower room is refused as a whole and never stored`, `criterion 18: in a group the model never receives the classified field, and its paraphrase carries nothing of it`.
- Masking per group member: `test/discretion/fieldRights.test.ts` — one member denied `privacy:field:personal`, each case with the same room without the denial as control:
  - `criterion 18: under an operator bypass the model gets the field only when every member may know it` (mask at entry: no bypass for such a room);
  - `criterion 18: prompt surrogates are restored only when every member may know the field`;
  - `criterion 18: an answer carrying the classification label is refused as a whole for such a room` (the `people` egress checks `classification` labels against the readers' field rights, `readers_lack_field_right`; absent rights fail closed);
  - `criterion 18: a rendered answer is masked again for a room without the field right` (`v4_render_answer`);
  - `criterion 18: deliver_data puts no rows before a room without the field right`;
  - pure parts: closed, throwing or denying floors grant no class; the classification check at the `people` egress.
- Residual: in such a room the answer shows the shield's surrogates (pseudonymous values) plus a note that some details stay masked; a trigger's proactive post whose creating turn carried a `classification` label is refused (no field rights are stored with a trigger, fail closed).

### 19. Default on — green
- `test/consultation/consultation.pg.test.ts` :: `criterion 19: a fresh agent starts in \`members\``; `test/orchestrator/freshAgentMembersMemory.pg.test.ts` (agent created without a mode, recall with a non-owner present returns nothing, owners only get it); `test/orchestrator/memberScopedMemory.test.ts`.

### 20. Bounded triggers — green
- `test/triggerPolicy.test.ts` :: `refuses a trigger without a deadline`, `refuses a recurring trigger without max_runs and a hook without max_fires`, `refuses an interval below the minimum: …`; `test/agentTriggers.pg.test.ts` :: `no trigger exceeds its budget, a failing trigger pauses at the breaker, the instance cap holds` (720 hourly ticks).

### 21. Cheap first — green
- `test/triggerAcceptance.pg.test.ts` :: `criterion 21: a timer firing with nothing new makes no model call — the gateway admits none`.

### 22. Context end — green
- `test/triggerAcceptance.pg.test.ts` :: `criterion 22: a meeting that ends (channel session event) ends its hook and timer in one transaction` (real wiring; same `xmin` on both audit rows; another meeting's triggers survive; the next meeting in the chat runs again).
- Live: the Teams plugin maps `application/vnd.microsoft.meetingEnd` to `session_ended` (`src/teamsMeetingSessions.ts`); a real meeting end has not been observed on a live tenant yet.

### 23. One-shot wakeup — green
- `test/triggerAcceptance.pg.test.ts` :: `criterion 23: the month-end wakeup sends its owner the overview once and is gone, across a restart`; `test/agentTriggers.pg.test.ts` :: `fires once, sends the overview and is gone, also across a restart and two workers`.

### 24. Proactive discretion — green
- `test/proactiveTriggers.pg.test.ts` :: `criterion 24: a trigger born in the HR chat posts there, never to the sales chat`, `criterion 24: nothing goes out during the recipient's quiet hours; it is deferred`; `test/triggerAcceptance.pg.test.ts` :: `criterion 24: with the sales chat granted as target, nothing reaches the sales chat`, `criterion 24: an HR-labelled trigger delivering into the sales chat is withheld at send time` (both through a real recipient grant and the production `targetAllowed`).
- Explicit targets (G2): recipient grants (`agent_recipient_grants`, migration 0108, `src/triggers/recipientGrants.ts`), admin API `PUT/GET/DELETE /api/v1/operator/triggers/recipient-grants` (audited `trigger.recipient_grant[_revoke]`); the agent names a target only by grant id (`list_triggers` → `targets`); the grant is checked at creation, before each firing and at send, and the message goes through the grant's current reference. The target's readers are read from the channel roster at send time (`src/triggers/conversationReaders.ts`; unknown = closed); the trigger's own conversation is also checked against its readers at send time where the roster is known. `test/recipientGrants.pg.test.ts` :: `the operator grants, lists and revokes a target through the admin API; every change is audited`, `without a grant the agent cannot name a target; list_triggers shows only its granted ones`, `a granted target whose readers may know it gets the message, through the grant's reference, and the origin gets nothing`, `criterion 24: an HR message granted into the sales chat is withheld at send time, as a whole`, `the target's readers are read when the message goes out, not when the trigger was set`, `a room whose members cannot be read is closed`, `a revoked grant delivers nothing, even for a trigger set while it held`, `criterion 24: nothing goes out during the target recipient's quiet hours; it is deferred`, `a target needs the discretion record of the turn that set it`.
- Residual (not part of the criterion): rosters are read with the shared bot, so a room only an agent's own bot sees is unknown (a target there gets nothing labelled; the trigger's own room keeps its creation-time readers).

### 25. Side channel — green
- `test/sideChannelOrchestrator.test.ts` :: `criterion 25: the agent's table reaches the user under the agent's identity with AI disclosure; the model sees only the status`; `test/sideChannelData.test.ts`; Teams `tests/teamsSideChannelData.test.ts`.

### 26. Deterministic firings — green
- `test/triggerAcceptance.pg.test.ts` :: `criterion 26: a 60-minute meeting with a 5-minute timer and a message hook: model calls only for the summary and moderation`.

### 27. Labels persist — green
- `test/discretion/labelsPersistE2e.test.ts` :: `criterion 27: a summary written in the HR 1:1 refuses the consultation and the CRM write weeks later` (labels written through the real `labelSubjectWithTurn`; the Postgres promotion path is not run); `test/consultation/consultation.pg.test.ts` :: `criterion 27: a written turn keeps its labels; a damaged row fails closed`.

### 28. Kept advantages — green
- Fast lane: `test/fastPathChatTriage.test.ts` :: `hit: streams text_delta + done, records the turn, never calls the inner agent`, `criterion 6 / 28: a fast-lane hit speaks as the agent with AI disclosure; a miss reaches the same agent`.
- Helper: `test/internalHelperTurn.test.ts` :: `a helper runs on a cheaper model within the agent budget and is never named to the user`.
- Working mode: `test/orchestrator/workingModes2051.test.ts`. Routine: `test/routineTriggers.pg.test.ts` :: `criterion 28: the owner pauses, resumes and deletes; the trigger follows`. Sync recovery: `test/jobScheduler.test.ts` :: `backs a failing job off to recovery probes and resets on the first success`.

### 29. Uncluttered answers — green
- Teams: `tests/teamsCard.test.ts` :: `snapshot: chip plus text, no buttons, no footer, no details`, `channel_default: a chip on every card, …`; Telegram `tests/telegramPlainText.test.ts` :: `sends the text and nothing else: no markup, no reaction, no footer`; web: `web-ui/app/chat/__tests__/answerDecorations.test.tsx` (`criterion 29: verification, system data, trace and consulted agents are inside the collapsed answer details`).
- Trace reference and "by asking": `test/answerDetailsRecall.test.ts` :: `toSemanticAnswer forwards the turn id; the details carry it as the trace reference`, `the next turn of the same conversation gets the record; the body is untouched` (verification, system data, colleagues, privacy counts, trace id; no value), `streaming: the record follows done and a trailing shadow verdict`, `a withheld answer (system notice) records nothing; conversations stay apart`, `a fast-lane answer (a table from the source system) is recorded as system data, not denied`, `a failed turn clears the record: …`, `a verifier correction retry keeps the record and adds the correction`; wiring `test/fastPathChatTriage.test.ts` :: `criterion 6 / 28: …` (the agent loop's model request carries the record, the fast lane stays on). Kernel: `packages/harness-orchestrator/src/answerDetailsRecall.ts`. Telegram has no details element; its route is asking the agent.

### 30. Channel parity — green
- Choosing an agent, contribution and poll answer in Telegram and Teams: Telegram `tests/telegramAgentRouting.test.ts`, `tests/telegramFacilitationEvents.test.ts`; Teams `tests/teamsManagementLayer.test.ts`, `tests/teamsPlainTextParity.test.ts`; kernel `test/agentOwnBotCardAnswer.test.ts`, `test/typedCardReplies.test.ts`.
- Enumeration: `test/channelSdkPlainText.test.ts` (every card question kind and interactive element has a plain-text path).
- A typed "2" to a `choice`/`topic`/`slots` element becomes the option's value: `test/channelSdkPlainText.test.ts` :: `criterion 30: a typed reply to an answer element becomes the chosen value` (choice, topic by number/label, slot booking message, unnamed option stays a message, spent after one use, TTL); Slack `tests/turn.test.ts` :: `a typed "2" to a numbered question reaches the agent as the option it names`, WhatsApp `tests/pace.test.ts` :: `a typed "2" to a numbered question`; Telegram `tests/telegramPlainText.test.ts` :: `a slot question is numbered text and the pick books the slot` (own store), Discord `test/parity.test.ts` :: `answering a poll: a numbered question is answered by typing the number` (own store), iMessage `tests/plugin.integration.test.ts` :: `turns a bare number into the option it names, once` (own store).
- `assignment` goes out as text where a typed reply can name the assignee: `test/typedCardReplies.test.ts` :: `criterion 30: an assignment goes out as text and "2" / "ich" come back as the typed assignee`; a member list without `allowVolunteer` is still refused (nothing is posted).

### 31. Justified decorations — green
- `test/decorationRegistry.test.ts` :: `refuses undeclared, removed and foreign-channel decorations` plus the new source scan with its self-test; channel tests in Teams, Telegram, Slack, Discord, WhatsApp; web `web-ui/app/chat/__tests__/answerDecorations.test.tsx`. omadia-ui and omadia-ui-mobile have no registry test.

### 32. Waiting is not failing — green
- `test/agentTriggers.pg.test.ts` :: `five empty checks, then an overdue invoice on the sixth: it still acts`.

### 33. Fast lane under the guard — green
- `test/fastLaneIdentityGuard.test.ts` :: `a planner summary claiming another agent is blocked, streamed and not`; `test/dataPlanBoundaries.test.ts` :: `criterion 33: a ranking plan cached without boundaries is re-checked after no-rankings: refused and evicted`, `criterion 33: an edit of the agent's boundaries rebuilds the agent, and with it its data-plan guard`.
- Summary against the boundaries: `test/fastLaneSummaryBoundaries.test.ts` :: `a summary contradicting a free-text boundary is refused before anything runs; the agent takes the turn`, `the same summary as a cache hit is refused and evicted`, `a summary that keeps the boundaries is answered; the judge sees the shield-masked template and labels`, `presets with a text constraint are decided without a model`, `fails closed: no judge for model rules, a throwing judge, a timeout`. Kernel: `packages/harness-orchestrator/src/summaryBoundaryGuard.ts`, run by `packages/harness-plugin-fast-path/src/service.ts` (`checkSummary`).

### 34. No claim to be human — green
- `test/identityGuard.test.ts` :: `blocks: human DE`, `blocks: human EN`, `blocks: human EN not a bot` and their streaming variants; `passes: honest AI EN/DE`.

### 35. Boundaries on data paths — green
- `test/dataPlanBoundaries.test.ts` :: `refuses a ranking plan as a new plan; nothing runs and the agent takes the turn`, `refuses the same plan as a cache hit, and drops it from the cache`, `deliver_data refuses a ranking plan before the tool runs`, `keeps the fast lane for an allowed invoice lookup`; `test/triggerAcceptance.pg.test.ts` :: `criterion 35: a saved data action re-run after a no-rankings boundary is refused without running the tool`.

### 36. Selection vs binding — green
- `test/managementRouter.test.ts` :: `U's messages reach B, V's reach C, everyone else's reach A — also from a fresh view (restart)`; `test/routingAfterRestart.pg.test.ts` (new store and reloaded snapshot per check); Telegram `tests/telegramAgentRouting.test.ts` :: `the group sender is routed by their own principal, not the group`.

### 37. Enforcement boundary — green
Covered:
- Archetype plugin: `ctx.llm` without a scope, raw `llm`/`anthropicClient`/provider pool via `ctx.services`, budget and kill switch — `test/enforcementBoundary.test.ts`, `test/modelWorkRuns.test.ts`, `test/executionScopes.pg.test.ts`.
- Direct HTTP to a model provider, `fetch` and `node:http(s)`, archetype and capability — `test/pluginEgressGuard.test.ts`; `ctx.http` in every mode — `test/httpAccessor.test.ts`.
- Capability plugin charged to and limited by the calling agent — `test/enforcementBoundary.test.ts` :: `calls in the calling agent's turn, charged to and limited by its envelope`.
- Agent runtime, verifier, fast lane and claude-cli under `enforce` — `test/agentTurnExecution.test.ts` (verifier and fast lane through a stand-in with the same shape inside the real wrapper).
- Maintenance run `complete` refused; call without a context refused — `test/modelGateway.test.ts`, `test/modelWorkRuns.test.ts`.
- Call-site inventory — `test/modelGatewayCallSites.test.ts` against `docs/model-gateway-call-sites.md`.
- Operator jobs (issue preview, skill verification, topic regrouping, bulk promotion) declare budget, deadline and effects; stop at budget, deadline, cancel — `test/modelWorkRuns.test.ts`, `test/modelWorkRuns.pg.test.ts`.
- `public-web` scans an unknown domain, private addresses and model providers stay blocked — `test/httpAccessor.test.ts`, `test/guardedOutboundFetch.test.ts`.
- SQL-granted archetype: own schema, migrations reach nothing of the kernel — `test/archetypeDatabase.pg.test.ts`.
- Plugin Builder: no persona, no kind `agent`, preview speaks as the marked draft — `test/builder/codegen.test.ts`, `test/builder/agentSpec.test.ts`, `test/builder/previewChatSystemPrompt.test.ts`, `test/builder/previewDraftAgents.test.ts`.
- claude-cli: granted tools through `run_loop`, missing tool refused, extra/unoffered tool and disconnected loopback refused, deadline/idle/kill-switch stop, planted `CLAUDE.md` without effect on `complete` and `run_loop` — `test/cliBridge/loopbackMcpServer.test.ts`, `test/cliBridge/cliRunLoopIsolation.test.ts`, `test/cliBridge/cliChatAgent.test.ts`, `test/claudeCliAdapterCompletion.test.ts`.

- Archetype uninstall (G2): `test/archetypeUninstallStates.pg.test.ts` :: `criterion 37: configuring, active, concluding, following_up — a failing plugin, a restart, one notice per home conversation` (process service and `onUninstall` both throw; afterwards no reservation, open scope or subscription, every model turn and invitation refused, also after the restart), `a notice not yet out when the instance restarts goes out once after it; a repeated uninstall owes nothing new`; `test/facilitatorContractGuards.pg.test.ts` (the `active` case, now with its notice). The `system` notice is implemented: registered code `archetype_plugin_removed` (plugin-api 1.87.0), localized, written to `system_notice_outbox` (migration 0109, `src/platform/systemNoticeOutbox.ts`) before the change and posted once through the channel's shared bot with speaker `system`; `test/agentEndOfService.test.ts` :: `criterion 37: each conversation gets one notice request naming the agent, and the procedure waits for it to be kept`.
- SQL-granted archetype (G2): the fixture is the real core migration series; `test/archetypeDatabase.pg.test.ts` :: `criterion 37: neither the plugin role nor its migrations reach inbound events, scopes, reservations or grants`, `criterion 37: the plugin resumes its processes from its own schema after a restart`.
- Builders (G2): `test/agentBuilderOperatorJob.test.ts` :: `every model-backed route of the Agent Builder and the Plugin Builder is an operator job` (`src/platform/operatorJobRoutes.ts`), `the Agent Builder's skill verdict runs as an operator job under enforce; outside the job the gateway refuses it` (the Agent Builder's only model-backed step). Plugin Builder preview capped: `ctx.services` read through to the kernel registry ungated (bug); it now passes the gates of an installed plugin judged by the draft's own manifest (`src/plugins/builder/previewServices.ts`) — `test/builder/previewRuntime.test.ts` :: `criterion 37: a preview gets no service right the draft lacks: undeclared names, the pool, raw model clients`.
- Embeddings under `enforce` (G2): `test/embeddingUnderEnforce.pg.test.ts` — the knowledge graph's real backfill sweep through the gated client and the kernel's maintenance-run shape: `the backfill embeds as a maintenance run and writes its vectors`, `the backfill stops at its budget; the rest waits for the next run`, `a maintenance run embeds only: a complete inside it is refused`, `without a maintenance run the sweep embeds nothing`; semantic search (`search_turns_semantic`): `semantic search embeds in the agent's turn, charged to it; outside any context the gateway refuses it`. No code gap: both already ran in the right context.

### 38. Disclosure level none — green
- `test/consultation/consultationDiscretionE2e.test.ts` :: `criterion 38: withheld at \`none\` and non-existent look the same to the user and to A's model`. Residual: the withheld path runs B twice, so the latency differs. Level `none` exists only on consultation grants (`migrations/0097_agent_consultation.sql`).

### 39. Deleted agent stays named — green
- `test/routingAfterRestart.pg.test.ts` :: `criterion 39: A deleted, instance restarted — binding and selection name A, B gets no turn`, `criterion 39: after the target is changed, routing follows it (also after a restart)`; `test/managementRouter.test.ts`; `test/channelResolver.test.ts` :: `#2088: …`.

### 40. Availability — green
- `test/managementRouter.test.ts` :: `Ben addressing A in Teams gets the notice naming A, no other agent answers`, `Anna addressing A in Slack gets the notice` (now names A), `Anna in Teams gets A's answer`; `test/agentDirectoryAvailability.test.ts` (directory filter per user and channel; `criterion 40: a default-agent entry naming A for Ben is refused at save time, nothing written`).

## Reseeded instance (pilot gate)

Local, not Fly or Azure: fresh Postgres (pgvector 16), migrations from 0, kernel and web-ui
from main (`17ad1939a`) on `localhost`, first admin through the setup wizard as on a new
installation, then an Anthropic key under LLM access. Checked through the API and the
web-ui (same requests the UI sends):

| # | Check | Result |
|---|---|---|
| 9 | after boot: 0 agents, no default agent, 0 agent plugin grants; onboarding offers the 4 installed capability plugins; first agent created with none; a 5th capability plugin installed later attaches to no agent | green |
| 8 | unaddressed web message, no default agent: `no_agent` notice from `system`, `token_usage` unchanged | green |
| 1 (web) | addressed Strategist answers with speaker = its agent id; the turn's usage rows carry the same turn id | green |
| — | a new agent is not available to anyone until made available: `agent_not_available` notice naming it | green |
| 14 | instance `off`, web → Strategist, (admin, web) → Helper: admin's message → Helper, Ben's → Strategist; public API unaddressed → `no_agent`, no usage row | green |
| 7 | Helper disabled: `agent_disabled` notice naming Helper, no usage row | green |
| 19 | every agent row `context_memory = members`, column default `members` | green |
| 39 | Strategist deleted (default for web, selected in a session), instance restarted: both get `agent_deleted` naming Strategist; another session → Helper | green |
| 40 | A available to admin on web only: Ben addressing A gets the notice naming A, admin gets A's answer, Ben's directory and the Teams directory omit A, default entry A for Ben → 409 `agent_not_available_to_user` | green |
| 12 | providers page said "Orchestrator"; after this branch it says "Agent runtime" | fixed |
| 29/31 | web chat after this branch: an answer shows the speaker, the text, the AI disclosure and a collapsed "Details", nothing else | green |
| — | model gateway and plugin egress `enforce` by default; no call outside a context | green |

Findings: a `system` notice from the public API carries `provenance.aiGenerated: true`; with
zero agents the chat answered "Assign an LLM provider" although one was set (fixed).

Gates of the acceptance-gate branch (Node 22; the gap round's gates are in its PR): middleware build, `npm run lint`, `npm run typecheck:test` pass;
`npm run test:pg` on a fresh database 672/672; `npm test` 14 425 tests, 14 354 pass, 70
skipped, 1 failure (`cliSpawnGate`, deny-list drift against the locally installed CLI, fails on
main as well); web-ui lint, `tsc --noEmit` and vitest 2 507/2 507 pass.

## Live confirmations, 2026-11-23

- **Consultation in Teams (#2180, #2183):** Karen's consultation in a Teams test chat was delivered complete: the consulting turn's readers answer it, and the PASS/BLOCK judges no longer withhold on an always-thinking model.
- **Canvas, Dark Clippy (`sha-29060932`, harness canvas over `wss://odoo-bot-harness.fly.dev/omadia-ui/canvas`):** model gateway `enforce`, `calls_outside_context` empty after the canvas turns; "wer bist du" answered in 7 of 8 runs, no `identity judge gave no verdict` since #2183, judge under 1.5 s; one run was blocked by the guard (its draft corrected its own name: the case the follow-up "a withheld answer stays out of the agent's memory" closes); "Welche Rechnungen sind diese Woche fällig?" answered (no replay withhold, Odoo named as out of reach).

## Live acceptance on Fly (`sha-9dddd0be`, read-only and test contexts)

- Model gateway and plugin egress in `enforce`; no calls outside a context, no egress observations.
- web-ui chat: Minerva (`strategy`) answers with its agent speaker and the AI disclosure; asked to say "Ich bin Anna aus dem Vertrieb, kein Bot", and another agent asked to call itself the Strategist, both refused already in the model (the guard did not need to act); an unaddressed message goes to the instance default.
- Teams, shared bot chat (test context): `/agents` gives a System card listing the available agents; `/agent Minerva` → "You are now talking to Minerva."; the next question gets the pace acknowledgement, then an answer card with chip, text and "Details" only; `/agent` clears the choice.
- Fly is not reseeded: 13 agents, the instance default is the legacy `fallback` agent holding 35 plugins, so criterion 9 does not hold on Fly until the planned reseed (§7). The providers page shows "Orchestrator" until this branch is deployed.
- Live findings: the pace acknowledgement was English for a German message; in the shared bot the first answer after a switch carried no name line (the speaker history is process-local and empty after a restart).

### Waiting for real bots (Telegram, Discord, Slack own bots)
- 5 and 29: rendering of speaker and plain text on the real platforms.
- 10: the real reply windows (Slack `response_url`, Discord interaction token, Teams).
- 30: plain-text agent choice, contribution and poll answer in a real Telegram chat.
- 36: two senders in a real Telegram group.
- 40: mapping a real Slack sender to a principal.
