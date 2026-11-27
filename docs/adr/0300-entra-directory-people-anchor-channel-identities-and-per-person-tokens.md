# 0300 — Entra directory people anchor channel identities and per-person tokens; they are not accounts

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 7, W40; issue #2335). Owner direction of 2026-11-27: not every Teams user gets an omadia web login. The shape below follows the wave 7 recommendation and can be reversed.
- **Supersedes:** —

## Context and Problem Statement

Per-person tokens (a `per_user` MCP OAuth connection today, other personal credentials later)
need a stable person to attach to. Today that person is a web login: the token is stored under
the session `sub` ([ADR-0175](0175-mcp-oauth-callback-completes-only-for-the-starter.md)), and a
channel turn reaches it only when an operator linked the channel account to an account
([ADR-0225](0225-channel-account-links-to-an-omadia-user-only-through-the-kernel.md),
[ADR-0280](0280-channel-account-link-is-an-operator-offer-redeemed-by-the-channel.md)).

Most Teams users of a tenant will never get a web login: every account is an administrator
([ADR-0113](0113-sign-in-providers-behind-one-contract-and-a-single-admin-role.md)), so an
account is not something to hand out to every colleague. Those colleagues still talk to the
agents in Teams, and some of them should be able to connect their own Notion, GitHub, … account.
Who is that person, who keeps the list current, and what happens when they leave the tenant?

## Decision Drivers

- A person without a web login must never become an administrator by being known.
- The tenant's Entra directory is the truth about who works there and who left.
- The kernel holds no Microsoft Graph credentials. The Teams plugin already owns the app
  registration and its `User.Read.All` grant (people directory, e-mail resolution).
- Identity stays the kernel's ([ADR-0110](0110-principal-is-a-typed-user-or-role.md),
  [ADR-0225](0225-channel-account-links-to-an-omadia-user-only-through-the-kernel.md)): a plugin
  feeds data; it never says "this turn is person X".
- Memory ownership ([ADR-0180](0180-web-chats-belong-to-the-creating-account.md),
  [ADR-0181](0181-a-new-memory-belongs-to-its-saver.md),
  [ADR-0183](0183-memorable-knowledge-is-private-unless-shared-on-purpose.md)) must not get a
  second owner namespace.
- Someone who leaves the tenant loses what was personal to them without an operator having to
  notice.

## Considered Options

- **A — A kernel directory of people, fed by a channel-contributed Entra source (Graph delta).**
- **B — Create a `users` row (account) for every Entra user.**
- **C — The kernel calls Graph itself with the Entra sign-in app registration.**
- **D — No directory: a token per channel identity.**

## Decision Outcome

Chosen option: **A**.

- **A directory person is not an account.** `directory_people` (core migration) holds one row
  per `(source, tenant_id, external_id)`: source `entra`, the tenant id, the AAD object id, UPN,
  mail, display name, `account_enabled`, `status` (`active` | `deprovisioned`), first seen,
  last synced, deprovisioned at. A person has no password, no session, no role and appears in
  no account list. `users` stays the list of web logins (administrators).
- **The source is a channel contribution, the store is the kernel's.**
  `CoreApi.registerDirectorySource?(channelId, source)` (channel-sdk, optional,
  feature-detected) takes `{ source: 'entra', tenantId, delta(cursor?) }`. One source per
  tenant, and an `entra` source only from the plugin that holds the `teams` channel type (a
  source can deprovision a whole tenant); the first plugin to register a tenant owns it, a
  foreign re-registration throws,
  deactivation drops it (the registry rule of
  [ADR-0135](0135-channel-plugin-contract-and-channel-type-ownership.md)). The Teams plugin
  implements it with Graph `GET /users/delta` (`id, displayName, mail, userPrincipalName,
  accountEnabled, userType`), members only: guests and resource accounts are not people of
  this tenant.
- **Sync.** The kernel runs each source on registration, then every 6 hours, and on the
  operator's "Sync now". The first run (no stored cursor) is a full read; later runs send the
  stored delta link. Pages are applied as they come; the new cursor is stored only after the
  last page, so a broken run repeats from the old cursor. A cursor the source rejects
  (`resync`) starts a full read. One run per tenant at a time. State and the last error live in
  `directory_sync_state`.
- **Deprovisioning.** A person is deprovisioned when the delta reports them removed, when
  `accountEnabled` becomes false, or when a *completed* full read did not contain them (never
  after a failed or partial run, and never when that read misses more than half of at least ten
  active people: the run then fails with `last_error` and deprovisions nobody). Deprovisioning, in this order: an audit row
  `directory_person.deprovision` (a failed audit write is logged and does not keep a leaver's
  tokens), the person's per-person MCP tokens are revoked and deleted server by server
  ([ADR-0168](0168-mcp-oauth-token-lifecycle-invalidation-marks-and-revoke-on-disconnect.md);
  a server that fails sets `revoke_pending`, retried before every later run),
  channel identities linked to the person are unlinked, the row turns `deprovisioned`. Memories,
  chats and datasets stay: erasing a person is the operator's user purge
  ([ADR-0186](0186-user-purge-erases-one-person.md),
  [ADR-0262](0262-user-purge-covers-linked-identities-and-ends-account-sessions.md)); the
  directory view offers it. A person enabled again turns `active`; tokens are not restored.
- **The person key.** A directory person's per-person tokens are keyed on the AAD object id.
  That is the same key an Entra web login of the same person uses (its session `sub` is the
  `oid`), so a person who later gets a web login keeps their connections, and an administrator
  who has one sees the same connections in Teams. A person with a web login is shown with it
  (`users.provider = 'entra'`, `provider_user_id = oid`); nothing else joins the two lists.
- **Turns.** A Teams turn whose sender (`origin.channelType = 'teams'`, `userId` = AAD object
  id) is an active person keys `per_user` MCP tokens on that object id. That trusts the
  channel's attestation exactly as far as the kernel's per-plugin origin check allows
  ([ADR-0302](0302-a-turn-origin-channel-type-is-checked-against-the-calling-plugin.md)). A
  deprovisioned or unknown sender gets no directory key; a Teams identity the dispatcher minted
  keeps the cluster key it had before this record.
- **Linking other channels.** Telegram, WhatsApp, Slack, Discord, iMessage reach a directory
  person only through the operator link of ADR-0280. The link offer may name a directory
  person instead of an account (the picker lists active people without an Entra account as
  `directory:<id>`, channel-sdk `LinkableAccount.kind = 'person'`); redeeming joins the channel identity to the cluster of the
  person's Teams identity (`teams` / AAD object id) and records `linkedDirectoryPersonId` on
  the identity node. Turns of such an identity key on the person's object id while the person
  is active; once the person is deprovisioned the turn has no identity (a minted identity) or
  its raw channel id (an origin-stated one). No channel claims a person on its own.
- **Reactivation needs evidence.** A deprovisioned person turns `active` again only when the
  source reports the account enabled, or a full read lists them enabled; a delta that only
  renames them does not.
- **Memory ownership is unchanged.** Memories, chats and datasets belong to the knowledge-graph
  User-Cluster, as before. A directory person is an attribute of the cluster that holds their
  Teams identity (the same cluster an Entra login joins by object id), never an owner of its own.
  A linked Telegram identity writes into that cluster from the link on, like an account link.
- **Admin UI.** "Directory" in the admin area: sync state per tenant with "Sync now", the
  people list (search, status, web login yes/no, linked channel identities, connected MCP
  servers), and per person: unlink a channel identity, revoke a connection. Every operator act
  is audited ([ADR-0100](0100-admin-audit-trail-one-actor-rule.md)).

### Consequences

- 🟢 **Good:** A colleague without a web login can have personal connections, and loses them
  when they leave the tenant, without an operator noticing first.
- 🟢 **Good:** No account is created for anyone; the administrator boundary of ADR-0113 holds.
- 🟢 **Good:** One person key across Teams, linked channels and an Entra web login.
- 🔴 **Bad:** The directory needs Postgres; without a database there is none.
- 🔴 **Bad:** Without an active Teams plugin with `User.Read.All` there is no directory, and
  `per_user` servers stay web-only for channel users, as before.
- 🔴 **Bad:** Deprovisioning lags Entra by up to one sync interval (6 hours) unless an operator
  syncs; a Teams turn of a person disabled in Entra in between still keys on them.
- 🔴 **Bad:** A Teams sender is a person by the plugin's attestation (as the Teams `userRef`
  already is); the kernel narrows that to the plugin that owns `teams`, nothing more.
- ⚪ **Neutral:** The connect flow for directory people without a web session (#2312, bound to
  their Teams SSO token, no bearer link) is a follow-up record.

## Pros and Cons of the Options

### A — Kernel directory, channel-contributed source

- 🟢 Credentials stay where they are; the kernel owns identity and lifecycle.
- 🔴 A new store, a sync loop and an admin page.

### B — An account per Entra user

- 🟢 Reuses everything that keys on `users.id`.
- 🔴 Every account is an administrator; this hands the admin area to the whole tenant.

### C — Kernel calls Graph with the sign-in app

- 🟢 Works without Teams.
- 🔴 The sign-in app would need `User.Read.All` (admin consent for an application permission)
  and the kernel a Graph client; the precedent keeps Graph in the Teams plugin.

### D — Tokens per channel identity

- 🟢 No directory.
- 🔴 No one notices a leaver; a person has one token per channel; the link-holder risk of
  #2312 comes back for every channel.

## More Information

- Issues: #2335, #2312, #2324. Code: `middleware/src/directory/`,
  `middleware/migrations/0123_directory_people.sql`,
  `packages/harness-channel-sdk/src/directorySource.ts`,
  `packages/harness-orchestrator/src/resolveTurnOwnerIdentity.ts`,
  `middleware/src/channels/channelIdentityLinks.ts`, web-ui `app/admin/directory/`.
- Teams source: byte5ai/omadia-channel-teams (`teamsDirectorySource.ts`).
- Related: [ADR-0175](0175-mcp-oauth-callback-completes-only-for-the-starter.md), [ADR-0182](0182-web-and-api-turns-carry-an-account-or-key-origin.md), [ADR-0184](0184-owner-less-legacy-chats-are-assigned-by-an-operator-tool.md), [ADR-0114](0114-teams-sso-route-auth-verified-by-the-kernel.md).
- Border: identity / channels / auth.
