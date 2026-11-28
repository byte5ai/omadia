# 0290 — The credential broker reaches agents only as a granted capability in the caller's envelope

## Status

Accepted — superseded in part by [ADR-0355](0355-credential-broker-tools-run-as-the-turns-account.md) (the broker's principal is the turn's account; without one, service credentials are refused too)

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers. Design record for the agent-tool half of #778
  (wave 6, W36). Accepted by the owner on 2026-11-27; implementation is not planned yet.

## Context and Problem Statement

[ADR-0102](0102-credential-broker-stamps-secrets-and-owner-only-asks.md) fixed how the
credential broker works: it checks credential, grant, host, method and path, stamps the
secret itself and returns only the response; personal credentials are asked from their
owner. The admin routes are mounted (#792). But `CredentialBroker` is never instantiated,
no agent can call it, and an owner learns about a pending ask only by listing
(`credentials/asks.ts`: "Wiring that notification is a follow-up").

#778's original plan registered the broker as a native tool in the orchestrator registry.
That plan predates epic #2042: there is no orchestrator agent, and every capability is
granted per agent.

The question: in what form do agents reach the broker, and how is an ask delivered?

## Decision Drivers

- Agents never see secrets ([ADR-0014](0014-plugins-are-only-the-delivery-form.md));
  the broker already guarantees that by stamping.
- Calls run in the calling agent's envelope; nothing is attached without an operator
  choice ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md)).
- The asking principal comes from the session or turn, never from the caller's input
  (ADR-0102). ADR-0102's asks and owners are omadia users (`user:<omadia_user_id>`); the
  tool call context carries the conversation form `user:<channel-user-id>`
  ([ADR-0032](0032-tool-caller-principal-is-the-conversation-form.md)). On a channel turn
  the two meet only through a channel-account link, which
  [ADR-0225](0225-channel-account-links-to-an-omadia-user-only-through-the-kernel.md)
  decides and which is not built.
- Only agents and `system` speak to people ([ADR-0012](0012-agents-are-virtual-employees.md)).

## Considered Options

- **A — Kernel capability `credentialBroker@1`, granted per agent.** Tools
  `credential_request` (call a declared service through the broker) and `credential_ask`
  (ask a personal credential's owner). Not granted by default. Asks are delivered as a
  `system` notice to the owner in their own channel and answered in the admin surface.
- **B — Native tool in the global tool registry,** available to every agent.
- **C — No agent path;** credentials only for plugins.

## Decision Outcome

Chosen option: **A** (owner decision 2026-11-27).

- **A capability, not a global tool.** The broker is offered as `credentialBroker@1`; an
  agent gets the tools only through an explicit grant, and the grant can be narrowed to
  named credentials. Grant and use are audited; the agent's reach lists the declared hosts.
- **The caller is the turn's omadia user.** The kernel resolves it, never the tool input:
  on a web-chat turn from the session (`omadia_user_id`); on a channel turn from the
  channel-account link of ADR-0225. A principal in the tool input is refused, as in
  ADR-0102.
- **No link, no personal credential.** Until ADR-0225 is built, or when a channel account
  has no link, `credential_ask` and personal credentials are refused with a typed reason
  ("this account is not linked to an omadia user"); service credentials, which need no
  owner, still work under the agent's grant.
- **Results are untrusted tool output.** Broker responses pass the same screening and privacy
  shield as every tool result; the secret scrubbing of ADR-0102 stays the first line.
- **Asks notify the owner.** A new ask produces a `system` notice to the owner (not an agent
  message) with a link to approve or deny; the decision stays owner-only. The requesting
  turn is answered with "asked, pending" and the result is delivered to the requesting
  conversation when the owner decides.
- **The admin UI is a separate item.** Credential list, grants, revocation, ask inbox,
  skill promotion, sandbox and publish-version views follow ADR-0102 and the web-ui rules;
  they need no decision of their own.

### Consequences

- 🟢 **Good:** The feature behind #578 becomes reachable without widening any agent by
  default.
- 🟢 **Good:** Owners learn about asks without polling.
- 🔴 **Bad:** One more kernel capability with its own grant UI.
- 🔴 **Bad:** Personal credentials in channels depend on ADR-0225 being built.
- ⚪ **Neutral:** #778 is split into an agent-tool issue (this record) and an admin-UI issue
  (references only).

## Pros and Cons of the Options

### A — Granted capability

- 🟢 Fits ADR-0014/0016 and the reach display.
- 🔴 Needs a grant path before first use.

### B — Global native tool

- 🟢 Least code.
- 🔴 Every agent could reach every service credential; against ADR-0016.

### C — No agent path

- 🟢 No new surface.
- 🔴 The credential feature stays unreachable for agents, which was its purpose.

## More Information

- Issues: [#778](https://github.com/byte5ai/omadia/issues/778), split into
  [#2319](https://github.com/byte5ai/omadia/issues/2319) (agent tool, this record) and
  [#2320](https://github.com/byte5ai/omadia/issues/2320) (admin UI).
- Related: ADR-0102, ADR-0225, ADR-0012, ADR-0014, ADR-0016, ADR-0032.
