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

> **Heads-up — `main` was force-pushed on 2026-05-12** to purge a documentation
> file that contained internal identifiers. The `v0.1.0` tag is unchanged, but
> if you cloned this repository before that date your next `git pull` will fail
> with `non-fast-forward` / `Updates were rejected`. To recover, discard the
> stale local history and reset to the rewritten remote:
>
> ```bash
> git fetch origin
> git reset --hard origin/main
> ```
>
> If you have local commits on top of the old `main`, cherry-pick them onto the
> new base instead (`git log` on the old SHA is still reachable locally for ~90
> days via the reflog).

## Quickstart

```bash
git clone https://github.com/byte5ai/omadia.git
cd omadia

# 1. Provide an Anthropic API key. The middleware will not boot without one.
#    Every other env var has a working default for the docker-compose stack.
cp middleware/.env.example middleware/.env
$EDITOR middleware/.env                              # set ANTHROPIC_API_KEY=sk-ant-...

# 2. Bring up the full stack. First build pulls ~3 GB of images
#    (postgres+pgvector, kroki, minio, ollama, presidio sidecar build).
docker compose up -d --build

# 3. Watch it come up — middleware needs ~60-90s on first boot for KG
#    migrations + plugin activations + ollama model pulls.
docker compose logs -f middleware

# 4. Open the management UI and complete the first-admin wizard.
open http://localhost:3333                           # /setup walks you through
```

The first user-creation flow lands on `/setup`. Once an administrator exists,
`/setup` self-locks (returns `410 Gone`) and the regular `/login` page takes
over.

### Re-running

`docker compose up -d` brings the stack back up; volumes (postgres data,
vault, memory, uploaded plugins) survive. To start completely fresh:

```bash
docker compose down -v && docker compose up -d --build
```

> **Heads up — browser localStorage**: chats are cached in the browser
> (offline-friendly). If you've ever used another Omadia instance on the
> same `http://localhost:3333` (e.g. a previous deployment), those cached
> chats will surface in this fresh install too. Browser DevTools →
> Application → Local Storage → `http://localhost:3333` → "Clear All" gives
> you a clean slate. (A first-install detection that does this
> automatically is on the v0.2 roadmap.)

### Service map

| Service | Host port | Purpose |
|---|---|---|
| `web-ui` | `3000` | Admin UI (Next.js) |
| `middleware` | `8080` | Kernel API + plugin runtime |
| `postgres` | `5432` | Postgres + pgvector — knowledge graph / routines / verifier persistence (default user/password/db: `omadia`) |
| `kroki` | `8765` | Diagram rendering (Mermaid, PlantUML, Vega, …) |
| `minio` | `9000` / `9001` | S3-compatible object storage (console: `minioadmin` / `minioadmin`) |
| `ollama` | `11434` | In-tenant embeddings + small NER model (`nomic-embed-text` + `llama3.2:3b`) |
| `presidio` | `5001` | Python NER sidecar for the privacy detector plugin (FastAPI, `~1.5 GB` first build) |

Stop the stack with `docker compose down`; add `-v` to also wipe the
persistent volumes (`middleware-data`, `postgres-data`, `minio-data`,
`ollama-data`).

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

More detailed walk-throughs of the plugin loading sequence, capability
registry, and the multi-provider authentication layer will be published
alongside the v0.2 release.

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
- **Bring-your-own** — the runtime is a stock Node service plus the
  sidecars in `docker-compose.yaml` (Kroki, MinIO, Ollama). Any host
  capable of running Docker works (Kubernetes, ECS, Fly.io, plain VM).
  Postgres is optional — without `DATABASE_URL` the kernel uses the
  in-memory knowledge graph.

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

[MIT](LICENSE) — Copyright (c) 2026 byte5.ai

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
