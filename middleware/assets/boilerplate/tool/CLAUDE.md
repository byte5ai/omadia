# Capability-Plugin-Boilerplate (kind `tool`) — Claude Entwickler-Guide

Dieses Verzeichnis ist das **kanonische Template** für Capability-Plugins vom
kind `tool`: lokale Logik, **kein externes System, keine Zugangsdaten**
(Beispiele: Textstatistik, Einheiten umrechnen, Formate prüfen, Scores über
Daten berechnen, die der aufrufende Agent mitgibt). Kompakte Referenz:
`middleware/packages/agent-seo-analyst/`.

Der vollständige Package-Contract (10 Punkte, PluginContext, Zod-Matrix,
Lifecycle-Budgets, Admin-UI, UI-Routes, Service-Registry) steht im
Schwester-Template **`../integration/CLAUDE.md`** und gilt hier 1:1. Dieses
Dokument nennt nur die Unterschiede.

## Was ein Capability-Plugin ist — und was nicht

Ein Capability-Plugin liefert **Tools**, die der Operator einzelnen Agenten
gewährt (Spec 2042 §5.10, ADR-0014). Es hat **keine Persona, keinen
System-Prompt, keine eigene Model-Loop** und spricht nie mit Menschen. Rolle,
Charakter und Tonfall gehören einem Agenten (Agent Builder, `/admin/builder`).
Kein `AGENT.md`, keine `prompt_partial`-Skills, keine Manifest-Keys
`persona`/`speaker`/`personality`/`system_prompt` — der Ingest lehnt sie ab.

## Unterschiede zu `integration`

- **Kein `client.ts`**: die Tools rechnen lokal in `toolkit.ts`
  (`createToolkit({ log })`). Kein `ctx.secrets.require(...)`, kein
  `depends_on`, `setup.self_test: false`.
- **Manifest** `identity.kind: "tool"` (Codegen schreibt den Kind aus der
  Spec).
- Braucht ein Tool eine authentifizierte externe API, wechsle auf das
  `integration`-Template — einen Client nachträglich hineinzubauen verliert
  dessen Garantien.

## Layout

```
manifest.yaml      # kind: tool, playbook, capabilities
package.json       # name = identity.id, peerDependencies (zod, express, …)
tsconfig.json
types.ts           # lokales PluginContext-Duplikat (inkl. ctx.tools)
toolkit.ts         # Tools: { id, description, input: Zod, run }
registerTools.ts   # fester Code: jedes Tool → ctx.tools.register
plugin.ts          # activate(ctx) → registerToolkit → { close }
index.ts
assets/admin-ui/   # optionale Operator-Admin-UI
scripts/build-zip.mjs
```

## Runtime-Contract

```ts
const toolkit = createToolkit({ log: ctx.log });
const disposeTools = registerToolkit(ctx, toolkit);
return { async close() { disposeTools(); await toolkit.close(); } };
```

`registerTools.ts` registriert jedes Tool unter seiner `id`, leitet das
Input-Schema mit `z.toJSONSchema` aus dem Zod-Schema ab, parst die Eingabe
damit und gibt das Ergebnis als Text zurück (Strings 1:1, sonst JSON). Was
ein Agent über das Plugin weiß, steht in den Tool-Beschreibungen und im
`playbook:` (wann nutzen, wofür nicht).
