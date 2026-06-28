<div align="center">

<img src="docs/media/omadia-banner.png" alt="omadia" width="820">

### An Agentic OS for professionals

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Status: public preview](https://img.shields.io/badge/status-public%20preview-orange.svg)](#status--roadmap)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose-2496ED.svg?logo=docker&logoColor=white)](#-quickstart)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/byte5ai/omadia?style=social)](https://github.com/byte5ai/omadia/stargazers)

[**Website**](https://omadia.ai) · [**Quickstart**](#-quickstart) · [**Why omadia?**](#why-omadia) · [**Docs**](docs/) · [**Contributing**](CONTRIBUTING.md)

</div>

**omadia is a self-hostable agentic OS that makes AI dependable enough for real
work.** A team of agents runs on infrastructure you own and turns your data,
software, and people into results you can steer, audit, and prove. Sensitive data
stays in the house and never leaves in clear text. Every answer is checked before
it ships. Every action carries a receipt. Bring your own LLM key and switch
providers by config, not code.

#### 🎬 The 2-minute pitch

https://github.com/user-attachments/assets/644f9dae-c8a9-44af-a47f-183d2fcdcf34

---

## Prerequisites

The quickstart runs entirely in containers, so the host stays light:

- **Docker 24+** with the Docker Compose v2 plugin (the `docker compose`
  subcommand, not the legacy `docker-compose` binary)
- **Git**, to clone the repository

That is the whole list for running omadia. A local Node toolchain is only
needed when you build the services from source or develop plugins:

- **Node 22.x** for the middleware and admin UI outside Docker. The pinned
  version lives in `.nvmrc`, so `nvm use` picks it up. The middleware blocks
  installation on a mismatched major version, because native modules are
  built against a specific ABI.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full from-source setup.

## ⚡ Quickstart

```bash
git clone https://github.com/byte5ai/omadia.git && cd omadia

# 1. Bring up the minimal core: postgres + middleware + admin UI.
#    Images are pulled prebuilt from GHCR, so first boot is a download,
#    not a source build. No config needed to start.
docker compose up -d

# 2. Open the admin UI and complete the first-admin wizard.
#    The /setup wizard collects your LLM key and stores it encrypted in the vault.
open http://localhost:3333
```

`docker compose up -d` pulls exactly three services and nothing else. Open the UI,
set your LLM key in the wizard, and run your first agent team. The next section is
the 90-second "wow moment". Diagrams, embeddings, and object storage are opt-in
(see [Optional features](#optional-features)).

Pin a specific release instead of the latest with the `OMADIA_VERSION` shell
variable (or a project-root `.env` file, not `middleware/.env`), or build the
images from source instead of pulling:

```bash
OMADIA_VERSION=v0.3.0 docker compose up -d                              # pin a release
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up -d --build  # build locally
```

> **Pull fails with `manifest unknown`?** The GHCR images publish on each
> release, so a brand-new checkout can briefly predate the first published
> image. Build from source with the `--build` line above until a release lands.

## 🚀 First run: from prompt to audit receipt

<div align="center">

<img src="docs/media/omadia-demo.gif" alt="omadia no-code builder: describe an agent in plain words, the builder generates it, then try it out" width="820">

<sub>Describe an agent in plain words → the builder generates it → try it out. No code.</sub>

</div>

omadia clicks once you watch a team of agents do real work and hand you a receipt
for it:

1. Run **`docker compose up -d`**. The minimal core (postgres, middleware, admin UI) comes up together.
2. **Open `http://localhost:3333`** and finish the first-admin `/setup` wizard.
3. **Start a demo agent team** from a single prompt in the web chat.
4. **Watch it work.** The orchestrator streams turns and dispatches tools across
   the agents in the team.
5. **Open the run's trace.** The per-run call-stack viewer is your audit receipt:
   every step, every tool call, every decision, replayable.

## Why omadia?

omadia is built for the moment an agent system leaves the laptop and meets real
work: ownership, auditability, and a clean fit into an existing stack. The first
three rows are why teams choose it; the rest is the groundwork done properly.

| Capability | What you get |
|---|---|
| 🛡️ **Privacy Shield** | Raw tool results stay behind a data-plane boundary; the LLM sees only an identity-free digest. `guarded` by default, with `bypass`/`per_tool` opt-in and an org-wide clamp (`OMADIA_PRIVACY_FORCE_GUARDED`). Real data can run through omadia without running through the model. |
| ✅ **Answer verification** | A verifier checks each answer's claims against the run's own sources and records a verdict (`approved` / `approved_with_disclaimer`) before it reaches the channel. |
| 🧮 **Computed, not guessed** | Office and Excel output comes from a real spreadsheet engine, server-side, over real rows (`datasetId`). The figures are calculated by that engine rather than produced by the model. |
| 🧾 **A receipt for every action** | Every agent run carries a full per-run trace and call-stack viewer: every step, tool call, and decision, replayable. |
| 🤖 **Agent teams, not one chatbot** | An orchestrator routes each turn to the right specialist plugin agent. Channels, integrations, tools, and capability providers sit behind one stable API. |
| 🔒 **Self-hosted and yours** | One `docker compose up` on a single machine. Your Postgres, your LLM key, all of the data on your own infrastructure. GDPR-aware and made in the EU. |
| 🧩 **Signed plugin distribution** | Plugins ship as verifiable signed packages. The platform never pulls arbitrary npm at runtime. |
| 🔌 **Enterprise integrations** | Microsoft 365, Odoo, Confluence, Teams, and Telegram, with the LLM provider a swappable plugin. |

## What's in the box

- **Privacy Shield**: a data-plane boundary that interns raw tool results and
  exposes only an identity-free digest to the LLM
  ([`harness-plugin-privacy-guard`](middleware/packages/harness-plugin-privacy-guard),
  [`privacyMode.ts`](middleware/packages/plugin-api/src/privacyMode.ts))
- **Answer verifier**: claim-checks each answer against its sources and returns
  a verdict before it ships
  ([`harness-verifier`](middleware/packages/harness-verifier),
  [`verifierService.ts`](middleware/packages/harness-orchestrator/src/verifierService.ts))
- **Office compute**: `create_xlsx` / `create_docx` build real spreadsheets and
  documents server-side, resolving dataset rows without routing them through the
  model ([`harness-plugin-office`](middleware/packages/harness-plugin-office))
- **Plugin runtime**: channels, integrations, tools, sub-agents, and capability
  providers; everything is a plugin behind a stable API surface
  ([`@omadia/plugin-api`](middleware/packages/plugin-api))
- **Builder**: UI-driven plugin authoring with codegen, slot-typecheck,
  in-process ESLint auto-fix, and a runtime smoke harness
- **Knowledge graph**: pgvector-backed (Postgres) with an in-memory
  alternative for tests
- **Channels**: web-chat (admin UI) is in-tree; Teams and Telegram ship as
  separately-distributed plugin ZIPs
- **Auth**: multi-provider login (local password + OIDC), per-provider
  user table, admin UI for provider toggle and user management
- **Routines**: user-authored cron-triggered agent runs with a full per-run
  trace and call-stack viewer

## Design

The operator UI speaks Lume, omadia's own visual language. The idea is that
light is the material: surfaces read as condensed out of light, and the
agent's attention shows up as accent-tinted illumination, not as flat color.
Four recipes carry it. Surfaces are gradient pairs, borders catch the light on
their top edge, one accent slot glows to mark focus and selection, and corners
stay soft.

Three accent palettes ship, Petrol, Atelier, and Lagoon as the default. The
operator picks one and switches between light and dark from the header. The
whole theme lives in a single token file (`web-ui/app/_lib/theme.css`), so
restyling stays a change at the token tier rather than a sweep through
components.

Lume is specified in [byte5ai/omadia-ui](https://github.com/byte5ai/omadia-ui)
under `docs/visual-spec.md`, the same language omadia's canvas app is built on.
The operator UI and the canvas app share one identity.

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

Start with the [architecture overview](docs/architecture.md) for the component
map and request flow. The deeper walk-through of the plugin loading sequence,
capability registry, and multi-provider authentication layer lives under
[`docs/`](docs/).

## Trust & privacy architecture

Three subsystems let omadia put real data in front of an LLM and stand behind the
answer:

- **Privacy Shield (data-plane boundary)**: raw tool results are interned behind
  the boundary and the LLM sees only an identity-free digest. `guarded` is the
  default; `bypass` and `per_tool` are explicit opt-ins, and
  `OMADIA_PRIVACY_FORCE_GUARDED` clamps every plugin to `guarded` org-wide.
  Pseudonyms resolve back to real values only at materialization, and each bypass
  lands in the receipt. Spec: [`specs/001-privacy-shield-v4/`](specs/001-privacy-shield-v4/).
- **Answer verification**: before a turn's answer is returned, the verifier checks
  its claims against the run's sources and emits a verdict (`approved`,
  `approved_with_disclaimer`, or `blocked`). A borderline verdict attaches a
  disclaimer instead of silently shipping an unsupported claim.
- **Office compute (computed, not guessed)**: numbers in `.xlsx` / `.docx` output
  come from a real spreadsheet engine over real rows, rather than the model's
  token stream. When a specialist agent returns a `datasetId`, the rows are
  resolved server-side and never pass through the model.

### Optional features

The minimal core is postgres + middleware + admin UI. Diagrams, embeddings, and
object storage are off by default. Each is an overlay file you add with `-f`,
which starts the sidecar and switches on the matching plugin.

```bash
# Object storage (MinIO): chat attachment ingestion
docker compose -f docker-compose.yaml -f docker-compose.storage.yaml up -d

# Diagram rendering (Kroki). Needs object storage, so add both overlays:
docker compose -f docker-compose.yaml \
  -f docker-compose.storage.yaml -f docker-compose.diagrams.yaml up -d

# In-tenant embeddings (Ollama). First boot pulls nomic-embed-text (~270 MB),
# so it needs network access the first time it starts.
docker compose -f docker-compose.yaml -f docker-compose.embeddings.yaml up -d

# Everything at once
docker compose -f docker-compose.yaml \
  -f docker-compose.storage.yaml -f docker-compose.diagrams.yaml \
  -f docker-compose.embeddings.yaml up -d
```

> **Diagram rendering** also needs a signing secret. Generate one and add it to
> `middleware/.env` as `DIAGRAM_URL_SECRET` before starting the diagrams overlay:
> `openssl rand -hex 32`. The plugin stays inactive until it is set.

## Plugin development

**Start here: [`byte5ai/omadia-plugin-starter`](https://github.com/byte5ai/omadia-plugin-starter).**
A ready-to-fork template for your own omadia plugin. Clone it, fill in your logic
against [`@omadia/plugin-api`](middleware/packages/plugin-api), and ship.

omadia plugins are self-contained ZIP files that the operator uploads through
the admin UI. The platform never trusts external npm registries at runtime;
plugins ship `node_modules` baked in, or use the platform's standard library
via `@omadia/plugin-api`. Two reference plugins are also shipped in-tree as
starting points:

- [`agent-reference-maximum`](middleware/packages/agent-reference-maximum):
  exercises every capability in the plugin API
- [`agent-seo-analyst`](middleware/packages/agent-seo-analyst): a smaller,
  focused tool-only example

The Builder UI walks operators through cloning either reference, slot-filling
the differentiating logic, and verifying with the smoke runner before install.

## Deployment

- **Local / single-tenant**: `docker compose up`, see Quickstart above
- **Bring-your-own**: the runtime is a stock Node + Postgres app; any host
  that can run both works (Kubernetes, ECS, plain VM).

> **Required production secret.** The shipped image runs with
> `NODE_ENV=production`, which makes `VAULT_KEY` mandatory at boot; without
> it the middleware refuses to start (this is intentional; the dev fallback
> writes the master key into the data volume, which is not safe at rest).
> Generate one with `openssl rand -base64 32` and wire it as a platform
> secret before the first deploy. The bundled `docker-compose.yaml` pins
> `NODE_ENV=development` so the dev fallback stays available for local
> `docker compose up` without configuration; drop that override (and set
> `VAULT_KEY` in `.env`) when you re-use the compose file as a starting
> point for a non-local deploy.

## Status & Roadmap

> **Status: pre-1.0.** Public preview. APIs and database schemas may break
> between minor versions until `1.0.0`. Production use of the OSS distribution
> is supported but the upgrade path is hand-rolled today; an automated
> migration runner is on the v1.0 roadmap.

Stability promises are **scoped to the documented plugin API only**; everything
else (database schema, internal service surfaces, admin-UI routes) may evolve
without notice until `1.0.0`.

Active development tracks:

- **Conductor**: multi-step composition with a human sign-off path. Landing from
  branch `005-omadia-conductor`; it graduates to a first-class feature once that
  merges to `main`.
- **Plugin marketplace**: discovery and signed-package distribution (post-1.0)
- **Multi-tenant hosting**: out of scope for v1; a separate fork is planned
- **Web-IDE for plugin development**: moves the Builder authoring loop into the
  management UI without round-tripping through ZIP uploads (post-1.0)

## License

[MIT](LICENSE). Copyright (c) 2026 byte5 GmbH.

Third-party dependency licenses and notices are documented in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The dependency tree is
free of GPL, AGPL, and SSPL packages; weak-copyleft components (LGPL via
`sharp-libvips`, MPL-2.0 via `axe-core` / `lightningcss` / `dompurify`) are
used as documented unmodified dependencies.

## Troubleshooting

**Port already in use.** The core binds `3333` for the admin UI plus the
Postgres port. If another process holds one of them, the affected container
exits on start. Free the port, or remap it in your own compose override, then
re-run `docker compose up -d`.

**`VAULT_KEY` missing at boot.** A production image (`NODE_ENV=production`)
refuses to start without `VAULT_KEY`, on purpose. Generate one with `openssl
rand -base64 32` and set it in your project-root `.env` before deploying. The
bundled `docker-compose.yaml` pins `NODE_ENV=development`, so a local `docker
compose up` keeps the dev fallback. Full context lives in
[Deployment](#deployment).

**Optional overlay not found.** Optional features are overlay files added with
repeated `-f` flags, not Compose profiles. Pass the full filename, for example
`-f docker-compose.yaml -f docker-compose.storage.yaml`. A bare `--profile
storage` matches nothing here.

**Node version mismatch from source.** The middleware pins its Node major
version in `.nvmrc` and stops `npm install` on a different one, because
`better-sqlite3` and other native modules are compiled against a specific ABI.
Run `nvm use` in the repository root before installing.

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

omadia is maintained by [byte5 GmbH](https://byte5.de) under the GitHub
organisation [`byte5ai`](https://github.com/byte5ai). Outside contributions
are welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md).
