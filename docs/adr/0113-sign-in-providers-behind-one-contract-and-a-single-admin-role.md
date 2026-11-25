# 0113 — Sign-in providers behind one contract; every operator account is an administrator

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main).
  Provider-aware auth is OB-49, the runtime provider toggle OB-50 ("D1=C Hybrid").

## Context and Problem Statement

This record is retroactive: it documents the account model that is implemented on main.

The first admin UI signed operators in through one hard-coded Microsoft Entra path and an
e-mail whitelist. An open-source install has no Entra tenant and needs a local password
login; an enterprise install wants Entra only. Operators asked to switch providers on and
off without a restart. Meanwhile every route under the session gate trusts `req.session`
without asking what the user may do. Which login mechanisms exist, who decides which are
active, and what does a signed-in account stand for?

## Decision Drivers

- A fresh install must reach a working login page with no identity provider configured.
- Adding a login mechanism must not touch the login router.
- An admin with a session must not be able to enable a mechanism the deployment's owner
  ruled out.
- No half-built permission model: a role nobody enforces is worse than none.

## Considered Options

- **A — One `AuthProvider` contract, an env whitelist plus a runtime-active subset, one
  role (`admin`).**
- **B — Entra only**, with a break-glass token for installs without a tenant.
- **C — Providers as plugins from the start.**
- **D — Introduce roles (admin / member / viewer) with the provider split.**

## Decision Outcome

Chosen option: **A**.

- **The contract.** Every mechanism implements `AuthProvider` (`auth/providers/AuthProvider.ts`,
  `kind: 'password' | 'oidc'`). The login router dispatches by `provider.id` and never
  branches on the mechanism. Shipped: `LocalPasswordProvider` (argon2id, 19 MiB, t=2,
  `auth/passwordHasher.ts`; one password policy of 8..1024 characters for sign-in and every
  setter) and `EntraProvider` (authorization code with PKCE `S256` and a `state` check).
- **Who decides which are active.** `AUTH_PROVIDERS` (default `local,entra`) is the
  whitelist: the deployment owner's static decision. A provider whose secrets are missing
  is skipped with a warning. `platform_settings.auth.active_providers` is the runtime
  subset an admin toggles (`routes/adminAuth.ts`); empty means "all whitelisted". Nothing
  outside the whitelist can be enabled with a session. Toggles write
  `auth.provider_enable` / `auth.provider_disable` to the audit trail.
- **Identity.** A `users` row is `(provider, provider_user_id)`: for `local` the lower-cased
  e-mail, for OIDC the IdP's stable id. The same person signing in through two providers is
  two rows; there is no account linking. The session carries `provider` and `sub`.
- **The Entra whitelist is an access layer of its own.** `ADMIN_ALLOWED_EMAILS` gates Entra
  sessions at sign-in and on every evaluation (`auth.not_whitelisted`, 403). It lives in the
  environment, not the vault, so a vault that cannot be decrypted is not a lock-out. Local
  accounts are governed by their `users` row instead.
- **One role.** `UserRole` is the literal `'admin'`; `SessionClaims.role` is hard-typed
  `'admin'`; the column defaults to it. Every signed-in account can create users, mint API
  keys, read the audit trail and use the danger zone. Guard rails are structural, not
  role-based: an admin cannot disable or delete their own row (409
  `admin_users.self_lockout`).
- **Machines are not sessions.** An API key never populates `req.session`, because that
  type means "a human administrator is signed in"
  ([ADR-0101](0101-api-keys-as-second-authentication-method.md)).

### Consequences

- 🟢 **Good:** `docker compose up` yields a usable local login; Entra appears when its
  secrets are present.
- 🟢 **Good:** A new provider is one class and one registration.
- 🔴 **Bad:** No least privilege among operators: every account is all-powerful, and the
  audit trail is the only control between them
  ([ADR-0100](0100-admin-audit-trail-one-actor-rule.md)).
- 🔴 **Bad:** One person with a local and an Entra account has two identities, two audit
  actors and two session versions.
- 🔴 **Bad:** Code that assumes "session ⇒ admin" will have to be found again when roles
  arrive; the type makes it explicit but does not make it rare.
- ⚪ **Neutral:** Comments name "Entra as a plugin" as the intended next step; the registry
  knows no provider implementation so that this stays a registration swap.

## Pros and Cons of the Options

### A — Contract, whitelist + active subset, one role

- 🟢 Works without any IdP; runtime toggles without handing the choice to a session.
- 🔴 Two layers (env and `platform_settings`) to explain.

### B — Entra only

- 🟢 No password storage.
- 🔴 No login for an install without a tenant.

### C — Providers as plugins

- 🟢 No provider code in the kernel.
- 🔴 The plugin system itself is administered behind this login; a broken provider plugin
  would lock the operator out of the tool that repairs it.

### D — Roles now

- 🟢 Least privilege among operators.
- 🔴 Every existing route would need an authorisation decision at once; unenforced roles
  would only look like one.

## More Information

- Code: `middleware/src/auth/providers/`, `auth/providerRegistry.ts`, `auth/whitelist.ts`,
  `auth/userStore.ts`, `auth/passwordPolicy.ts`, `auth/platformSettings.ts`,
  `middleware/src/routes/{auth,authLogin,adminAuth,adminUsers}.ts`,
  `middleware/src/auth/migrations/0001_users.sql`.
- Tests: `middleware/test/auth/{providerRegistry,localPasswordProvider,adminAuthProvidersRoute,adminUsersRoute,passwordPolicy}.test.ts`.
- Docs: `docs/security-architecture.md` §10m ("One failure code"), §10q (read access).
- Related: [ADR-0103](0103-first-admin-setup-token-and-atomic-creation.md),
  [ADR-0106](0106-operator-sessions-stateless-jwt-with-server-side-revocation.md).
