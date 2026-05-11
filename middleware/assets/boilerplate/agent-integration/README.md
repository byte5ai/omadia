# Agent Boilerplate

Standalone-Package-Template für neue Harness-Platform-Agenten (`kind: agent`).
Claude-Guide: [CLAUDE.md](./CLAUDE.md) — wird beim Scaffolden automatisch
mitgelesen.

Referenz-Implementierung: `middleware/src/agents/seo-analyst/` (kanonisch,
alle 10 Checkliste-Punkte 1:1 umgesetzt).

## Layout (flach, am Package-Root)

```
agent/
├── CLAUDE.md                     # Entwickler-Guide (10-Punkte-Contract)
├── README.md
├── manifest.yaml                 # Declarative Agent-Definition (Schema v1)
├── package.json                  # name=AGENT_ID, peerDependencies, type:module
├── tsconfig.json                 # NodeNext, rootDir:./, outDir:./dist
├── types.ts                      # lokales PluginContext-Duplikat (Pflicht!)
├── plugin.ts                     # activate(ctx) → { toolkit, close() }
├── client.ts                     # externe API (LLM-frei, testbar)
├── toolkit.ts                    # Capability → ToolDescriptor[] (Zod)
├── index.ts                      # Barrel
├── skills/
│   └── {{AGENT_SLUG}}-expert.md  # System-Prompt-Partial (YAML-Frontmatter)
├── assets/                       # icon.png etc. (optional)
└── scripts/
    └── build-zip.mjs             # tsc + stage + zip → out/<id>-<ver>.zip
```

## Quick Start

```bash
cp -R docs/harness-platform/boilerplate/agent \
      middleware/src/agents/<slug>

cd middleware/src/agents/<slug>

# Platzhalter ersetzen ({{AGENT_ID}}, {{AGENT_NAME}}, {{AGENT_SLUG}},
# {{INTEGRATION_ID}}, {{CAPABILITY_ID}}, {{AGENT_DESCRIPTION_DE}}, …)

npm install
node scripts/build-zip.mjs
# → out/<AGENT_ID>-<version>.zip   ← uploadbar via Admin-UI
```

Upload: `odoo-bot-harness.fly.dev` → Store → Upload, oder Admin-API
`POST /api/v1/install/plugins/:id` → `POST /api/v1/install/jobs/:id/configure`.

## Was die Runtime macht (und der Agent NICHT)

- LocalSubAgent-Wrap, Tool-Bridge, DomainTool-Wrap, Tool-Name-Derivation
  (`de.byte5.agent.<slug>` → `query_<slug>`), systemPrompt-Concat aus
  `skills/*.md`, Hot-Install/Uninstall, Secret-Chain-Resolution, Logging-Prefix.

Der Agent liefert nur: Manifest, Toolkit (Zod-Input + `run`), optional
Skills, und bindet sich bei `activate` an Ziel-API/Services.

## Referenzen

- Schema: `docs/harness-platform/manifest-schema.v1.yaml`
- Entities: `docs/harness-platform/entity-registry.v1.yaml`
- Beispiele: `docs/harness-platform/examples/agent-*.manifest.yaml`
- Canonical: `middleware/src/agents/seo-analyst/`
- Runtime-Contract: `middleware/src/platform/pluginContext.ts`
