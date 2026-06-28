<div align="center">

<img src="docs/media/omadia-splash.png" alt="omadia" width="640">

# omadia

### Spin up a team of AI agents that does the work — on your own server, with a receipt for every action.

omadia is a self-hostable **agentic OS**: compose multi-agent teams from signed
plugins, run them on one machine, and get an auditable trail for everything they do.
Your LLM key. Your data. Your compliance story.

<img src="docs/media/omadia-demo.gif" alt="omadia no-code builder — describe an agent in plain words, the builder generates it, then try it out" width="860">

<sub>Describe an agent in plain words → the builder generates it → try it out. No code.</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Status: public preview](https://img.shields.io/badge/status-public%20preview-orange.svg)](#status--roadmap)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose-2496ED.svg?logo=docker&logoColor=white)](#-quickstart)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/byte5ai/omadia?style=social)](https://github.com/byte5ai/omadia/stargazers)

[**Website**](https://omadia.ai) · [**Quickstart**](#-quickstart) · [**Why omadia?**](#why-omadia) · [**Docs**](docs/) · [**Contributing**](CONTRIBUTING.md)

#### 🎬 The 2-minute pitch

<video src="https://github.com/byte5ai/omadia/raw/main/docs/media/omadia-pitch.mp4" poster="https://github.com/byte5ai/omadia/raw/main/docs/media/omadia-splash.png" controls muted width="720"></video>

<sub>Video not playing? <a href="docs/media/omadia-pitch.mp4">Watch <code>omadia-pitch.mp4</code> directly.</a></sub>

</div>

---

## Why you'll want to ⭐ this

- 🛡️ **Real data never reaches the LLM.** The **Privacy Shield** data-plane
  boundary interns every raw tool result and shows the model only an
  identity-free digest — `guarded` by default, with pseudonyms that resolve
  back only at materialization. The answer to *"I can't put real data through
  an LLM."*
- 🔒 **Self-hosted and yours.** Bring your own LLM key, run on a single machine
  with Docker Compose, and own 100% of the data. No SaaS lock-in,
  EU/GDPR-ready by design.
- 🤖 **Agent *teams*, not one chatbot.** An orchestrator routes each turn to the
  right specialized plugin agent — channels, integrations, tools, and capability
  providers all snap together behind one stable API.
- ✅ **Answers are verified before they go out.** A verifier checks each answer's
  claims against its sources and returns a verdict — catching the
  "confidently wrong" failure mode instead of shipping it.
- 🧾 **Every action leaves a receipt.** Full per-run trace and call-stack viewer
  for each agent run, so you can audit, debug, and prove what happened — built in,
  not bolted on.

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

The point of omadia clicks the moment you watch a team of agents do real work and
hand you a receipt for it:

1. **`docker compose up -d`** — the minimal core (postgres, middleware, and the admin UI) comes up together.
2. **Open `http://localhost:3333`** and finish the first-admin `/setup` wizard.
3. **Start a demo agent team** from a single prompt in the web chat.
4. **Watch it work** — the orchestrator streams turns and dispatches tools across
   the agents in the team.
5. **Open the run's trace** — the per-run **call-stack viewer** is your audit
   receipt: every step, every tool call, every decision, replayable.

## Why omadia?

omadia optimizes for what matters once an agent system leaves a laptop —
ownership, auditability, and dropping into a real enterprise stack, not just
"how many demos can it run." What you get, first-class:

- ✅ **Privacy Shield (data-plane boundary)** — raw tool results are interned behind the boundary; the LLM sees an identity-free digest. `guarded` by default, `bypass`/`per_tool` opt-in, org-wide clamp via `OMADIA_PRIVACY_FORCE_GUARDED`
- ✅ **Answer verification** — verdicts (`approved` / `approved_with_disclaimer`) before an answer reaches the user, against the run's own sources
- ✅ **Computed, not guessed** — headless Office/Excel compute runs real spreadsheet formulas server-side over real rows (`datasetId`) that never pass through the model
- ✅ **Self-hosting on a single machine** — `docker compose up`, no SaaS dependency
- ✅ **Own your data** — your Postgres, your LLM key; nothing leaves your box
- ✅ **Built-in audit trail / receipts** — per-run trace + call-stack viewer for every agent run
- ✅ **Signed plugin distribution** — verifiable plugin packages, not arbitrary npm at runtime
- ✅ **EU / GDPR-ready posture** — single-tenant and self-hosted, data-resident by design
- ✅ **Multi-agent coordination** — an orchestrator routes each turn across specialized agents
- ✅ **Enterprise integrations** — Microsoft 365, Odoo, Confluence, Teams, Telegram
- ✅ **Bring-your-own LLM key** — provider-pluggable

## What's in the box

- **Privacy Shield** — a data-plane boundary that interns raw tool results and
  exposes only an identity-free digest to the LLM
  ([`harness-plugin-privacy-guard`](middleware/packages/harness-plugin-privacy-guard),
  [`privacyMode.ts`](middleware/packages/plugin-api/src/privacyMode.ts))
- **Answer verifier** — claim-checks each answer against its sources and returns
  a verdict before it ships
  ([`harness-verifier`](middleware/packages/harness-verifier),
  [`verifierService.ts`](middleware/packages/harness-orchestrator/src/verifierService.ts))
- **Office compute** — `create_xlsx` / `create_docx` build real spreadsheets and
  documents server-side, resolving dataset rows without routing them through the
  model ([`harness-plugin-office`](middleware/packages/harness-plugin-office))
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

Three subsystems are what let omadia put *real* data in front of an LLM and
stand behind the answer:

- **Privacy Shield (data-plane boundary)** — raw tool results are interned
  behind the boundary and the LLM sees only an identity-free digest. The mode is
  `guarded` by default (safe-by-default); `bypass` and `per_tool` are explicit
  opt-ins, and `OMADIA_PRIVACY_FORCE_GUARDED` clamps every plugin to `guarded`
  org-wide. Pseudonyms resolve back to real values only at materialization, and
  each bypass lands in the receipt. Spec: [`specs/001-privacy-shield-v4/`](specs/001-privacy-shield-v4/).
- **Answer verification** — before a turn's answer is returned, the verifier
  checks its claims against the run's sources and emits a verdict
  (`approved`, `approved_with_disclaimer`, or `blocked`). The borderline verdict
  attaches a disclaimer rather than silently shipping an unsupported claim.
- **Office compute (computed, not guessed)** — numbers in `.xlsx` / `.docx`
  output are produced by a real spreadsheet engine over real rows, not generated
  token-by-token. When a specialist agent returns a `datasetId`, the rows are
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

**Start here → [`byte5ai/omadia-plugin-starter`](https://github.com/byte5ai/omadia-plugin-starter)** —
a ready-to-fork template for building your own omadia plugin. Clone it, fill in
your logic against [`@omadia/plugin-api`](middleware/packages/plugin-api), and ship.

omadia plugins are self-contained ZIP files that the operator uploads through
the admin UI. The platform never trusts external npm registries at runtime —
plugins ship `node_modules` baked in (or use the platform's standard library
via `@omadia/plugin-api`). Two reference plugins are also shipped in-tree as
starting points:

- [`agent-reference-maximum`](middleware/packages/agent-reference-maximum) —
  exercises every capability in the plugin API
- [`agent-seo-analyst`](middleware/packages/agent-seo-analyst) — a smaller,
  focused tool-only example

The Builder UI walks operators through cloning either reference, slot-filling
the differentiating logic, and verifying with the smoke runner before install.

## Deployment

- **Local / single-tenant** — `docker compose up`, see Quickstart above
- **Bring-your-own** — the runtime is a stock Node + Postgres app; any host
  capable of running both works (Kubernetes, ECS, plain VM).

> **Required production secret.** The shipped image runs with
> `NODE_ENV=production`, which makes `VAULT_KEY` mandatory at boot — without
> it the middleware refuses to start (this is intentional; the dev fallback
> writes the master key into the data volume, which is not safe at rest).
> Generate one with `openssl rand -base64 32` and wire it as a platform
> secret before the first deploy. The bundled `docker-compose.yaml` pins
> `NODE_ENV=development` so the dev fallback stays available for local
> `docker compose up` without configuration; drop that override (and set
> `VAULT_KEY` in `.env`) when you re-use the compose file as a starting
> point for a non-local deploy.

## Status & Roadmap

> **Status — pre-1.0.** Public preview. APIs and database schemas may break
> between minor versions until `1.0.0`. Production use of the OSS distribution
> is supported but the upgrade path is hand-rolled today; an automated
> migration runner is on the v1.0 roadmap.

Stability promises are **scoped to the documented plugin API only**; everything
else (database schema, internal service surfaces, admin-UI routes) may evolve
without notice until `1.0.0`.

Active development tracks:

- **Conductor** — multi-step composition with a human sign-off path; landing
  from branch `005-omadia-conductor` (this section graduates to a first-class
  feature once it merges to `main`)
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
are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
