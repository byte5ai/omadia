# 0030 — The kernel bounds closing scopes and the deadline wait

## Status

Accepted

- **Date:** 2026-11-21
- **Deciders:** Owner (byte5: close every gap of spec B, follow iret77's issue texts); implemented
  in the #2090 gap pass
- **Builds on:** [ADR 0022](0022-native-facilitators-as-an-archetype-plugin.md) (execution
  scopes), [ADR 0024](0024-facilitation-closing-procedure-and-result-status.md) (closing
  procedure), [ADR 0026](0026-facilitation-sessions-linked-conversations-and-spoken-contributions.md)
  (sessions)

## Context and Problem Statement

Issue #2090 ("Changes after review", 2026-11-18) and spec B §0, §5.2, §5.6 ask the kernel to
bound every action of an archetype plugin. K4 (#2113–#2117) built the execution scopes. A
comparison of the issue text with the code found three places where the bound was the
plugin's bookkeeping, not the kernel's:

1. **The 30 days of a `closing` scope counted from the moment the plugin opened it**, not from
   the closing event. The facilitator opens a closing scope lazily, at its first send; after a
   restart or a failed send that is days after the event, and the kernel would have allowed
   sends up to 30 days after that.
2. **A closing could authorize moderation.** Spec B §5.2: within the closing (and its
   confirmation window) only consent answers and the essential messages run; "an expired scope
   never re-opens moderation". The kernel checked the phase, not the purpose.
3. **The deadline wait of an `active` scope was bounded to 30 days, not to the session
   closings it waits for** (spec B §0, §5.6: "extended past the deadline only for open session
   closings, bounded by their own limits"; order at the deadline: close the live sessions and
   open their closing first, then decide whether to wait).

4. **A private reply to a reminder could not be bound to that reminder** (spec B §5.3 table:
   a completion message "as a direct reply to that owner's reminder (bound to the owner, the
   reminder and the facilitation)"; stop "as a reply to a reminder … ends only this
   facilitation's follow-up"; criterion 28). The kernel passed the private message's text
   only, so with two follow-ups of the same facilitator both numbering their item `#1`, the
   owner's answer named nothing, and the "which one?" question listed `1.` twice.

How does the kernel enforce 1–3 without learning the facilitation's lifecycle, and how is a
private reply bound (4)?

## Decision Drivers

- The kernel keeps what a plugin cannot safely own (spec B §0); the lifecycle stays in the
  plugin.
- Additive contract change (plugin-api minor), no migration: the columns exist.
- Deterministic and checkable across a restart: every bound is a row the kernel reads.

## Decision Outcome

- **`eventAt` on `openScope` (closing only, plugin-api 1.84.0).** The plugin states when the
  closing event happened; the absolute limit is `eventAt + 30 days`. The kernel refuses an
  event in the future (one minute of clock skew, `invalid_request`) and one whose limit has
  passed (`limit_exceeded`, nothing opens); an earlier event only shortens the limit and is
  taken as stated. Without `eventAt` the event is "now", as before. The kernel does not know
  closing events, so this guards against a plugin's late opening (a restart, a retried send),
  not against a plugin that omits `eventAt` on purpose.
- **`CLOSING_SCOPE_PURPOSES`.** A `closing` scope authorizes `essential_message`,
  `protocol_dispatch`, `consent`, `status`, `stop`, `invitation`, `readiness_check`,
  `roster_check`, and `other` only for a `check`. `moderation`, `handshake`, `link` and
  `reminder` are `purpose_not_allowed`, model turns included.
- **The deadline wait needs an open `closing` scope of the same process** (`scope_order`
  otherwise) and its deadline never passes the latest absolute limit of those closings
  (`limit_exceeded`). Once they have ended, `authorize` refuses on the waiting scope
  (`deadline_passed`) and the wait cannot be extended again.
- **Private replies carry their reference.** `TurnOrigin.replyToMessageId` (channel-sdk
  0.3.10) is the message a turn's message replies to or quotes, as the channel states it; the
  facilitator wrapper passes it to the private-message router, and the plugin gets it as
  `PrivateMessageRequest.replyToMessageId` (plugin-api 1.84.0). The plugin binds a reply to
  the private message it sent that person (outbox `channel_message_id`): "done" completes
  that reminder's action item, "stop" ends only that facilitation's follow-up (only in reply to a reminder), "status"
  answers for that facilitation. A private "stop" without a reference is not taken (the spec
  accepts stop only in the home conversation and as a reply to a reminder).
- **Without a reference** the ambiguity gets one question whose choices tell the
  facilitations apart: the item number plus a letter per facilitation in start order
  (`1a`, `1b`); "done 1b" completes exactly that item. Stateless; nothing changes until the
  answer names one item.
- **Not enforced by the kernel** (stays in the plugin, tested there): the parts of a closing
  (waiting, delivery, confirmation, dispatch) and their own 7-day limits; which closing
  belongs to which session; when the scheduling scope ends at a stop. The kernel has no
  lifecycle to check them against.

### Consequences

- 🟢 **Good:** a restart or a retried send can no longer stretch a closing past 30 days after
  its event; a closing cannot moderate; the deadline wait ends with the closings it waits for.
- 🔴 **Bad:** channels state `replyToMessageId` on private turns only once their adapters
  fill it (Teams: quoted reply / `replyToId`, Slack: `thread_ts`, Discord: `message_reference`,
  Telegram: `reply_to_message`); until then the lettered question is the path.
- 🔴 **Bad:** rollout order matters: the facilitator plugin first (it runs on kernels from
  1.82.0), then the kernel. Facilitator 1.6.0 on this kernel loses its moderation-mapped posts
  under a closing and its deadline wait.
- 🔴 **Bad:** the letters of the fallback question are positions in start order; if the person
  leaves one facilitation between question and answer, a letter can shift. A reply reference
  removes that.
- 🔴 **Bad:** the facilitator plugin has to open the closing scope of a session before it asks
  for the wait, and name its purposes precisely under a closing (consent hints and objection
  acknowledgements as `consent`, a late acceptance as `status`). A plugin that does not is
  refused instead of silently allowed.
- ⚪ **Neutral:** plugin-api 1.84.0, channel-sdk 0.3.10; no migration; the operator view is
  unchanged.

## More Information

- Kernel: `middleware/src/execution/executionAuthorizationService.ts` (`closingEventTime`,
  `deadlineWaitBound`, closing purposes), `middleware/packages/plugin-api/src/executionAuthorization.ts`.
- Tests: `middleware/test/executionScopes.pg.test.ts`, block "#2090 closing limits, closing
  purposes and the bounded deadline wait", including criterion 59 across the kernel boundary
  in both orders of the jobs due at the deadline.
- Kernel (private replies): `middleware/src/channels/privateMessageRouter.ts`,
  `middleware/packages/harness-orchestrator/src/facilitatorAgent.ts`,
  `middleware/packages/harness-channel-sdk/src/turnOrigin.ts`; test
  `middleware/test/privateMessageRouter.test.ts`.
- Plugin: `omadia-agent-facilitator` `src/engine/scopes.ts` (closing scopes opened with
  `eventAt`, session closings opened before the wait, purposes per scope),
  `src/engine/privateMessages.ts` (reply binding, lettered choices, private stop); tests
  `tests/closingScopes2090.test.ts`, `tests/scopeTargets2090.test.ts`,
  `tests/sessionClose.test.ts` (criterion 59 in both job orders).
