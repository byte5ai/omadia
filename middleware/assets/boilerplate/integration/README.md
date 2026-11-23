# Capability-Plugin-Boilerplate (kind `integration`)

Template des Plugin Builders für Capability-Plugins, die ein externes System
mit Zugangsdaten anbinden. Claude-Guide: [CLAUDE.md](./CLAUDE.md) (der
10-Punkte-Package-Contract). Schwester-Template ohne externes System:
`../tool/`.

Ein Capability-Plugin liefert Tools, die der Operator einzelnen Agenten
gewährt. Es hat keine Persona und keinen System-Prompt.

Referenz-Implementierungen: `middleware/packages/agent-reference-maximum/`
(alle Patterns) und `middleware/packages/agent-seo-analyst/` (kompakt).

## Layout (flach, am Package-Root)

```
manifest.yaml      # kind: integration, setup.fields, playbook, capabilities
package.json       # name = identity.id, peerDependencies, type:module
tsconfig.json      # NodeNext, rootDir:./, outDir:./dist
types.ts           # lokales PluginContext-Duplikat (Pflicht!)
client.ts          # externe API (LLM-frei, testbar)
toolkit.ts         # Capability → ToolDescriptor (Zod-Input + run)
registerTools.ts   # jedes Tool → ctx.tools.register
plugin.ts          # activate(ctx) → registerToolkit → { close() }
index.ts           # Barrel
assets/admin-ui/   # optionale Operator-Admin-UI
scripts/build-zip.mjs
```

## Build

```bash
npm install
node scripts/build-zip.mjs
# → out/<id>-<version>.zip   ← hochladbar über Store → Upload
```

## Was der Kernel macht (und das Plugin nicht)

Tool-Registry und -Dispatch (`ctx.tools.register`), Grants pro Agent,
Hot-Install/Uninstall, Secret-Chain-Resolution, Logging-Prefix. Das Plugin
liefert Manifest, Client und Toolkit und bindet sich bei `activate` an die
Ziel-API.

Runtime-Contract: `middleware/src/platform/pluginContext.ts`.
