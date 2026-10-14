# Agent Boilerplate

Standalone-Package-Template für neue Omadia-Agenten (`kind: agent`).
Claude-Guide: [CLAUDE.md](./CLAUDE.md) — wird beim Scaffolden automatisch
mitgelesen.

Referenz-Implementierung: keine — für den Pure-LLM-Fall IST diese
Boilerplate die Referenz. `middleware/packages/agent-seo-analyst/` ist der
kanonische Vergleich für das Tool-basierte Pattern (`agent-integration`).

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
├── index.ts                      # Barrel
├── skills/
│   └── {{AGENT_SLUG}}-expert.md  # System-Prompt-Partial (YAML-Frontmatter)
├── assets/                       # icon.png etc. (optional)
└── scripts/
    └── build-zip.mjs             # tsc + stage + zip → out/<id>-<ver>.zip
```

## Quick Start

```bash
cp -R middleware/assets/boilerplate/agent-pure-llm \
      middleware/packages/agent-<slug>

cd middleware/packages/agent-<slug>

# Platzhalter ersetzen ({{AGENT_ID}}, {{AGENT_NAME}}, {{AGENT_SLUG}},
# {{AGENT_DESCRIPTION_DE}}, {{AGENT_DESCRIPTION_EN}}, {{ROLE_DESCRIPTION_DE}}, …
# vollständige Liste: `placeholders:` in template.yaml)

npm install
node scripts/build-zip.mjs
# → out/<AGENT_ID>-<version>.zip   ← uploadbar via Admin-UI
```

Upload: `<your-omadia-host>` → Store → Upload, oder Admin-API
`POST /api/v1/install/plugins/:id` → `POST /api/v1/install/jobs/:id/configure`.

## Was die Runtime macht (und der Agent NICHT)

- LocalSubAgent-Wrap, Tool-Bridge, DomainTool-Wrap, Tool-Name-Derivation
  (`de.byte5.agent.<slug>` → `query_<slug>`), systemPrompt-Concat aus
  `skills/*.md`, Hot-Install/Uninstall, Secret-Chain-Resolution, Logging-Prefix.

Der Agent liefert nur: Manifest, den System-Prompt in `skills/` und ein
`activate`, das ein leeres Toolkit (`tools: []`) zurückgibt. Kein Client,
keine Secrets, keine externe API: die Runtime baut ohne Tools keine
Tool-Loop. Braucht der Agent eine Datenquelle, ist `agent-integration` das
richtige Template.

## Referenzen

- Schema: Parser `adaptManifestV1` in `middleware/src/plugins/manifestLoader.ts`
  (Typen: `middleware/src/api/admin-v1.ts`), Leitfaden `docs/creating-plugins.md`
- Entities: `middleware/assets/entity-registry.v1.yaml`
- Canonical (mit Toolkit): `middleware/packages/agent-seo-analyst/`
- Runtime-Contract: `middleware/src/platform/pluginContext.ts`
