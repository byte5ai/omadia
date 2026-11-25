# 0069 — Issues go upstream as the operator or as a scoped GitHub App, sanitized and confirmed by a human

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; in-app "Create Issue" in #363, diagnostics excerpt in #486
  (issue #433); Builder issue reporting in #101, GitHub App direct-create in #223 (issue #206).
  Recorded retroactively.
- **Supersedes:** —

## Context and Problem Statement

omadia is open source and runs on its operators' machines. Two flows send text from an
instance into the public repository `byte5ai/omadia`: an operator writes a note in the admin UI
("Create Issue"), and the Plugin Builder's model hits a failure that looks like a core bug.
Both carry text from a private installation (logs, stack traces, host names) into a public
place, and both need a GitHub identity that a shipped, public product can hold.

This record is retroactive. With which identity and under which checks does an instance file
issues upstream?

## Decision Drivers

- A distributed product cannot hold a secret; anything baked in is public.
- Nothing from an installation reaches a public repository without a human having seen it.
- The upstream must not be flooded with duplicates or with reports of users' own mistakes.
- A model must never be able to file on its own.

## Considered Options

- **A — Operator flow: GitHub device grant with a public client id, issue filed as the
  operator. Builder flow: deterministic triage, then browser-submit by the operator, or a
  GitHub App scoped to `issues:write` where the deployment configures one. Both sanitized and
  confirmed.**
- **B — A shared bot token (PAT) shipped with the product or stored in the vault**
- **C — OAuth web flow with a client secret**
- **D — Telemetry-style automatic reports**

## Decision Outcome

Chosen option: **A**.

**Operator flow** (`middleware/src/issues/`, mounted at `/api/v1/issues`):

- GitHub **device authorization grant** with the baked-in public client id
  (`DEFAULT_GITHUB_CLIENT_ID`, override `GITHUB_OAUTH_CLIENT_ID`), scope `public_repo`. There
  is no client secret and no public OAuth callback; every route is behind `requireAuth`.
- The `device_code` stays on the server (`deviceFlowStore.ts`, one flow per operator, polling
  throttled to GitHub's interval). The access token is stored in the vault under
  `core:github-connect`, keyed by the operator's session `sub`, and never returned to the
  browser.
- `POST /preview` lets the configured model rewrite the note into an English title and body
  (an operator job, `ISSUE_PREVIEW`: 3 calls, 2 minutes); the operator reviews, `POST /create`
  files it under the operator's own account.
- A diagnostics excerpt is never sent to the model. It is redacted first over the full
  excerpt and only then truncated to its newest lines, then appended as a collapsed block.

**Builder flow** (`middleware/src/plugins/builder/`, tool `omadia_report_core_bug`):

- **Triage before a person is asked** (`platformIssueTriage.ts`): a deterministic gate drops
  everything that is the draft's own problem; only failures that point into the platform
  become candidates, and a model classification must say `Platform` with confidence ≥ 0.7.
- **Dedup and quota.** A fingerprint (normalised frame path plus error code) is looked up
  among existing issues first (`githubIssueCache.ts`, unauthenticated reads, ETag, 1-hour
  cache, back-off on 403); 3 platform-class submissions per operator per 24 hours.
- **Sanitizer** (`issueBodySanitizer.ts`): credential patterns, e-mail addresses, IBANs,
  internal hosts and private addresses are replaced by `[REDACTED:<kind>]`, the body is cut at
  64 KB with a marker. The operator approves exactly that text. The operator flow reuses the
  same function.
- **Two submit paths; the server picks.** Default: a pre-filled `issues/new` URL the operator
  submits in their own browser, after which the issue number is confirmed against bot label
  and fingerprint marker. With `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and
  `GITHUB_APP_INSTALLATION_ID` set and an allow-listed upstream (`UPSTREAM_ALLOWLIST`:
  `byte5ai/omadia`): the App files it after the operator's confirmation
  (`githubIssueCreator.ts`, the only write path; the token is never logged, GitHub's response
  body is never echoed). There is deliberately no PAT path.
- **A filed issue becomes a tracked workaround** (`workaroundStateStore.ts`,
  `agent_workaround_state`), keyed by installed plugin and workaround, so a draft paused on an
  issue can be resumed when the issue closes.

### Consequences

- 🟢 **Good:** The product ships "batteries included" without a secret in the image.
- 🟢 **Good:** Every issue has a human who saw the exact text; reports are attributable.
- 🟢 **Good:** A leaked App token is short-lived, limited to issues on one repository and
  revocable centrally.
- 🔴 **Bad:** The operator flow asks for the scope `public_repo` (`GITHUB_ISSUE_SCOPES`, named
  in the code as the minimum for opening issues), which covers more than issues on one
  repository, and the resulting classic OAuth token does not expire; there is no refresh path.
- 🔴 **Bad:** The sanitizer is pattern-based and over-redacts on purpose; it reduces what the
  operator must catch, it does not replace the review.
- 🔴 **Bad:** A fork that points `GITHUB_UPSTREAM_OWNER` / `GITHUB_UPSTREAM_REPO` elsewhere
  falls off the allow-list and back to browser-submit.
- ⚪ **Neutral:** Device flows and pending Builder choices are in memory and single-process.

## Pros and Cons of the Options

### A — Device grant, App or browser, sanitize and confirm

- 🟢 No shipped secret; human in the loop; least privilege where GitHub allows it.
- 🔴 Two flows and two identities to maintain.

### B — Shared PAT

- 🟢 One code path.
- 🔴 A long-lived token in a public product or in every vault; all issues from one account.

### C — Web flow with a secret

- 🟢 Familiar.
- 🔴 The secret would be readable in the distribution; GitHub treats that as compromised.

### D — Automatic reports

- 🟢 No operator effort.
- 🔴 Private data in a public tracker without consent; noise.

## More Information

- Related: [ADR-0017](0017-model-gateway-and-execution-contexts.md) (operator jobs),
  [ADR-0002](0002-mit-license-for-oss-core.md). Border: auth-security (vault scopes, operator
  session).
- Paths: `middleware/src/issues/`, `middleware/src/routes/builderIssueReporting.ts`,
  `middleware/src/plugins/builder/{platformIssueTriage,issueBodySanitizer,githubIssueCache,githubIssueCreator,githubAppAuth,upstreamIssueConfig,workaroundStateStore,userChoiceCoordinator}.ts`,
  `middleware/src/plugins/builder/tools/reportPlatformIssue.ts`,
  `middleware/src/services/githubAppJwt.ts`.
- Tests: `middleware/test/issues/{githubOAuthProvider,issueReformulator,issuesRouter}.test.ts`,
  `middleware/test/builder/{platformIssueTriage,issueBodySanitizer,githubIssueCache,githubIssueCreator,githubAppAuth,reportPlatformIssueTool,builderIssueReportingRoutes,workaroundStateStore}.test.ts`.
