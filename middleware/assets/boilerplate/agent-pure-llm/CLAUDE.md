# Agent Boilerplate — Claude Entwickler-Guide

Dieses Verzeichnis ist das **kanonische Template** für neue Harness-Platform-
Agenten. Der bereits gemergte Referenz-Agent ist `middleware/packages/agent-seo-analyst/`
— wenn du im Zweifel bist, wie etwas konkret aussieht, dort nachschauen. Das
Template hier und seo-analyst halten 1:1 die gleiche Struktur ein.

## Wann dieser Guide greift

Trigger-Phrasen:
- "Neuen Agent bauen für X" / "Agent skeleton für Y"
- "Boilerplate / Plugin-Package für Capability Z"
- "Scaffold + Manifest für neuen Integration-Agent"

Bei vagem "Plugin" kurz zurückfragen: **Agent** (Capability-Anbieter, hier),
**Channel** (User-Surface wie Teams/Slack → `middleware/src/channels/teams/`)
oder **Integration** (reine Credentials/HTTP-Client, kein Toolkit).

## Quellen der Wahrheit (NICHT halluzinieren)

- **Referenz-Impl**: `middleware/packages/agent-seo-analyst/` — 1:1 Vorlage.
- **Manifest-Schema**: `docs/harness-platform/manifest-schema.v1.yaml`
  — 3 kinds (`agent` | `integration` | `channel`), `depends_on`-Graph,
    `required_secrets` + `setup.fields`, permissions summary, `compat.core`-Guard.
- **Entity-Registry**: `docs/harness-platform/entity-registry.v1.yaml`.
- **Admin-API v1** (alle JWT-gated außer `/auth/*`):
  - `middleware/src/routes/store.ts`       — `GET /api/v1/store/plugins`
  - `middleware/src/routes/install.ts`     — job-basiert:
    `POST /api/v1/install/plugins/:id` → `POST /api/v1/install/jobs/:id/configure`
  - `middleware/src/routes/auth.ts`        — `/api/v1/auth/{login,callback,me,logout}`
  - `middleware/src/routes/vaultStatus.ts` — `GET /api/v1/admin/vault-status`
  - Typen: `docs/harness-platform/api/admin-api.v1.ts`.
- **Runtime-Contract**: `middleware/src/platform/pluginContext.ts` —
  Surface ist `agentId`, `secrets.{get,require,keys}` (async), `config.{get,require}<T>`
  (sync), `log(...)`. `vault`/`registry`/`catalog` sind Factory-intern und bleiben
  das — strukturelle Boundary, kein "coming".
- **Vault**: `middleware/src/secrets/vault.ts` — AES-256-GCM,
  `/data/vault/vault.enc.json`, agentId-namespaced, `VAULT_KEY` als Fly-Secret,
  nightly Tigris-Backup. Platform-Scope `core:auth` hält Session-Signing-Key +
  per-user Refresh-Tokens.
- **Admin-UI**: `odoo-bot-harness.fly.dev` — Store + Install-Drawer rendern
  automatisch aus `setup.fields`.

Feld nicht im Schema → **nicht rein**. Lieber kurz fragen.

---

## Die 10 Checkliste-Punkte (Package-Contract)

Jeder Punkt ist harter Contract gegen die Host-Runtime. Abweichung = Install/
Ingest schlägt fehl oder der Agent ist zur Laufzeit kaputt.

### 1. `PluginContext` lokal in `types.ts`
KEIN Cross-Import von `middleware/src/platform/pluginContext.ts`. Das Package
muss standalone kompilieren (Zip-Upload-Flow). Die Interface-Definition wird
bewusst in `./types.ts` dupliziert — strukturell identisch zur Host-Version.
Bei Breaking Changes: in allen Packages mitziehen, Absicht nicht Bug.

### 2. PluginContext-API exakt
```ts
ctx.agentId                                     // readonly string
await ctx.secrets.get(key)    / .require(key)   / .keys()    // async
ctx.config.get<T>(key)        / .require<T>(key)             // sync
ctx.log(...args)                                             // auto-prefix [agentId]
```
`ctx.config('KEY')` oder `ctx.secret('KEY')` als Funktionsaufrufe sind FALSCH —
das Template-Original hatte den Fehler, seo-analyst ist korrekt.

Beide Accessors resolven entlang der `depends_on`-Chain (DFS, first-hit-wins,
cycle-safe). `de.byte5.agent.odoo-hr` greift mit `ctx.secrets.require('odoo_api_key')`
direkt auf den Parent `de.byte5.integration.odoo` durch — ohne Parent-ID zu
kennen. Folge: eigene `setup.fields` **nur** deklarieren wenn Parent sie nicht hat
(sonst silent override).

### 3. `package.json` am Package-Root
- `name` === `manifest.identity.id`
- `version` === `manifest.identity.version`
- `"type": "module"`
- `"main": "dist/index.js"`
- Deps via `peerDependencies` (nicht `dependencies`) — Supply-Chain-Schutz,
  Ingest warnt via `peers_missing`.
- `"private": true` (nie an npm publishen).

### 4. `tsconfig.json` am Package-Root
- `module` + `moduleResolution`: `"NodeNext"`
- `rootDir`: `"./"`, `outDir`: `"./dist"`
- `strict: true` + `noUnused{Locals,Parameters}`
- `include` listet nur Package-interne Files; `exclude` listet `node_modules`,
  `dist`, `skills`, `assets`, `scripts`, `out`.
- Keine Includes außerhalb des Package-Baums.

### 5. Zip-Inhalt = NUR Runtime-Artefakte
**Drin**: `manifest.yaml`, `package.json`, `dist/` (JS + `.d.ts`), `skills/` (MD),
`assets/` (optional), `README.md`, `LICENSE` (optional).
**Nicht drin**: TS-Quellen (`*.ts` außerhalb `dist/`), `node_modules/`, `.env`,
`out/`, `.git`.

Extension-Allowlist im Host-Extractor:
`.yaml .md .json .js .mjs .cjs .map .png .svg .jpg .txt` + `LICENSE / README / NOTICE`.

### 6. `activate(ctx)` return shape ist fix
```ts
{ toolkit: { tools: ToolDescriptor[]; close(): Promise<void> }, close(): Promise<void> }
```
`ToolDescriptor = { id, description, input: ZodSchema, run(input) }`.

Runtime übernimmt: LocalSubAgent-Wrap, Tool-Bridge, DomainTool-Wrap,
Tool-Name-Derivation, systemPrompt-Concat. Agent baut **keinen** eigenen
LLM-Client, keine eigene Anthropic-SDK-Instanz, keine eigene Tool-Loop.

### 7. System-Prompt via `skills/*.md`
Markdown mit YAML-Frontmatter:
```md
---
id: {{AGENT_SLUG}}_expert_system
kind: prompt_partial
---
# Rolle: {{AGENT_NAME}}
…
```
Im Manifest über `skills[]` referenziert (`{ id, kind: "prompt_partial", path, … }`).
Runtime lädt alle Partials, stripped das Frontmatter, concatenated und setzt
automatisch einen Header aus `plugin.name` + `plugin.description` +
`playbook.when_to_use` davor. Der Agent gibt **keinen** eigenen systemPrompt
als String zurück.

### 8. Zod-Support-Matrix
Tool-Bridge versteht:
- **OK**: Object, String (+ `.url`/`.email`/`.uuid`/`.min`/`.max`/`.regex`),
  Number (+ `.int`/`.min`/`.max`), Boolean, Enum, Array, Optional, Nullable,
  Default, Literal, Effects.
- **FALLBACK** → `{}`: Union, DiscriminatedUnion, Intersection, Record, Tuple.
  → Claude bekommt kein strukturiertes Input-Schema → deutlich schwächere
    Tool-Use-UX. Bei den unterstützten Typen bleiben.

### 9. Lifecycle-Budgets
- `activate(ctx)`: **10s**. Self-Test = ein GET, kein Vollcrawl, kein Bulk-Sync.
- `close()`: **5s**. Timer, Sockets, Watches, Intervals **wirklich** freigeben —
  wird beim Uninstall aufgerufen; hängende Handles blockieren Hot-Uninstall.

### 10. Build-Script `scripts/build-zip.mjs`
Im Template mitgeliefert. Pipeline:
1. `npx tsc --project ./tsconfig.json` → `dist/`
2. Copy `manifest.yaml` + `package.json` + `README.md` + `dist/` + `skills/` +
   `assets/` nach `out/<id>-<version>-package/`
3. Verifiziert `dist/<entry>` existiert (sonst Abbruch)
4. Zippt → `out/<id>-<version>.zip`

User-seitig: `node scripts/build-zip.mjs` → `out/<id>-<version>.zip` ist das
uploadbare Artefakt.

---

## Bonus-Fakten

- **Tool-Name-Derivation** (Runtime): `de.byte5.agent.<slug>` wird zu
  `query_<slug_mit_underscores>`. Im Manifest nichts extra setzen, im
  Playbook-Text aber als Referenz erwähnen ("nutze `query_odoo_hr` …").
- **DomainTool-Description** wird automatisch aus `plugin.description` +
  `playbook.when_to_use` + `playbook.not_for` zusammengesetzt. Die gesamte
  "wann-nutze-mich"-Semantik gehört ins Manifest, NICHT in den Tool-Code.
- **`ctx.log(...)`** wird automatisch mit `[<agentId>]` geprefixt. Kein
  manuelles Prefixing.
- **Hot-Install/Uninstall**: nach erfolgreichem `configure` feuert der
  `onInstalled`-Hook → Runtime aktiviert sofort ohne Middleware-Restart.
  `DELETE /install/installed/:id` → `onUninstall` → `handle.close()` + Unregister
  im Orchestrator, live. Darauf verlassen, nicht umgehen.

---

## Scaffolding-Rezept

User sagt: "Bau mir einen Agent `de.byte5.agent.sharepoint` für Dokument-Suche."

1. **Kopieren**
   ```bash
   cp -R docs/harness-platform/boilerplate/agent \
         middleware/packages/agent-sharepoint
   mv middleware/packages/agent-sharepoint/skills/{{AGENT_SLUG}}-expert.md \
      middleware/packages/agent-sharepoint/skills/sharepoint-expert.md
   ```

2. **Platzhalter ersetzen** — über Edit-Tool, IDs doppelt prüfen (Typos in
   `depends_on` scheitern erst zur Install-Zeit):

   | Platzhalter | Beispiel |
   |---|---|
   | `{{AGENT_ID}}` | `de.byte5.agent.sharepoint` |
   | `{{AGENT_NAME}}` | `Microsoft SharePoint Agent` |
   | `{{AGENT_SLUG}}` | `sharepoint` |
   | `{{AGENT_DESCRIPTION_DE}}` | "Durchsucht SharePoint-Sites …" |
   | `{{INTEGRATION_ID}}` | `de.byte5.integration.microsoft365` |
   | `{{CAPABILITY_ID}}` | `search_documents` |
   | `{{ROLE_DESCRIPTION_DE}}` | "ein pragmatischer SharePoint-Recherche-Assistent" |

3. **Capabilities verdichten** — `client.ts` (reiner HTTP-Client) + `toolkit.ts`
   (Capability→Zod→Handler). Pro Capability: `side_effects`, `idempotent`,
   `autonomous`, `timeout_ms` realistisch.

4. **System-Prompt** in `skills/<slug>-expert.md` schreiben — nicht im Code.

5. **Build + Install**
   ```bash
   cd middleware/packages/agent-sharepoint
   npm install          # oder bun install
   node scripts/build-zip.mjs
   # → out/de.byte5.agent.sharepoint-0.1.0.zip

   # Upload via Admin-UI (odoo-bot-harness.fly.dev → Store → Upload)
   # oder via Admin-API POST /api/v1/install/plugins/:id (job-basiert).
   ```

6. **Lint + Typecheck** im Middleware-Root, nicht bauen:
   ```bash
   npm run lint:fix && npm run typecheck
   ```

---

## Stolperfallen

1. **Hardcoded paths / URLs**: alles über `ctx.config` — keine Magic Strings.
2. **Fly-Secrets**: write-only. Lokal `echo "$VAL" > /tmp/x`, `fly secrets set
   KEY=$(cat /tmp/x)`, Datei löschen. Nie im Chat leaken.
3. **i18nexus**: UI-Strings (Manifest `ui.commands[].label`) nicht direkt in
   JSON — werden überschrieben.
4. **`[0]` nicht verwenden** → Lodash `_.first()` / `_.head()`.
5. **`npm run lint:fix` + `typecheck`** nach jeder Änderung — nicht `npm run build`.
6. **Kein `any`** — `unknown` + Zod-Parse bei externen Payloads.
7. **Keine Tests/Docs/PR-Marker** generieren die nicht explizit gefragt sind.
8. **Keine Feature-Flags / Backwards-Compat-Shims** auf Vorrat.

---

## Antwort-Format beim Scaffolden

Knapp. Tabelle mit erstellten Files + Pfaden. Nächster Schritt (Secrets setzen,
Upload, Configure-Call) als 1-Zeiler. Architektur-Gabeln (z.B. "Memory-Scope
pro User oder pro Session?") vorher explizit abfragen, nicht einseitig
entscheiden.
