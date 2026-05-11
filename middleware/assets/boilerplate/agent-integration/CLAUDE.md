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

## Optional: Operator-Admin-UI (Web-Frontend im Plugin)

Wenn der Agent eine Web-UI braucht (z.B. um manuell Daten zu pflegen die
nicht aus der API kommen — MAC↔Person-Zuordnungen, Custom-Tags, etc.),
schippe sie als Teil des Packages via drei zusammenwirkenden Bausteinen.
Optional und nur sinnvoll für Agents, die operator-pflegte Daten brauchen
— 80% kommen ohne aus.

### Baustein 1: Slot `admin-ui-body` in `assets/admin-ui/index.html`

> **PFLICHT-LESEN beim Bearbeiten dieses Slots:**
> [`assets/admin-ui/CLAUDE.md`](assets/admin-ui/CLAUDE.md) — Container-Maße
> (812/720/327 px × 1000 px fix), Token-Inventar (`var(--accent)` etc.),
> Helper-Klassen (`.harness-btn` etc.), Tabellen-/Form-Patterns für narrow
> Viewports, verbotene Patterns (`position: fixed`, hardcoded Hex,
> externe Webfonts, …). Das ist die Source-of-Truth fürs Admin-UI-Styling
> — analog zum INTEGRATION.md-Pattern für Cross-Plugin-Reads.

Das Boilerplate ships eine fertige `assets/admin-ui/index.html` die das
Harness-Baseline-Stylesheet (`/bot-api/_harness/admin-ui.css`, byte5-
Tokens + Light/Dark + Tabellen/Forms styled, `.harness-*` Helper-Klassen)
per `<link>` einbindet, plus eine Marker-Region für den Body-Inhalt:

```html
<!-- #region builder:admin-ui-body -->
<!-- HTML-Inhalt, inline <style> + <script> erlaubt -->
<!-- #endregion -->
```

`{{AGENT_NAME}}`, `{{AGENT_DESCRIPTION_DE}}`, `{{AGENT_SLUG}}` werden im
HTML automatisch substituiert. **Single-file ist die unterstützte Form**
— keine separaten `app.js`/`styles.css`.

Wenn der Slot nicht gefüllt wird, zeigt die Default-Page einen Hinweis-
Text — die Plugin-Routes funktionieren trotzdem.

> **KRITISCH — fetch-URLs: immer relativ, niemals absolut.** Die Admin-
> UI läuft im iframe der Workspace-UI, deren Browser-URL ist
> `/bot-api{admin_ui_path}` (z.B. `/bot-api/<slug>/admin/index.html`).
> Web-dev rewritet `/bot-api/*` → middleware. `fetch()`-Calls aus dem
> Slot müssen daher relativ formuliert werden, damit sie durch den
> Rewrite gehen:
>
> - ✅ `fetch('api/devices')` — relativ, resolved zu
>   `/bot-api/<slug>/admin/api/devices` → middleware sieht
>   `/api/<slug>/admin/api/devices` ✓
> - ❌ `fetch('/api/<slug>/admin/api/devices')` — absolut, geht direkt
>   auf die web-ui-Origin (NICHT durch den Rewrite) → 404
>
> Pattern für Builder-generierte UI:
> ```js
> const BASE = 'api'; // relativ! Plugin-Slug + /admin sind iframe-implizit
> const devices = await fetch(`${BASE}/devices`).then(r => r.json());
> ```

### Baustein 2: `ctx.routes.register()` im `activate-body`-Slot

Im `activate(ctx)` einen Express-Router mit `express.static` mounten + die
Optionalen API-Routes (für Reads/Writes vom Frontend) im selben Prefix
registrieren:

```typescript
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// im activate-body Slot:
const here = path.dirname(fileURLToPath(import.meta.url));
const uiAssetsPath = path.resolve(here, '../assets/admin-ui');

const router = express.Router();

// Static UI files. `redirect: false` ist KRITISCH — sonst killen
// Trailing-Slash + Next-rewrite + express.static-Default die iframe-Ladung
// in einer 3-fach-Redirect-Kette.
router.use(express.static(uiAssetsPath, { redirect: false }));

// JSON-API für Reads/Writes vom Frontend. Pfad-Konvention:
// `/api/<slug>/admin/api/<resource>` damit's vom UI-Pfad disjunkt ist.
//
// VERBINDLICHES RESPONSE-SCHEMA — Frontend und Backend müssen sich
// daran halten, sonst zerlegt sich der Roundtrip silent (siehe
// "KRITISCH"-Box unten):
//   Success:  res.json({ ok: true, ...payload })
//   Failure:  res.status(<4xx|5xx>).json({ ok: false, error: '<msg>' })
router.get('/api/macs', async (_req, res) => {
  try {
    const items = await loadMacsFromKnowledgeGraph();
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});
router.post('/api/macs', express.json(), async (req, res) => {
  try {
    await persistMacAssignment(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

ctx.routes.register('/api/<slug>/admin', router);
ctx.log('admin UI mounted at /api/<slug>/admin/ui/');
```

`ctx.routes.register(prefix, router)` ist Teil der PluginContext-Surface
(siehe `pluginContext.ts:74`). Auto-unmount bei `close()`, hot-uninstall-safe.

> **KRITISCH — Response-Schema: Frontend prüft IMMER `data.ok`.** Backend
> und Frontend müssen denselben Vertrag fahren — der Builder hatte in
> einem Turn (UniFi-Tracker v0.4.0) `res.json({ devices: [...] })` ohne
> `ok` geschrieben, das Frontend tat `if (!data.ok) throw 'devices-Fehler'`,
> und beide Slots dachten der jeweils andere sei kaputt.
>
> Pflicht-Pattern in jedem Endpoint:
> ```js
> // Backend (Endpoint-Body):
> res.json({ ok: true, items });               // Success
> res.status(500).json({ ok: false, error });  // Failure
>
> // Frontend (im Slot admin-ui-body):
> const data = await fetch('api/macs').then(r => r.json());
> if (!data.ok) throw new Error(data.error || 'Unbekannter Fehler');
> renderTable(data.items);
> ```
> Niemals nackte `res.json({ items: ... })` ohne `ok: true` — und niemals
> `if (data.items)` ohne vorigen `data.ok`-Check.

### Daten aus anderen Plugins ziehen (Service-Registry)

Der `client.ts`-Slot ist für die EIGENE Integration des Plugins (z.B.
UniFi-Cloud-API). **Daten aus anderen Plugins** (Odoo-HR, Confluence,
Microsoft 365, etc.) NICHT über `client` laufen lassen — der weiß nichts
davon. Stattdessen über die Service-Registry konsumieren.

> **BEVORZUGT — Theme A: deklarative `spec.external_reads`-Einträge.** Für
> einfache Reads (Liste-X-aus-Service-Y, Ein-Lookup-pro-Tool) den Eintrag
> in `spec.external_reads` über `patch_spec` setzen — codegen synthesiert
> dann sowohl den `ctx.services.get(...)`-Lookup als auch das Tool-Stub
> automatisch. Du tippst KEINEN Service-Lookup-Code mehr. Schema:
>
> ```yaml
> external_reads:
>   - id: list_employees
>     description: "Mitarbeiterliste aus Odoo HR"
>     service: odoo.client          # aus serviceTypeRegistry.ts
>     model: hr.employee             # Odoo-spezifisch (optional)
>     method: execute                # 1:1 aus INTEGRATION.md
>     args:
>       - { model: "hr.employee", method: "search_read", positionalArgs: [], kwargs: {} }
>     kwargs: {}
>     result_mapping: {}             # optional: Output-Reshape
> ```
>
> Codegen schreibt `import type { OdooClient } from '@byte5/...'`,
> `peerDependencies` in der package.json, den Service-Lookup-Block UND
> einen Tool-Descriptor mit `id: 'list_employees'`. Service-NAME-Tippfehler
> fängt der manifestLinter (violation `external_read_unknown_service`),
> Method-Existenz fängt der tsc-Gate.
>
> **Wenn external_reads NICHT passt** (z.B. dynamische args aus LLM-Input,
> Aggregation/Filter-Logik post-call, Multi-Service-Joins): auf den
> klassischen Weg unten ausweichen.

> **PFLICHT-WORKFLOW (klassisch) vor jedem Cross-Integration-Code:**
>
> 1. **`patch_spec`**: ergänze `spec.depends_on` um die jeweilige
>    Integration-Plugin-ID (z.B. `de.byte5.integration.odoo`).
> 2. **`read_reference`**: lies das `INTEGRATION.md` des dependency-Plugins —
>    `read_reference({ name: 'integration-<name>', file: 'INTEGRATION.md' })`.
>    Bekannte Catalog-Namen: `integration-odoo`, `integration-confluence`,
>    `integration-microsoft365`. Das `INTEGRATION.md` ist die **alleinige
>    Source of Truth** für Service-Names, TypeScript-Type-Imports,
>    Method-Signaturen und Code-Snippets.
> 3. **`fill_slot` `activate-body`**: Code schreiben — Method-Signaturen
>    1:1 aus `INTEGRATION.md` übernehmen. **NICHT** aus deinem Trainings-
>    Wissen rekonstruieren — Drift garantiert (heute live beobachtet:
>    `odoo.execute_kw(...)` existiert nicht, die echte API ist
>    `odoo.execute({ model, method, positionalArgs, kwargs })` — stand
>    nur in `INTEGRATION.md`, nie in dieser CLAUDE.md).
>
> **WICHTIG bei klassischem `activate-body`-Slot**: `return { ... }` lebt
> AUSSERHALB der activate-body-Marker-Region (Boilerplate-Restructure 2026-05-04).
> Der Slot deklariert `const toolkit = createToolkit(...)`; das `return`
> läuft danach automatisch im Boilerplate. NICHT mehr `return` im Slot
> schreiben — sonst ist der nachfolgende `external-reads-init`-Block
> unreachable.

Skelett (mit dem konkreten Pattern aus `INTEGRATION.md` füllen):

```typescript
import type { /* TypeForService */ } from '@omadia/integration-<name>';

// im activate-body-Slot:
const svc = ctx.services.get</* TypeForService */>('<service.name>');
if (!svc) {
  throw new Error(
    "'<service.name>' unavailable — depends_on includes " +
    "'de.byte5.integration.<name>'?",
  );
}
// Konkrete Calls mit Method-Signaturen aus INTEGRATION.md.
```

`peerDependencies` in `package.json` muss die Integration referenzieren
(z.B. `"@omadia/integration-odoo": "*"`) damit die Type-Imports
auflösen — siehe Checkliste-Punkt 3.

`client.ts` bleibt für die EIGENE API. Mehrere fremde Integrationen sind
fine — `ctx.services.get(...)` mehrfach pro `activate()` ist OK.

> **Preview vs. Install**: Im Preview-Iframe ist `ctx.routes.register` ein
> No-op-Stub — der Aufruf läuft durch ohne zu crashen, aber die Routes werden
> NICHT gemountet. Die Admin-UI ist erst nach einem echten Install über den
> Store erreichbar (Kernel registriert die Routes dann am Plugin-Slug-Mount).
> Im Preview-Mode also nicht versuchen, die `/api/<slug>/admin/...`-URL
> aufzurufen — sie existiert dort nicht.

### Runtime-Smoke-Contract (Theme D)

Nach jedem `build_status: ok` probiert der Builder die registrierten
Admin-GET-Routes per HTTP. Was geprüft wird:

1. **`{ ok: boolean, ... }`-Schema (PFLICHT).** Body ohne `ok`-Field
   oder mit `ok: <kein-boolean>` → `runtime_smoke_status:failed`
   `kind=admin_route_schema_violation`. AutoFix triggert.
2. **HTTP-Status.** 4xx/5xx → `http_error`. Auch `200 + ok:false` zählt
   als Failure (Endpoint berichtet sich selbst kaputt).
3. **Timeout.** > 5s pro Route → `timeout`.
4. **Empty-Detection für `external_reads`.** Wenn der Endpoint-Name
   einem deklarierten `external_reads.id` matched (z.B.
   `/api/employees` ↔ `list_employees`) und das Wrapper-Objekt nur ein
   leeres Array enthält, fliegt eine **Warning** (kein Fail) — leere
   Daten können legitim sein (frische Odoo-Instanz).

**Smoke-Mode-Branch (optional):** während der Smoke setzt der Probe-
Server den Header `x-smoke-mode: 1` und der Kernel aktiviert das
Plugin mit `ctx.smokeMode === true`. Wenn dein Endpoint
non-idempotent ist (POST/teure-Aggregation/etc.) oder du Mock-Daten
zurückgeben willst, kannst du im Handler darauf branchen:

```typescript
router.get('/api/devices', (req, res) => {
  if (ctx.smokeMode || req.headers['x-smoke-mode'] === '1') {
    return res.json({ ok: true, items: [{ id: 'mock', mac: 'aa:bb:cc:dd:ee:ff' }] });
  }
  // ... echte Logik
});
```

**Default ist: nichts tun.** Most plugins ignorieren `smokeMode` und
lassen den Probe einfach gegen die echte API laufen — bei einer 5s-
Timeout-Budget und idempotenten GETs ist das billig.

### Baustein 3: `admin_ui_path` im manifest.yaml (Top-Level)

```yaml
schema_version: "1"
identity:
  id: "{{AGENT_ID}}"
  ...

# Top-Level (NICHT unter identity), Pfad MUSS auf /index.html enden:
admin_ui_path: "/api/<slug>/admin/index.html"
```

Web-dev rendert dann automatisch eine `<iframe src="/bot-api{admin_ui_path}">`-
Section auf der Store-Detail-Page (`/store/<plugin-id>`), conditional auf
`install_state ∈ { 'installed', 'update-available' }`. **Keine web-ui-Änderung
nötig** — der Pattern ist generisch (Phase 3.2.7).

### Reference-Implementation

`middleware/packages/harness-channel-telegram/src/plugin.ts:200-260` macht
genau dieses Pattern (single-file vanilla HTML als admin-UI). Sauber zum
Abgucken.

### Was NICHT geht

- **Absolute `/api/...`-URLs in `fetch()`-Calls**: die UI ist hinter
  einem `/bot-api`-Rewrite — absolute Pfade verlassen das Plugin-Mount
  und ergeben 404. Siehe KRITISCH-Block oben in Baustein 1.
- **Backend `res.json({ items })` ohne `ok: true`**: Frontend prüft
  `data.ok` — fehlt das Feld, sieht es jeden Erfolg als Fehler. Siehe
  Response-Schema-Block in Baustein 2.
- **Eigenen `client.ts` für FREMDE Daten missbrauchen**: `client.search('__employees')`
  gegen den UniFi-Client geht nirgendwohin. Fremde Daten = Service-Registry
  + `depends_on` (siehe "Daten aus anderen Plugins ziehen" oben).
- **API-Signaturen für fremde Integrationen aus dem Trainings-Wissen
  rekonstruieren**: das CLAUDE.md hier dokumentiert KEINE konkreten
  Method-Signaturen für `OdooClient`, `ConfluenceClient`, etc. mehr —
  driftet bei jedem Integration-Patch. Stattdessen `read_reference` auf
  `INTEGRATION.md` des Dependency-Plugins. Hardcoded Beispiele in DIESER
  Datei sind ab sofort verboten (Lessons-learned 2026-05-04).
- **Separate `app.js`/`styles.css`-Dateien**: codegen kann nur Marker-
  Regions in vordefinierten Files füllen, keine neuen Files erzeugen.
  Inline `<script>` und `<style>` im `admin-ui-body`-Slot sind die
  unterstützte Form.
- **`ctx.http.register(...)`**: `ctx.http` ist die OUTBOUND-fetch-Surface
  (für API-Calls AUS dem Plugin). Inbound-Routes laufen über `ctx.routes`.
- **Build-Step im Plugin** (npm-script o.ä.): das Boilerplate-`build-zip.mjs`
  läuft NUR `tsc`, nicht webpack/vite. UI-Source vorab bauen, gebaute
  Artefakte committen.

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
