<div align="center">

<img src="docs/media/omadia-wordmark.png" alt="omadia" width="820">

### An Agentic OS for professionals

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Status: public preview](https://img.shields.io/badge/status-public%20preview-orange.svg)](#status--roadmap)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose-2496ED.svg?logo=docker&logoColor=white)](#-quickstart)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/byte5ai/omadia?style=social)](https://github.com/byte5ai/omadia/stargazers)

[**Website**](https://omadia.ai) | [**Quickstart**](#-quickstart) | [**Why omadia?**](#why-omadia) | [**Docs**](#documentation) | [**Contributing**](CONTRIBUTING.md)

</div>

**omadia is a self-hostable, multiplayer agentic OS that makes AI dependable
enough for real work.** A team of agents runs on infrastructure you own and
works inside your team's shared channels, so several people work with the same
agents in one context. The agents turn your data, software, and people into
results you can steer, audit, and prove. Bring your own LLM key and switch
providers by config, not code.

<div align="center">

<img src="docs/media/omadia-demo.gif" alt="omadia no-code builder: describe an agent in plain words, the builder generates it, then try it out" width="820">

<sub>Describe an agent in plain words → the builder generates it → try it out. No code.</sub>

</div>

## Why omadia?

omadia is built for the moment an agent system leaves the laptop and meets real
work: real data, your own infrastructure, and answers you have to stand behind.

| Capability | What you get |
|---|---|
| 🛡️&nbsp;**Privacy&nbsp;Shield** | Raw results of data-source tools stay behind a boundary on your server, and the model works from an identity-free digest. On by default. |
| ✅&nbsp;**Answer&nbsp;verification** | Checks figures such as euro amounts, dates and invoice references against the run's own sources, and can hold back an answer with a refuted claim. Opt-in. |
| 🧮&nbsp;**Excel&nbsp;from&nbsp;real&nbsp;rows** | `create_xlsx` writes the real rows into the workbook server-side, so they never pass through the model. Sums and pivots stay live Excel formulas. |
| 🧾&nbsp;**Traces&nbsp;and&nbsp;receipts** | Follow a run step by step in the call-stack viewer. Turns the Privacy Shield guarded get a hash-chained receipt on Postgres. |
| 👥&nbsp;**Multiplayer&nbsp;by&nbsp;design** | Agents work in your team's shared channels (Slack, Teams, Telegram, Discord), so several people work with them in one context. |
| 🤖&nbsp;**Agent&nbsp;teams** | An orchestrator routes each turn to the right specialist agent. Channels, integrations, tools, and capability providers sit behind one stable API. |
| 🧭&nbsp;**Conductor&nbsp;workflows** | Chain agent, action and human steps into deterministic workflows, with durable approvals, crash-safe resume and a visual designer. |
| 🧩&nbsp;**No-code&nbsp;builder** | Describe an agent in plain words, and the Builder generates, typechecks and smoke-tests the plugin. Plugins install as hash-pinned ZIP files. |
| 🔒&nbsp;**Self-hosted&nbsp;and&nbsp;yours** | One `docker compose up` on a single machine. Your Postgres, your LLM key, your infrastructure. GDPR-aware and made in the EU. |
| 🔌&nbsp;**Enterprise&nbsp;integrations** | Microsoft 365, Odoo, Confluence, Teams, and Telegram, with the LLM provider a swappable plugin. |

Every control has a default and a scope. [Trust & privacy](docs/trust-and-privacy.md)
lists both, and a test keeps that page tied to the code.

## 🎬 The 2-minute pitch

https://github.com/user-attachments/assets/644f9dae-c8a9-44af-a47f-183d2fcdcf34

## ⚡ Quickstart

Three containers, one command. You need Docker 24+ with Compose v2.

```bash
git clone https://github.com/byte5ai/omadia.git && cd omadia
docker compose up -d                                  # postgres, middleware, admin UI
docker compose logs middleware | grep "setup token"   # one-time token for the first admin
```

Open `http://localhost:3333`, create the first admin with that token, and
connect your LLM under **Admin → LLM access**.

- **No Docker?** Your AI assistant can install the desktop app with
  [one prompt](docs/getting-started.md#no-docker-let-your-ai-assistant-install-it).
- **Next steps:** the first run, optional features, pinned releases and
  troubleshooting are in [Getting started](docs/getting-started.md).
- **Production:** [Deployment](docs/deployment.md) covers Render, Fly.io and your
  own host, plus the two secrets production needs.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/byte5ai/omadia)

## How it works

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
         │  agents  |  tools  |  capability providers  |  integrations│
         └────────────────────┬───────────────────────────────────────┘
                              │
        ┌─────────────────────┴────────────────────────────┐
        ▼                     ▼                            ▼
  Knowledge Graph       Embeddings                  Vault (secrets)
  (Postgres + pgvector) (Ollama / API)              (AES-256-GCM file)
```

Channels hand each turn to the orchestrator, which routes it to specialist
agents and dispatches their tools. Everything below it is a plugin behind
[`@omadia/plugin-api`](middleware/packages/plugin-api). The
[architecture overview](docs/architecture.md) walks through the component map
and request flow.

## Build your own agent

Fork [`omadia-plugin-starter`](https://github.com/byte5ai/omadia-plugin-starter),
fill in your logic, and upload the ZIP in the admin UI. Or describe the agent in
the Builder and let it write the code. The [plugin guide](docs/creating-plugins.md)
covers manifest, packaging and publishing, and
[`agent-seo-analyst`](middleware/packages/agent-seo-analyst) and
[`agent-reference-maximum`](middleware/packages/agent-reference-maximum) are the
in-tree references.

## Documentation

- [Getting started](docs/getting-started.md): install, first run, optional features, troubleshooting
- [Deployment](docs/deployment.md): Render, Fly.io, your own host, production secrets
- [Trust & privacy](docs/trust-and-privacy.md): what the Privacy Shield, the verifier and receipts cover
- [Architecture](docs/architecture.md): component map and request flow
- [Creating plugins](docs/creating-plugins.md): scaffold, manifest, ZIP, publish
- [Upgrading](docs/upgrading.md): migration steps per version
- [Security architecture](docs/security-architecture.md): the enforcing code paths
- [Design](docs/design.md): Lume, the operator UI's visual language

## Status & Roadmap

omadia is a **public preview**. Until `1.0.0`, APIs and database schemas may
change between minor versions, and stability is promised for the documented
plugin API. Production use is supported; upgrades follow the
[upgrade guide](docs/upgrading.md) until an automated migration runner lands
with v1.0.

Next on the roadmap:

- **Plugin marketplace** with discovery and publisher-signed packages (post-1.0)
- **Web IDE** that moves plugin authoring into the management UI (post-1.0)
- **Multi-tenant hosting** as a separate fork, out of scope for v1

## Contributing

Outside contributions are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers
the dev setup, commit convention and pull-request workflow, and the
[Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere.

## Security

Found a vulnerability? Please report it privately as described in
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## License

[MIT](LICENSE). Copyright (c) 2026 byte5 GmbH. omadia is maintained by
[byte5](https://byte5.de) under the [`byte5ai`](https://github.com/byte5ai)
organisation. The dependency tree is free of GPL, AGPL and SSPL packages; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
