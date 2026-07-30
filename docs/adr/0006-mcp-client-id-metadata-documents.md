# 0006 — Client ID Metadata Documents coexist permanently with manual OAuth clients

## Status

Accepted

- **Date:** 2026-07-30
- **Deciders:** omadia maintainers
- **Supersedes:** —

## Context and Problem Statement

omadia has shipped a provider-agnostic MCP OAuth 2.1 + PKCE stack since epic
#459 W9. To obtain the OAuth client it presents to an authorization server it
had two paths: RFC 7591 Dynamic Client Registration (DCR), and a client an
operator registers once by hand. The MCP authorization spec now deprecates DCR
in favour of **Client ID Metadata Documents (CIMD)**, where the `client_id` is
an https URL the authorization server *dereferences* to read `redirect_uris`
and `client_name`.

Issue #546 framed CIMD as "the enterprise answer" and implied the manual client
was a stopgap. Should omadia adopt CIMD as the new default and sunset the manual
path?

## Decision Drivers

- **The two real IdPs in enterprise deployments — Microsoft Entra ID and Okta —
  do not support CIMD.** They use pre-registered app registrations. For them the
  manual client is not a workaround; it is the protocol-correct path.
- **CIMD inverts the network direction.** Every other mode only requires omadia
  to reach *out*: a redirect the operator's browser follows, an outbound token
  POST. CIMD requires the identity provider to reach *in* and GET a URL on
  omadia's own host. That is a strictly stronger requirement.
- Many omadia installs are on-premises or behind a corporate firewall and have
  **no inbound HTTPS route at all**. A design that needs one cannot be the only
  path.
- DCR's deprecation is on a 12-month clock, and brokers that only offer DCR must
  keep working throughout.
- Single tenancy: **no table in any migration carries a tenant column.** One
  omadia install serves one organization, so a CIMD `client_id` identifies the
  whole install.

## Considered Options

- **A — CIMD as one link in an explicit chain; manual stays permanent.**
- **B — CIMD as the default, manual deprecated behind a compatibility flag.**
- **C — byte5 hosts a metadata relay so every install gets a working
  `client_id` regardless of inbound reachability.**

## Decision Outcome

Chosen option: **A**.

The client-acquisition chain is explicit and ordered:

```
stored → cimd → dcr (deprecated, warns) → manual → McpOAuthNeedsClientError
```

CIMD is attempted **only** when both sides agree it can work: the authorization
server advertises `client_id_metadata_document_supported`, a metadata URL is
configured, and the document is verifiably reachable. Any of those failing makes
the chain fall through — never fail.

**Option C was rejected outright.** A byte5-hosted relay would mean every
customer's `client_id` is a URL on a byte5 domain, so every customer's OAuth
client would *identify byte5* to that customer's identity provider. That is
wrong on identity grounds before it is wrong on availability grounds, and it
inserts byte5 into a customer's authorization path. It is not offered by
default, and it is not planned.

**Option B was rejected** because it inverts which path is load-bearing: it
would deprecate the only mode Entra ID and Okta can use.

### Consequences

- 🟢 **Good:** CIMD removes the app-registration step at MCP-native brokers
  (Smithery-class) without changing anything for IdP-backed servers.
- 🟢 **Good:** A firewalled install degrades cleanly. The metadata endpoint
  answers **501 with an actionable message**, not 500, and the manual path keeps
  working untouched.
- 🟢 **Good:** DCR keeps working and merely logs a deprecation notice, so no
  broker breaks on our timeline.
- 🔴 **Bad:** Three acquisition modes is more surface than two. Mitigated by
  making the chain a single ordered function and surfacing the resolved mode in
  the UI, so an operator can always see which one applies and why.
- 🔴 **Bad:** Reachability cannot be *proven* from inside the process — only the
  IdP's own network can answer it. We check the conditions that make the answer
  definitively "no" (see below) and treat a "yes" as a strong necessary
  condition, not a guarantee.
- ⚪ **Neutral:** `mcp_oauth_clients.registered_via` gains `'cimd'` and a
  `client_metadata_url` column (migration `0032`).

## Deployment note

**CIMD requires inbound HTTPS reachability.** Set `FLOW_PUBLIC_BASE_URL` to an
https origin this deployment is reachable at **from the internet**. The identity
provider fetches `GET {FLOW_PUBLIC_BASE_URL}/.well-known/omadia-mcp-client`
itself; an origin that only resolves inside your network will not do.

- The metadata URL is derived from `FLOW_PUBLIC_BASE_URL` **alone** —
  deliberately not the `?? PUBLIC_BASE_URL` fallback the redirect URI uses,
  because `PUBLIC_BASE_URL` defaults to `http://localhost:3979`, exactly the
  shape that is not inbound reachable. Requiring an explicit declaration means an
  unconfigured install lands in the clean degraded state rather than publishing a
  `client_id` no provider can fetch.
- It is derived from **config, never from the inbound `Host` header**, so it is
  stable across restarts and proxy hops. The URL *is* the `client_id` and stored
  `mcp_oauth_clients` rows reference it.
- The served `redirect_uris` must equal `McpOAuthService.redirectUri` exactly. If
  they diverge, the authorization server matches the authorize request's
  `redirect_uri` against the document, finds no match, and every code exchange
  fails — at the provider, far from the cause. Both are wired from one variable
  in `index.ts`, and `middleware/test/mcpOAuth.test.ts` asserts the equality.
- **If inbound access is not possible, nothing is broken.** Register a one-time
  OAuth client per issuer in the MCP Control Center. That path is fully
  supported, permanently, and is the correct path for Entra ID and Okta.
- **A byte5-hosted metadata relay is not offered by default** — see Option C
  above.
- **Single tenancy is the reality.** No migration defines a tenant column. One
  install serves one organization, `mcp_oauth_clients` is keyed by issuer alone,
  and the CIMD `client_id` identifies the install as a whole. Do not read
  multi-tenancy into this schema.

### Reachability check

The probe (`services/mcpCimd.ts`) reuses `assertPublicHttpsUrl` from
`services/ssrfGuard.ts` — the same guard the RFC 9728 / RFC 8414 discovery chain
uses, deliberately not a second validator. It rejects:

1. no configured public base origin;
2. plain http, and RFC 1918 / loopback / link-local / CGNAT literals,
   `.internal` / `.local` names, and hostnames that DNS-resolve into those
   ranges;
3. a URL that does not serve *our* document — the fetched document's `client_id`
   must equal the URL fetched, so a catch-all proxy route answering `200` with
   something else is caught.

The verdict is cached (5 min, single-flight) because it runs on every MCP Control
Center status poll.

## Security properties preserved

- A CIMD client is **public by construction**: the document is world-readable, so
  there is no client secret and PKCE alone protects the exchange.
  `token_endpoint_auth_method` is `"none"` — an accurate claim, not a shortcut.
- The metadata document carries **no secret**: only the redirect URI and a
  display name, both of which the IdP already sees during the authorize
  round-trip.
- Tokens stay in the vault namespace; `mcp_oauth_tokens` holds refs only.
- No token, `code`, or `code_verifier` reaches a log line — OAuth error text goes
  through `services/secretRedaction.ts`.
- `mcp_oauth_flows` TTL is enforced in two places (verified, not assumed): an
  opportunistic prune of rows older than 15 minutes on every flow create, and an
  age-bounded `DELETE … RETURNING` on consume, so a leaked stale `state` cannot
  be redeemed later even if no prune has run.
- The flow-bound endpoint pinning and the RFC 9207 `iss` validation added in W0-1
  are untouched.

## More Information

- Issue #546 (CIMD half, W2-4). The issue body's premise that the registry
  "supports only static headers with `secretRef`" is **incorrect** — the full
  OAuth 2.1 + PKCE stack shipped in epic #459 W9.
- Implementation: `middleware/src/services/mcpCimd.ts`,
  `middleware/src/services/mcpOAuthService.ts` (`ensureClient`),
  `middleware/src/routes/mcpClientMetadata.ts`,
  `middleware/src/auth/publicPaths.ts`,
  `middleware/migrations/0032_mcp_oauth_cimd.sql`.
- Tests: `middleware/test/mcpOAuth.test.ts`,
  `middleware/test/publicPaths.test.ts`,
  `middleware/test/mcpOAuthCimdMigration.pg.test.ts`.
