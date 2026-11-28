# 0355 — The credential broker tools run as the turn's omadia account; the agent grant only narrows

## Status

Accepted

- **Date:** 2026-11-28
- **Deciders:** omadia maintainers; decided while implementing #2319 (wave 9, W51), following
  the recommendation and confirmed by the wave lead. Reversible.
- **Supersedes:** in part [ADR-0290](0290-credential-broker-reaches-agents-only-as-a-granted-capability.md),
  its bullet "No link, no personal credential … service credentials, which need no owner,
  still work under the agent's grant".

## Context and Problem Statement

ADR-0290 made the credential broker an agent capability (`credentialBroker@1`, tools
`credential_request` and `credential_ask`), granted per agent and narrowable to named
credentials. It says the caller is the turn's omadia user and that, without a channel-account
link, service credentials "still work under the agent's grant".

The broker of [ADR-0102](0102-credential-broker-stamps-secrets-and-owner-only-asks.md)
checks a `CredentialGrant` for a **principal** on every call, and a principal is a user or a
role ([ADR-0110](0110-principal-is-a-typed-user-or-role.md)). An agent is neither. "Works
under the agent's grant" therefore has no principal to check against. Since ADR-0290 was
written, the channel-account link of
[ADR-0225](0225-channel-account-links-to-an-omadia-user-only-through-the-kernel.md) has been
built (`channelIdentityLinks.ts`, `resolveTurnOwnerIdentity`).

Who is the broker's principal on an agent's call, and what happens on a turn that speaks for
no omadia account?

## Decision Drivers

- The broker's per-principal grant (ADR-0102) stays the gate that decides; no second,
  weaker path around it.
- The caller comes from the turn, never from tool input (ADR-0102, ADR-0290).
- Least privilege (ADR-0016): an agent grant must not let one person use what another was
  granted.
- No new principal kind for a single feature (ADR-0110).

## Considered Options

- **A — The turn's account is the principal for every credential; the agent grant only
  narrows.** Without an account, both tools refuse with `account_not_linked`.
- **B — An agent principal** (`role:agent:<id>` or a new `agent` kind) holding its own
  credential grants for service credentials; the turn's account for personal ones.
- **C — Skip the broker's grant check for service credentials** when the agent grant names
  them.

## Decision Outcome

Chosen option: **A**.

- **Principal.** Every broker call runs as `user:<omadia_user_id>` of the account the turn
  speaks for (`turnAccountUserId`, `TurnContextValue.accountUserId`): on a web account turn
  the session's account (`isWebAccountTurn`); on a channel turn only the account an operator
  linked the channel identity to (ADR-0225). An unlinked channel identity, a directory
  person without an account, and an HTTP turn whose user id a client may have chosen speak
  for no account.
- **No account, no credential.** Without an account `credential_request` and
  `credential_ask` refuse with `account_not_linked`, for service and personal credentials
  alike. The channel account can be linked, so this is a configuration step, not a dead end.
- **Two gates, both required.** The operator's agent grant (`agent_credential_grants`,
  named credentials only, no wildcard) decides which credentials the agent may name at all
  and is the coarse `credential:broker:use` gate. The account's own `CredentialGrant`
  (ADR-0102) decides whether this call may use the credential. Neither replaces the other.
- **Not the conversation form.** `NativeToolCallContext.callerPrincipalId`
  ([ADR-0032](0032-tool-caller-principal-is-the-conversation-form.md)) names the person in the
  channel (`user:<channel-user-id>`), not an omadia account, and owners and grants of
  ADR-0102 are accounts. The tools read the kernel-resolved account from the turn context
  instead; both are kernel-stated, neither comes from the model.
- **A principal in the tool input is refused** (`identity_from_turn`), as the asks route
  refuses a client-supplied identity.

### Consequences

- 🟢 **Good:** The broker's decision is unchanged: grant, host, method, path, once/standing,
  expiry and revocation are checked for one person, as in ADR-0102.
- 🟢 **Good:** An agent granted a credential cannot use it for someone who holds no grant.
- 🔴 **Bad:** An operator must grant a service credential to every account that may use it
  through an agent, not once to the agent. A `role:` credential grant does not help today:
  the stores match the principal exactly and the broker passes only `user:<id>`.
- 🔴 **Bad:** An approved ask for a `personal` credential records a grant the broker cannot
  redeem yet, because the broker serves only `service` credentials (ADR-0102); tracked in
  [#2383](https://github.com/byte5ai/omadia/issues/2383).
- 🔴 **Bad:** Unlinked channel accounts cannot use any credential until an operator links them.
- ⚪ **Neutral:** Reversible: option B can be added later without changing the tool contract.

## Pros and Cons of the Options

### A — Turn account, agent grant narrows

- 🟢 Reuses the broker and grant model unchanged.
- 🔴 More grants to manage for org-wide service credentials.

### B — Agent principal

- 🟢 One grant per agent and service credential; works without a link.
- 🔴 Needs a third principal kind or overloads `role:`, which ADR-0110 defines as a
  late-bound holder set; every principal consumer would have to learn it.
- 🔴 Anyone who can talk to the agent uses the credential.

### C — Skip the grant check

- 🟢 Least code.
- 🔴 Weakens the security boundary of ADR-0102 for exactly the calls an agent makes.

## More Information

- Issue: [#2319](https://github.com/byte5ai/omadia/issues/2319); epic
  [#778](https://github.com/byte5ai/omadia/issues/778).
- Code: `middleware/src/credentials/credentialBrokerTools.ts`, `credentialBrokerWiring.ts`,
  `agentCredentialGrants.ts`, `middleware/migrations/0125_agent_credential_grants.sql`,
  `middleware/packages/harness-orchestrator/src/resolveTurnOwnerIdentity.ts`
  (`turnAccountUserId`).
- Related: ADR-0016, ADR-0032, ADR-0102, ADR-0110, ADR-0225, ADR-0290.
