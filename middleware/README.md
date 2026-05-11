# Omadia Middleware

Express server that runs the Omadia kernel: Anthropic-Messages-API
orchestrator + plugin runtime + vault + builder + admin endpoints.

## Layout

```
src/                  Kernel code
  channels/           Channel runtime (registry, dynamic resolver)
  agents/             Agent resolution + tool routing
  plugins/            Plugin runtime (catalog, installer, dynamic
                      agent + tool runtimes, bootstrap, builder)
  platform/           Service registry, plugin context, job scheduler
  routes/             HTTP routes (chat, install, admin, dev)
  api/                Admin v1 API + auth scopes
  services/           Knowledge graph, skill loader, graph migrations
  auth/               Multi-provider login (local + OIDC)

packages/             In-tree plugin packages (@omadia/*)
sidecars/             Optional Docker sidecar images (e.g. presidio NER)
seed/memory/          Domain-agnostic rules seeded into memory at boot
test/                 Vitest test suites (unit + integration)
profiles/             Builder profile presets
```

## Setup

```bash
cd middleware
nvm use
npm install
cp .env.example .env       # set ANTHROPIC_API_KEY (+ optional vars)
npm run dev                # starts on PORT (default 8080)
```

The middleware re-builds and re-types every workspace package on `npm run
dev`; the first cold start takes ~30 seconds, subsequent restarts are
incremental.

## Quality gates

```bash
npm run lint            # eslint --fix on src/ + packages/*/src/
npm run typecheck       # tsc --noEmit across all workspaces
npm run test            # vitest (parallel; ~600 tests)
```

CI runs all three on every pull request — see [`.github/workflows/`](../.github/workflows/).

## Plugin packages

Every package under `packages/*` is an independent npm workspace with its
own `package.json`, `manifest.yaml`, and TypeScript build. They publish to
the in-tenant plugin catalog via the directory-scan in `BuiltInPackageStore`
and activate through the dynamic-agent / tool / channel runtimes.

The two reference agent packages — `agent-reference-maximum` and
`agent-seo-analyst` — are starting points for fork-style plugin
development. The Builder UI walks operators through cloning either
reference, slot-filling the differentiating logic, and verifying with the
smoke runner before install.

## See also

- [`packages/plugin-api`](packages/plugin-api) — public plugin contract
- [`packages/harness-channel-sdk`](packages/harness-channel-sdk) — channel-plugin contract
- [`packages/agent-reference-maximum`](packages/agent-reference-maximum) — capability-coverage example
