# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security concerns.** Public
issues are visible to the world the moment they're filed; an attacker can
weaponise the disclosure before a fix lands.

Instead, report privately via either channel:

- **Email** — `security@byte5.de` (preferred). PGP key on request.
- **GitHub Security Advisory** — open a [private
  advisory](https://github.com/byte5ai/omadia/security/advisories/new)
  on this repository.

Please include:

1. A description of the vulnerability and the version / commit affected.
2. Reproduction steps or a proof-of-concept (a minimal failing test is
   ideal).
3. Your assessment of the impact (confidentiality / integrity / availability).
4. Any mitigations you've already considered.

We aim to acknowledge reports within **2 business days** and to ship a fix
or a documented workaround within **30 days** for high-severity issues. We
will coordinate disclosure timing with you and credit the reporter unless
you ask to remain anonymous.

## Scope

In scope:

- The `omadia` platform code in this repository (middleware, web-dev,
  plugin-api, channel-sdk, orchestrator, knowledge-graph, embeddings,
  diagrams, verifier).
- The reference agents shipped in-tree (`agent-reference-maximum`,
  `agent-seo-analyst`).
- The Compose stack and Fly image artefacts produced from this repo.

Out of scope:

- Plugins distributed as separate ZIPs (Teams, Telegram, Microsoft 365,
  Odoo, Confluence) — those have their own disclosure channels via byte5.
- Third-party dependencies — please report upstream first; we'll bump the
  pinned version once a CVE is published.
- Issues that require already-elevated access (e.g. an admin compromising
  another admin's session via the admin UI itself) — these are operational
  hardening topics, not vulnerabilities, and should be filed as regular
  enhancement issues.

## Handling secrets in this repository

Operator secrets — `ANTHROPIC_API_KEY`, `MICROSOFT_APP_*`, OAuth client
secrets, `VAULT_KEY`, plugin-specific API keys — must **never** be checked
into the repository. The development workflow exclusively uses
`infra/.env.example` as a template; the populated `infra/.env` is
`.gitignore`d.

If you discover a secret in the git history, please:

1. Notify `security@byte5.de` immediately so the secret can be rotated.
2. Open a private advisory if the secret has been pushed to the public
   remote.

We rotate exposed secrets first and patch the leak second.

## Supported versions

During the pre-1.0 phase, only the **most recent minor release** receives
security fixes. After `1.0.0`, the support matrix will widen to the previous
two minor releases.

| Version    | Supported |
|------------|-----------|
| `main`     | yes       |
| `0.1.x`    | yes       |
| pre-`0.1`  | no        |
