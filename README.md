# Omadia

> An Agentic OS — a self-hostable platform for plugin-based AI agents.

Omadia is a runtime that lets you compose multi-agent systems out of plugins:
channels (Teams, Telegram, web chat), integrations (Microsoft 365, Odoo,
Confluence, …), capability providers (knowledge graph, embeddings, image
generation, web search), and reference agents you can fork as starting points.

The platform is designed around a **single-tenant, self-hostable** deployment
model. You bring your own LLM API key, run the stack on a single machine
(Docker Compose) or fly.io app, and own all data.

> **Status — pre-1.0.** Public preview. APIs and database schemas may break
> between minor versions until `1.0.0`. Production use of the OSS distribution
> is supported but the upgrade path is hand-rolled today; an automated
> migration runner is on the v1.0 roadmap.

## Quickstart (~60 seconds after the first image pull)

```bash
git clone https://github.com/byte5ai/omadia.git
cd omadia

# 1. Provide an Anthropic API key. Other env vars have sane local defaults.
cp infra/.env.example infra/.env
$EDITOR infra/.env                                   # set ANTHROPIC_API_KEY=...

# 2. Bring up the stack (postgres + middleware + admin UI).
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d

# 3. Open the management UI and complete the first-admin wizard.
open http://localhost:3300                           # /setup walks you through
```

The first user-creation flow lands on `/setup`. Once an administrator exists,
`/setup` self-locks (returns `410 Gone`) and the regular `/login` page takes
over.

### Optional Compose profiles

```bash
# Mermaid / PlantUML / Vega rendering for the diagrams plugin
docker compose -f infra/docker-compose.yml --profile diagrams up -d

# In-tenant embeddings via Ollama (no external API required)
docker compose -f infra/docker-compose.yml --profile embeddings up -d

# Presidio NER sidecar for the privacy-proxy detector plugin
docker compose -f infra/docker-compose.yml --profile privacy-presidio up -d

# All optional profiles in one command
docker compose -f infra/docker-compose.yml \
  --profile diagrams --profile embeddings --profile privacy-presidio up -d
```

## What's in the box

- **Plugin runtime** — channels, integrations, tools, sub-agents, capability
  providers; everything is a plugin behind a stable API surface
  ([`@omadia/plugin-api`](middleware/packages/plugin-api))
- **Builder** — UI-driven plugin authoring with codegen, slot-typecheck,
  in-process ESLint auto-fix, and a runtime smoke harness
- **Knowledge graph** — pgvector-backed (Postgres) with an in-memory
  alternative for tests
- **Channels** — web-chat (admin UI) is in-tree; Teams + Telegram are
  shipped as separately-distributed plugin ZIPs
- **Auth** — multi-provider login (local password + OIDC), per-provider
  user table, admin UI for provider toggle and user management
- **Routines** — user-authored cron-triggered agent runs with full per-run
  trace + call-stack viewer

## Architecture

```
         ┌────────────────────────────────────────────────────────────┐
         │                       Channels                             │
         │  web-chat   Teams   Telegram   …                           │
         └────────────────────┬───────────────────────────────────────┘
                              │  ChannelSDK (SemanticAnswer)
                              ▼
         ┌────────────────────────────────────────────────────────────┐
         │                      Orchestrator                          │
         │  routes turns to agents, manages tool dispatch, streaming  │
         └────────────────────┬───────────────────────────────────────┘
                              │  ctx (PluginContext)
                              ▼
         ┌────────────────────────────────────────────────────────────┐
         │                        Plugins                             │
         │  agents  ·  tools  ·  capability providers  ·  integrations│
         └────────────────────┬───────────────────────────────────────┘
                              │
        ┌─────────────────────┴────────────────────────────┐
        ▼                     ▼                            ▼
  Knowledge Graph       Embeddings                  Vault (secrets)
  (Postgres + pgvector) (Ollama / API)              (AES-256-GCM file)
```

A more detailed walk-through of the plugin loading sequence, capability
registry, and the multi-provider authentication layer lives under
[`docs/`](docs/).

## Plugin development

Omadia plugins are self-contained ZIP files that the operator uploads through
the admin UI. The platform never trusts external npm registries at runtime —
plugins ship `node_modules` baked in (or use the platform's standard library
via `@omadia/plugin-api`). Two reference plugins are shipped in-tree as
starting points:

- [`agent-reference-maximum`](middleware/packages/agent-reference-maximum) —
  exercises every capability in the plugin API
- [`agent-seo-analyst`](middleware/packages/agent-seo-analyst) — a smaller,
  focused tool-only example

The Builder UI walks operators through cloning either reference, slot-filling
the differentiating logic, and verifying with the smoke runner before install.

## Deployment

- **Local / single-tenant** — `docker compose up`, see Quickstart above
- **Fly.io** — single-app deployment, multi-region supported. The compose
  stack and the Fly image are baked from the same `Dockerfile`.
- **Bring-your-own** — the runtime is a stock Node + Postgres app; any host
  capable of running both works (Kubernetes, ECS, plain VM).

## Status & Roadmap

This is the public preview release. Stability promises are **scoped to the
documented plugin API only**; everything else (database schema, internal
service surfaces, admin-UI routes) may evolve without notice until `1.0.0`.

Active development tracks:

- **Plugin marketplace** — discovery + signed-package distribution (post-1.0)
- **Multi-tenant hosting** — out of scope for v1; a separate fork is planned
- **Web-IDE for plugin development** — moves the Builder authoring loop into
  the management UI without round-tripping through ZIP uploads (post-1.0)

## License

[MIT](LICENSE) — Copyright (c) 2026 byte5 GmbH

Third-party dependency licenses and notices are documented in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The dependency tree is
free of GPL, AGPL, and SSPL packages; weak-copyleft components (LGPL via
`sharp-libvips`, MPL-2.0 via `axe-core` / `lightningcss` / `dompurify`) are
used as documented unmodified dependencies.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev setup, commit-message
convention, and pull-request workflow. The
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1) applies
to all interactions in issues, pull requests, and discussions.

## Security

Found a vulnerability? **Please do not open a public issue.** See
[`SECURITY.md`](SECURITY.md) for the coordinated-disclosure process and the
private contact channel.

## Maintainership

Omadia is maintained by [byte5 GmbH](https://byte5.de) under the GitHub
organisation [`byte5ai`](https://github.com/byte5ai). Outside contributions
are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
