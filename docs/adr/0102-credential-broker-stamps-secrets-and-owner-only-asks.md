# 0102 — Credential keychain: the broker stamps the secret onto the request; only the owner approves an ask

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); issue
  #578 (PR #772 broker, PR #774 asks), hardening #778 S1 (PR #1203) and S3a (PR #1205).
  "No break-glass" on approval is recorded in the code as maintainer decision D2.

## Context and Problem Statement

This record is retroactive: it documents a decision that is implemented on main.

Plugin secrets in the vault belong to a plugin and are read by its code. Some credentials
belong to a person (a personal API token) or to the organisation as a whole, and agents
should be able to act with them. Handing an agent the secret puts it into a model context,
a transcript and every tool it can call. Before #778 S1 the asks router also took every
identity from the request body, so any signed-in session could approve an ask it did not
own. How can an agent use a credential it must never see, and who decides that it may?

## Decision Drivers

- The secret never reaches the caller, in the success path or any failure path.
- A credential is usable only where it was declared for: host, method, path.
- The person who owns a credential decides about it; nobody else, an admin included.
- Outage and denial must be distinguishable; neither may fall through to "allowed".
- Reuse the scope and grant model (#575) where it fits, and say where it does not.

## Considered Options

- **A — Two credential kinds; a fail-closed egress broker for `service`; owner-approved
  asks for `personal`; a dedicated grant table.**
- **B — Give agents the secret through a tool result** and rely on masking.
- **C — Encode credential grants as capability strings in the existing `GrantStore`.**
- **D — Reuse Conductor awaits for asks, with an operator override on approval.**

## Decision Outcome

Chosen option: **A**.

- **Two kinds** (`@omadia/channel-sdk` `credentials.ts`). `service`: organisation-wide,
  reachable only through the broker, with an egress declaration (`host`,
  `injectionScheme` of `bearer` | `header` | `basic-password` | `query-param`,
  `allowedMethods`, `pathPrefixes`). `personal`: owned by one principal, who is asked.
- **Grants are their own table** (migration `0042_credentials.sql`): mode `once` | `standing`,
  purpose, expiry, revocation. Stores do not own the pool and throw on failure rather than
  report "no grant".
- **The broker** (`credentials/broker.ts`) checks credential, grant, declared host, method
  and path, then consumes a `once` grant atomically as the last gate, decrypts, stamps the
  secret itself and returns only the response. Every violation denies, is counted
  (`brokerMetrics.ts`) and can be audited; denial messages carry neither the secret nor a
  raw store error.
- **Paths are matched as they go on the wire** (`requestMatching.ts`): both sides are
  normalised and serialised the way `fetch` does, and a prefix must end on a `/` boundary,
  so `..`, `%2e%2e`, `\` and `/v1extra` do not pass a `/v1` prefix.
- **Egress hardening.** Redirects are never followed; one timeout covers headers and body
  (20 s default); the body is read under a byte cap (1 MiB default); caller headers pass a
  static allow-list with no `x-*` wildcard; the secret is scrubbed from response headers and
  body in every form it travels in (raw, base64, URL-encoded, JSON-escaped).
- **Asks** (`credentials/asks.ts`, `/api/v1/admin/credential-asks`). The caller is
  `user:<omadia_user_id>` from the session and only from there; a client-supplied identity
  is rejected with `400 credential_ask.identity_from_session`, not ignored. The owner is
  derived from the credential. Approve and deny are owner-only (`403
  credential_ask.forbidden`) with no operator or admin override. Askability is checked
  under `FOR SHARE` at create and again at approve; a credential revoked in between closes
  the ask as `expired` and mints no grant. Claim-then-act: one `UPDATE … WHERE status =
  'pending'`, and claim plus grant in one transaction.
- **Backend choice is explicit** (`credentialStoreFactory.ts`): Postgres when a pool exists,
  otherwise in memory and lost on restart. No auto-detection by environment variable.

### Consequences

- 🟢 **Good:** A credential named for the wrong host is a `host-not-allowed` denial, not an
  exfiltration.
- 🟢 **Good:** The right to approve cannot be routed to a principal the requester chose.
- 🔴 **Bad:** The agent-facing tool (#778 S3b) is not wired: `CredentialBroker` is not
  constructed in `middleware/src/index.ts` on main. Only the asks route and the stores are
  live, so the boundary is built and tested but not yet exercised by agents.
- 🔴 **Bad:** Secrets shorter than 8 characters are not scrubbed from responses; refusing
  them at creation is open (#778 S2).
- 🔴 **Bad:** No break-glass: an owner who has left blocks every ask on their credentials.
- 🔴 **Bad:** An owner learns of an ask only by listing it; a chat notice is a follow-up.
- ⚪ **Neutral:** Vendor headers (`Notion-Version`) need a per-credential allow-list.

## Pros and Cons of the Options

### A — Broker and owner-approved asks

- 🟢 The model never holds the secret; least privilege per request.
- 🔴 A second grant table and a broker that must anticipate upstream behaviour.

### B — Secret through a tool result

- 🟢 Any HTTP tool works.
- 🔴 The secret enters the context window and every log of it.

### C — Capability strings

- 🟢 One grant store.
- 🔴 A capability is a bare boolean: no expiry, purpose, once-vs-standing or revocation trail.

### D — Conductor awaits, operator override

- 🟢 An existing pending-human-action table.
- 🔴 `conductor_awaits` rows belong to a run and a step; an ask has neither. An override
  makes "personal" mean "personal unless an admin disagrees".

## More Information

- Code: `middleware/src/credentials/`, `middleware/src/routes/credentialAsks.ts`,
  `middleware/packages/harness-channel-sdk/src/credentials.ts`,
  `middleware/migrations/0042_credentials.sql`, `0043_credential_asks.sql`.
- Tests: `middleware/test/credentialBroker*.test.ts`, `credentialRequestMatching.test.ts`,
  `credentialAsks.test.ts`, `credentialAskRoutes.test.ts`,
  `postgresCredentialAskStore.pg.test.ts`, `credentialStoreFactory.test.ts`.
- Docs: `docs/security-architecture.md` §10c, §10n.
- Related: [ADR-0112](0112-secret-vault-and-credential-keychain-two-master-keys.md),
  [ADR-0110](0110-principal-is-a-typed-user-or-role.md), ADR-0005, ADR-0016.
