# 0196 — CLI sub-agents of operator tools run outside the Privacy Shield; the conductor builder maps a privacy refusal to "unavailable"

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Owner (byte5) — decided after the recommendation of the wave-5 recheck,
  reversible (#2241)
- **Supersedes:** — (addendum to [ADR-0165](0165-model-gateway-is-an-admission-check-per-adapter.md)
  and [ADR-0195](0195-cli-path-runs-under-the-privacy-shield.md))

## Context and Problem Statement

ADR-0165 refused CLI turns under a privacy guard, but only for top-level agents:
`createCliSubAgent` passes no `privacyGuarded`. Two operator tools use it outside any chat
turn: the plugin Builder agent (`src/plugins/builder/builderAgent.ts`) and the Builder preview
chat (`previewChatService.ts`). Their API-key path (`LocalSubAgent`) runs outside the shield as
well; only `OMADIA_PRIVACY_FORCE_GUARDED` refuses them (#1540). ADR-0195 now masks the CLI path
through a turn's privacy handle, but an operator job has no turn and so no handle. Separately,
the workflow builder runs on the instance's default agent (ADR-0012) and read a privacy
refusal as the model's reply.

Do the operator tools' CLI sub-agents refuse on a guarded instance, or run as operator jobs
outside the shield? And how does the workflow builder treat a refusal?

## Decision Drivers

- The same rule for an operator tool on either provider; the API-key path is the precedent.
- The shield guards end-user conversations; Builder and preview are admin tools over the
  operator's own draft (ADR-0056, ADR-0059).
- The org policy `OMADIA_PRIVACY_FORCE_GUARDED` must keep refusing everything unguarded.
- A refusal must never be parsed as a workflow graph.

## Considered Options

- **A — Operator jobs outside the shield**, refused only under the org policy, on both providers
- **B — Refuse operator-tool CLI sub-agents whenever a guard is installed**
- **C — Give operator jobs a privacy handle of their own**

## Decision Outcome

Chosen option: **A** (decision after recommendation, reversible).

- The Builder agent and the preview chat are operator jobs. Their CLI sub-agents run outside
  the Privacy Shield, exactly like their API-key sub-agents; `OMADIA_PRIVACY_FORCE_GUARDED`
  refuses them (the preview before anything runs, the CLI sub-agent before the spawn).
- A CLI sub-agent asked inside a guarded turn (`ask_<slug>` on a CLI host) is not an operator
  job: it masks through the calling turn's handle (ADR-0195).
- The conductor workflow builder throws `ConductorBuilderUnavailableError` (503) when its
  default agent answers with a privacy refusal: the CLI refusal (`isCliPrivacyRefusal`) or the
  blocked prompt-mask notice (`isPromptMaskBlockedNotice`), instead of parsing it as a reply.

### Consequences

- 🟢 **Good:** One rule for operator tools on both providers; Builder keeps working on guarded
  instances that use the subscription.
- 🟢 **Good:** The workflow builder reports "unavailable" instead of a nonsense draft.
- 🔴 **Bad:** Draft and tool content of an operator job reach the model unmasked on a guarded
  instance unless the org policy is set; this was already true on the API-key path.
- ⚪ **Neutral:** Option C (a handle per operator job) stays possible as a later ADR if an
  operator wants the Builder guarded too.

## Pros and Cons of the Options

### A — Outside the shield, org policy refuses

- 🟢 Matches the API-key path and #1540; no new state.
- 🔴 No masking for operator content.

### B — Refuse under any guard

- 🟢 Strictest.
- 🔴 Builder breaks on guarded subscription instances while the same Builder on an API key runs
  unmasked; the two paths would disagree.

### C — Handle per operator job

- 🟢 Masked operator jobs.
- 🔴 Needs a receipt and restore story for draft content (code, manifests) the shield's
  detectors were not built for.

## More Information

- Code: `src/conductor/builderAgent.ts` (`isPrivacyRefusalReply`),
  `harness-orchestrator/src/cliChatAgent.ts` (`isCliPrivacyRefusal`).
- Tests: `test/conductorBuilder.test.ts`, `test/cliBridge/cliPrivacyMasking.test.ts`.
- Issue: #2241.
