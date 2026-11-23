# Capability-Plugin-Boilerplate (kind `tool`)

Template des Plugin Builders für Capability-Plugins mit lokaler Logik: kein
externes System, keine Zugangsdaten. Claude-Guide: [CLAUDE.md](./CLAUDE.md);
der vollständige Package-Contract steht in `../integration/CLAUDE.md`.

Ein Capability-Plugin liefert Tools, die der Operator einzelnen Agenten
gewährt. Es hat keine Persona und keinen System-Prompt.

## Layout

```
manifest.yaml      # kind: tool
package.json
tsconfig.json
types.ts           # lokales PluginContext-Duplikat
toolkit.ts         # Tools mit Zod-Input + run()
registerTools.ts   # jedes Tool → ctx.tools.register
plugin.ts          # activate(ctx) → { close() }
index.ts
assets/admin-ui/   # optional
scripts/build-zip.mjs
```

## Build

```bash
npm install
node scripts/build-zip.mjs
# → out/<id>-<version>.zip, hochladbar über Store → Upload
```
