# Ein Plugin bauen & im Hub veröffentlichen

Diese Anleitung führt von „leeres Verzeichnis" bis „installierbar aus dem Hub".
Ein Plugin ist ein **standalone Package**, das als `.zip` hochgeladen wird — der
Server validiert das Manifest, prüft Peer-Dependencies und registriert es im
Katalog. Es gibt drei `kind`s, und sie unterscheiden sich **nicht nur im
Manifest, sondern auch im Code-Contract**:

| kind | Was es ist | `activate()` gibt zurück | Beispiel |
|---|---|---|---|
| `agent` | Capability-Anbieter mit Toolkit (Zod-Tools) + System-Prompt | `{ toolkit, close }` | `agent-seo-analyst` |
| `integration` | reiner Credential-/HTTP-Client, kein Toolkit | (kein Toolkit; nur Secrets/Config-Container) | `de.byte5.integration.odoo` |
| `channel` | User-Surface (WhatsApp, Teams, Telegram, …) mit Transport + Adaptern | **`ChannelHandle` über `activate(ctx, core)`** | `@omadia/channel-whatsapp` |

> **Quellen der Wahrheit (nicht halluzinieren):**
> - Agent: Referenz `middleware/packages/agent-seo-analyst/`, Boilerplate
>   `middleware/assets/boilerplate/{agent-pure-llm,agent-integration}/`,
>   Package-Contract (10 Punkte) `…/agent-pure-llm/CLAUDE.md`.
> - Channel: SDK-Contract `middleware/packages/harness-channel-sdk/src/`,
>   öffentliches Referenz-Plugin **`byte5ai/omadia-channel-whatsapp`**
>   (Teams/Telegram-Quelle liegt privat). Resolver
>   `middleware/src/channels/dynamicChannelResolver.ts`.
> - Runtime-Contract `middleware/packages/plugin-api/src/pluginContext.ts`
>   (das Package `@omadia/plugin-api`).
> - Manifest-Schema `docs/harness-platform/manifest-schema.v1.yaml`
>   (`channel:`-Block = Section 14).

---

## 0. Voraussetzungen

- Node `>=20` (das Repo pinnt die genaue Version in `.nvmrc` → `nvm use`).
- Zugang zur Admin-UI (`https://odoo-bot-harness.fly.dev`) für den lokalen Upload.
- Zum **Publishen** auf den Hub: das `HUB_PUBLISH_TOKEN` (Bearer-Token; liegt im
  Vercel-Env des Hub-Projekts bzw. lokal in `hub/.env.local` — **write-only,
  nie im Chat/Log leaken**).
- Wenn dein Plugin eine **Nicht-Host-Dependency** braucht (z.B. ein Channel,
  der `@whiskeysockets/baileys` nutzt): zusätzlich `esbuild` als devDependency
  zum Bundlen (siehe §5).

---

## 1. Welchen `kind` baust du?

Bei vagem „Plugin" zuerst klären — die drei kinds teilen Manifest-Schema +
Zip-Flow, aber der Code-Contract ist verschieden:

- **`agent`** — liefert Tools (Zod-Toolkit) + einen System-Prompt-Partial. Die
  Runtime macht SubAgent-Wrap, Tool-Bridge und Prompt-Concat. → §2–§4a.
- **`integration`** — nur Secrets/Config-Container, von dem `agent`s via
  `depends_on` erben. Kein Toolkit.
- **`channel`** — User-Surface. Empfängt native Events, übersetzt sie in den
  `IncomingTurn`-Shape, fährt einen Orchestrator-Turn und rendert die Antwort
  zurück. **Keine** `capabilities`/`playbook`/`skills`. → §4b.

---

## 2. Scaffold aus der Boilerplate (agent)

Wähle `agent-pure-llm` (kein externes API, reines Prompting) oder
`agent-integration` (echter HTTP-Client + Secrets):

```bash
cp -R middleware/assets/boilerplate/agent-pure-llm \
      middleware/packages/agent-<slug>
cd middleware/packages/agent-<slug>
mv skills/{{AGENT_SLUG}}-expert.md skills/<slug>-expert.md
```

Package-Layout (flach, am Root):

```
agent-<slug>/
├── manifest.yaml         # deklarative Definition (Schema v1) — Pflicht
├── package.json          # name === manifest.identity.id, "type":"module", "private":true
├── tsconfig.json         # NodeNext, rootDir:"./", outDir:"./dist"
├── types.ts              # lokales PluginContext-Duplikat (KEIN Cross-Import!)
├── plugin.ts             # activate(ctx) → { toolkit, close() }
├── toolkit.ts            # Capability → ToolDescriptor[] (Zod-Input + run)
├── client.ts             # externe API (LLM-frei, testbar) — nur agent-integration
├── index.ts              # Barrel
├── skills/<slug>-expert.md   # System-Prompt-Partial (YAML-Frontmatter)
├── assets/               # icon.png etc. (optional)
└── scripts/build-zip.mjs # tsc + stage + zip → out/<id>-<version>.zip
```

> Ein **Channel** wird i.d.R. NICHT aus der Agent-Boilerplate gescaffoldet —
> es gibt (noch) keine Channel-Boilerplate. Nimm `byte5ai/omadia-channel-whatsapp`
> als Vorlage; das Layout steht in §4b.

---

## 3. Manifest ausfüllen (`manifest.yaml`)

Ersetze alle `{{PLATZHALTER}}`. Die **`identity`**-Felder + `compat.core` sind
das, was Hub und Katalog für die Listing-Kachel lesen — der Rest wird beim
Install voll validiert.

```yaml
schema_version: "1"

identity:
  id: "de.byte5.agent.<slug>"      # === package.json "name". byte5-privat: reverse-DNS;
                                   # public OSS: "@omadia/<slug>" (wie @omadia/plugin-office)
  kind: "agent"                    # agent | integration | channel
  domain: "<domain>"               # z.B. coaching, m365.sharepoint, whatsapp — lowercase, dotted
  name: "<Anzeigename>"
  version: "0.1.0"                 # SemVer; === package.json "version"
  description: "<Beschreibung DE>"
  authors:
    - name: "byte5 GmbH"
      email: "info@omadia.ai"
  license: "Proprietary"           # oder MIT (public OSS)
  icon: "./assets/icon.png"        # PNG oder SVG
  categories: ["<kategorie>"]

compat:
  core: ">=1.0 <2.0"
  node: ">=20"

multi_instance: true
privacy_class: "strict"
depends_on: []                     # IDs von Parent-Integrations (Secret-Chain)

setup:
  fields: []                       # Setup-Felder → rendern automatisch im Install-Drawer
  self_test: false

capabilities: []                   # Tools liefert das toolkit; [] = pure-LLM (NICHT für channel)

skills:
  - id: "<slug>_expert_system"
    kind: "prompt_partial"
    path: "skills/<slug>-expert.md"
    description: "Rolle & Arbeitsweise."

permissions:
  memory:
    reads: ["session:*", "agent:de.byte5.agent.<slug>:*"]
    writes: ["agent:de.byte5.agent.<slug>:*"]
  network:
    outbound: []                   # erlaubte Hosts (leer = pure-LLM)
```

**Regeln, die sonst erst zur Install-/Ingest-Zeit knallen:**
- `package.json` `name`/`version` müssen **exakt** `identity.id`/`identity.version` spiegeln.
- **Shared/Host-Deps via `peerDependencies`** (nicht `dependencies`) — Ingest warnt sonst
  via `peers_missing`. Eigene, nicht-Host-Deps werden gebundelt (siehe **§5**).
- `setup.fields` nur deklarieren, wenn der Parent (`depends_on`) sie **nicht** schon
  hat (sonst silent override).
- `setup.fields[].type`: `string | url | secret | oauth | enum | boolean | integer | host_list`.
  `enum` braucht `enum: [{value,label}]`, `oauth` braucht `provider` + `scopes`.

---

## 4a. Implementieren — Agent

- **`activate(ctx)`** gibt fix zurück:
  `{ toolkit: { tools: ToolDescriptor[]; close() }, close() }`.
  `ToolDescriptor = { id, description, input: ZodSchema, run(input) }`.
- Kein eigener LLM-Client, keine eigene Tool-Loop — die Runtime macht
  SubAgent-Wrap, Tool-Bridge, Tool-Name-Derivation (`…agent.<slug>` →
  `query_<slug>`) und System-Prompt-Concat aus `skills/*.md`.
- Secrets/Config nur über `ctx`:
  `await ctx.secrets.get(k)` / `.require(k)` (async), `ctx.config.get<T>(k)` (sync).
- System-Prompt gehört in `skills/<slug>-expert.md` (Markdown + YAML-Frontmatter),
  **nicht** in den Code.

Details + Zod-Support-Matrix + Lifecycle-Budgets (`activate` ≤10s, `close` ≤5s):
die 10 Punkte in `middleware/assets/boilerplate/agent-pure-llm/CLAUDE.md`.
Kanonische Vorlage: `middleware/packages/agent-seo-analyst/`.

```bash
npm install
npm run lint:fix && npm run typecheck   # nicht bauen — nur prüfen
```

---

## 4b. Implementieren — Channel

Ein Channel ist ein **Plattform-Adapter**: er hält Transport (WebSocket /
Webhook / Long-Poll) offen, übersetzt native Events in `IncomingTurn`, fährt den
Orchestrator-Turn und rendert die Antwort zurück. Quelle: `@omadia/channel-sdk`
(`middleware/packages/harness-channel-sdk/src/`). Öffentliche Referenz:
**`byte5ai/omadia-channel-whatsapp`**.

**Export-Contract (≠ agent!).** Der Kernel-Resolver
(`middleware/src/channels/dynamicChannelResolver.ts` → `pickChannelPlugin`)
importiert `dist/plugin.js` und akzeptiert drei Export-Shapes, in dieser
Priorität:

1. **`export async function activate(ctx, core)`** — bare function. ← **bevorzugt**
2. `export default { activate(ctx, core) {…} }` — Default-Objekt mit Methode.
3. `export default <ChannelPlugin-Instanz>`.

Es gibt **keinen** Konstruktor mit Deps — alles kommt über `ctx` (PluginContext)
und `core` (CoreApi):

```ts
import {
  getChatAgent,                 // SDK-Helper: löst den Orchestrator auf
  isNoReply,
  type CoreApi, type ChannelHandle, type IncomingTurn,
} from '@omadia/channel-sdk';
import type { PluginContext } from '@omadia/plugin-api';

export async function activate(ctx: PluginContext, core: CoreApi): Promise<ChannelHandle> {
  // 1. Transport öffnen (NICHT awaiten bis "verbunden" — activate-Budget = 10s).
  // 2. Auf inbound Events: IncomingTurn bauen → Turn fahren → rendern → zurücksenden.
  // 3. Optionale Admin-/Status-UI via ctx.routes.register (siehe unten).
  return { async close() { /* Sockets/Timer freigeben (≤5s) */ } };
}
```

**Einen Turn fahren — zwei Wege:**

```ts
// (a) Gefaltete Antwort (ein await, kein Event-Loop) — am einfachsten:
const agent = getChatAgent(ctx);              // ← SDK-Helper, Typ ChatAgent | undefined
if (!agent) throw new Error('orchestrator unavailable');
const answer = await agent.chat({ userMessage: turn.text, sessionScope, userId });
// answer: SemanticAnswer { text, interactive?, attachments?, followUps?, disclaimer? }

// (b) Live-Event-Stream (für Channels mit Tipp-/Tool-Trace-Anzeige):
for await (const ev of core.handleTurnStream(turn)) { /* ev: ChatStreamEvent */ }
```

> `core.handleTurnStream(turn)` ist seit der Orchestrator-Verkabelung **real**
> an den aktiven `chatAgent` gebunden (`middleware/src/index.ts` →
> `orchestratorDispatcher`). Vorher war der Dispatcher ein Stub, der Turns
> still verschluckte (Log `stub dispatcher: turn ignored`) — wer darüber fuhr,
> bekam keine Antwort. Für simple Frage→Antwort genügt
> `getChatAgent(ctx).chat(...)` (gibt direkt eine `SemanticAnswer`).

**`core` (CoreApi)** — was der Channel sonst auf dem Kernel aufruft:
- `handleTurnStream(turn): AsyncIterable<ChatStreamEvent>` (siehe oben),
- `registerRoute` / `registerRouter` — channel-scoped Express-Routen (auto-503 bei deactivate),
- `resolveIdentity(ref)`, `log(level, msg, ctx?)`.

**Inbound → Turn.** `IncomingTurn = { channelId, conversationId, userRef:{ kind,
id, displayName? }, text, attachments?, metadata?, rawEvent? }`. `userRef.kind`
ist ein geschlossener Union — WhatsApp = `'whatsapp-phone'`, Telegram =
`'telegram-chat'`, Teams = `'teams-aad'`, Slack/Discord/`custom`. `isNoReply()`
filtert die `NO_REPLY`-Sentinel; `SemanticAnswer` rendert der Channel native.

**Manifest-Besonderheiten (channel).** Keine `capabilities`/`playbook`/`skills`.
Dafür der `channel:`-Block (Schema Section 14):

```yaml
identity:
  kind: "channel"
lifecycle:
  entry: "dist/plugin.js"          # exportiert activate(ctx, core)
admin_ui_path: "/api/<slug>/admin/index.html"   # Top-Level → web-ui rendert iframe
channel:
  transport:
    kind: "websocket"              # webhook | websocket | long-poll
    routes: []                     # nur für kind=webhook nötig
  capabilities: ["text", "typing_indicator"]   # text|attachments|interactive_cards|user_sso|…
  adapters: ["text", "markdown"]   # text|markdown|adaptive_card|telegram_keyboard|…
```

**Admin-UI / Auth-Surface (z.B. QR-Code).** Express-Router mit
`ctx.routes.register('/api/<slug>/admin', router)` mounten (static `index.html`
+ JSON-API), im Manifest `admin_ui_path` auf `…/index.html` zeigen → web-ui
rendert automatisch ein `<iframe src="/bot-api{admin_ui_path}">` auf der
Store-Detail-Page. Harte Regeln (siehe
`middleware/assets/boilerplate/agent-integration/assets/admin-ui/CLAUDE.md`):
`fetch()` **relativ** (`api/status`), jede Antwort `{ ok, … }`, Stylesheet
`/bot-api/_harness/admin-ui.css`, nur `var(--*)`-Tokens, keine externen Scripts/Fonts.

**WhatsApp/Baileys-Lehren (aus `channel-whatsapp`, falls relevant):**
- Auth-State über `ctx.memory` persistieren (überlebt Restart) →
  `permissions.memory.{reads,writes}` deklarieren.
- WhatsApp adressiert Chats teils per **LID** (`…@lid`), nicht per Telefonnummer.
  Self-Chat-Erkennung gegen `sock.user.lid` (eigene LID) UND die PN matchen.
  Allowlist gegen `senderPn`/`participantPn` (nicht die LID-Ziffern).
- `fromMe:true`-Nachrichten NICHT pauschal droppen (sonst antwortet ein
  same-account-Bot nie im Self-Chat) — nur die eigenen Replies via Sent-ID-Set
  ausschließen, um Loops zu vermeiden.

---

## 5. Dependencies & Bundling — die wichtigste Falle

**Der Host installiert KEINE Plugin-Dependencies.** Ein hochgeladenes Package
wird unter `<packagesDir>/<id>/<version>/` entpackt (kein `npm install`,
`middleware/src/plugins/packageUploadService.ts`) und zur Laufzeit per
dynamischem `import()` **in-process** geladen. Bare Specifier (`import x from
'foo'`) werden gegen das **Host-`node_modules`** aufgelöst — ein Symlink
`<packagesDir>/node_modules → <host>/node_modules`
(`uploadedPackageStore.ensureHostNodeModulesLink`) bridged das.

Folge — **zwei disjunkte Klassen von Deps:**

| Klasse | Wohin in `package.json` | Beim Build |
|---|---|---|
| **Host-bereitgestellt** (`@omadia/*`, `express`, `zod`, …) | `peerDependencies` | `external` lassen (NICHT bundeln) |
| **Eigene, nicht-Host** (`@whiskeysockets/baileys`, `qrcode`, …) | `dependencies` | **in `dist/` bundeln** |

Ein Plugin, das eine Dep importiert, die der Host **nicht** schon hat, crasht
zur Laufzeit mit `Cannot find package 'X'` — **`tsc` allein reicht dann nicht**,
weil `tsc` nur transpiliert, nicht bündelt. Lösung: ein `esbuild`-Bundle-Step im
Build (siehe `omadia-channel-whatsapp/scripts/build-zip.mjs`):

```js
import { build } from 'esbuild';
await build({
  entryPoints: ['src/plugin.ts'],
  outfile: 'dist/plugin.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  // Host-Peers NICHT inlinen; alles andere (Baileys, qrcode, …) wird gebundelt:
  external: ['@omadia/channel-sdk', '@omadia/plugin-api', 'express'],
  // ESM-Banner, damit gebundelter CJS-Code require/__dirname hat:
  banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
});
```

Hinweise:
- **Type-only Imports** (`import type { … }`) verschwinden im Bundle von selbst —
  `@omadia/plugin-api` taucht z.B. gar nicht als Runtime-Import auf, wenn nur Typen
  daraus genutzt werden.
- `typecheck` läuft separat (`tsc --noEmit`). Für ein standalone-Repo, das nicht
  neben dem Core-Checkout liegt, die `@omadia/*`-Typen via `tsconfig.paths` auf die
  gebauten `.d.ts` mappen (siehe channel-whatsapp `tsconfig.json`).
- Peer-`@omadia/*` sind nicht auf npm → `npm install` mit
  `legacy-peer-deps=true` (`.npmrc`), sonst 404 beim Peer-Auto-Install.

---

## 6. ZIP bauen

```bash
node scripts/build-zip.mjs
# agent (tsc):     ▶ tsc … ✓ built out/de.byte5.agent.<slug>-0.1.0.zip
# channel (esbuild): ▶ esbuild bundle … ✓ built out/omadia-channel-whatsapp-0.1.0.zip
```

Das Script: kompiliert/bundelt nach `dist/`, kopiert Runtime-Artefakte
(`manifest.yaml`, `package.json`, `README.md`, `dist/`, `skills/`, `assets/`,
`LICENSE`) nach `out/<id>-<version>-package/`, verifiziert dass der `dist/`-Entry
existiert, und zippt nach `out/<id>-<version>.zip`. **Im ZIP sind nur
Runtime-Artefakte** — keine `*.ts`-Quellen außerhalb `dist/`, kein
`node_modules`, kein `.env`. Der `safeName` strippt `@` und ersetzt `/` durch `-`
(`@omadia/channel-whatsapp` → `omadia-channel-whatsapp`).

Extension-Allowlist im Host-Extractor: `.yaml .md .json .js .mjs .cjs .map .png
.svg .jpg .txt` + `LICENSE / README / NOTICE`. Ein gebundeltes `dist/plugin.js`
(auch mehrere MB) ist nur eine `.js`-Datei — passt.

---

## 7. Lokal installieren (Smoke-Test vor dem Publish)

In der Admin-UI: **Store → Tab „Lokal" → Upload-Dropzone** → `out/<id>-<version>.zip`
hineinziehen. Der Server validiert das Manifest und registriert das Package im
Katalog; es erscheint als **Verfügbar** im Lokal-Tab. Ein Klick auf die Kachel →
Detailseite → **Jetzt installieren** (Setup-Felder rendern automatisch aus
`setup.fields`; bei Channels öffnet sich nach Install die Admin-UI/QR-Sektion).

Äquivalent per Admin-API (alle JWT-gated):
`POST /api/v1/install/plugins/:id` → `POST /api/v1/install/jobs/:id/configure`.

---

## 8. Auf den Hub veröffentlichen (Deployment)

Der Hub (`hub.omadia.ai`) ist eine **dumme Registry**: ein Publish schreibt nur
Artefakt + `index.json` um, **kein Redeploy**. Der nächste Index-Read enthält das
Plugin. Versionen sind **immutable**. Contract: `hub/app/api/publish/route.ts`
(Service-Seite) ↔ `middleware/src/plugins/registryClient.ts` (Core-Konsum).

**Schritt für Schritt:**

```bash
# 1. Token bereitstellen — NICHT echoen. Aus dem Hub-Env lesen:
export HUB_PUBLISH_TOKEN="$(grep -E '^HUB_PUBLISH_TOKEN=' hub/.env.local | cut -d= -f2-)"
export HUB=https://hub.omadia.ai
export ZIP=out/omadia-channel-whatsapp-0.1.0.zip

# 2. Publish (multipart):
curl -sS -X POST "$HUB/api/publish" \
  -H "Authorization: Bearer $HUB_PUBLISH_TOKEN" \
  -F "file=@${ZIP}"
# → 201 { "ok": true, "id": "@omadia/channel-whatsapp", "kind": "channel",
#         "storage": "blob", "version": { "version": "0.1.0", "sha256": "…", … } }

# 3. Verifizieren, dass der Index das Plugin trägt:
curl -sS "$HUB/registry/index.json" | jq '.plugins[].id'
```

- **Auth:** `Authorization: Bearer <HUB_PUBLISH_TOKEN>` (timing-safe geprüft).
  Fehlt/falsch → **401 `publish.unauthorized`**; Hub ohne Token konfiguriert →
  **503 `publish.disabled`**.
- **Body:** multipart `file=<zip>` **oder** roher `Content-Type: application/zip`.
- **Max 50 MiB** (= Core's Artefakt-Cap) → sonst **413 `publish.too_large`**.
- **Immutable:** Re-publish derselben `(id, version)` → **409
  `publish.version_exists`**. Zum Überschreiben (nur dev): `?overwrite=true`.
  Sonst: Version in `manifest.yaml` **+** `package.json` bumpen, neu bauen, neu
  publishen.
- Der Hub extrahiert `manifest.yaml` + `package.json`, validiert leicht
  (`schema_version: "1"`, `identity.*`, gültiger `kind`), rechnet sha256 über die
  **exakten** Upload-Bytes und legt/aktualisiert den Index-Eintrag.

> **Prod-Token (CI/headless):** der echte `HUB_PUBLISH_TOKEN` liegt im
> Vercel-Env des `omadia-hub`-Projekts (das `hub/.env.local` enthält nur den
> **lokalen** Dev-Token für `localhost:3100`). Ziehen via
> `cd hub && vercel env pull <tmp> --environment=production --yes`, Wert
> rausgreifen, danach Tmp-File löschen — nie echoen.

Artefakt-URL (host-gepinnt, wird beim Read auf `HUB_PUBLIC_URL` umgeschrieben):
`$HUB/registry/<id>/<version>/plugin.zip`.

---

## 9. Im Hub-Tab erscheinen lassen

In der Admin-UI ist die Default-Registry `hub.omadia.ai` bereits geseedet
(verwalten unter **Admin → Registries**). **Store → Tab „Hub"** zieht
`index.json` und zeigt dein Plugin als **Verfügbar** mit dem Badge
`Hub · <registry>`. „Jetzt installieren" lädt das ZIP, prüft sha256, ingestet es
lokal und startet dann den normalen Install-Job.

**Zwei harte Constraints** (aus dem Core-Client — sonst schlägt der Install fehl):
1. Die ZIP-Route **streamt** das Artefakt (kein 302-Redirect) — der Client
   fetcht mit `redirect: 'error'`.
2. Der `download_url`-Host muss == registrierter Registry-Host sein
   (**Host-Pinning**) — nie eine Blob-/`*.vercel.app`-URL.

---

## 10. Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| Channel aktiviert nicht / `activate is not a function` | Falscher Export-Shape. `dist/plugin.js` muss `export async function activate(ctx, core)` (oder `export default {activate}`) liefern — siehe §4b. |
| Channel ackt Nachrichten, antwortet aber nie | Turn wird ins Leere gefahren. Über `getChatAgent(ctx).chat(...)` ODER `core.handleTurnStream(turn)` fahren (beides an den aktiven Orchestrator gebunden) — und sicherstellen, dass das Orchestrator-Plugin aktiv ist (`anthropic_api_key` gesetzt). |
| Plugin crasht zur Laufzeit mit `Cannot find package 'X'` | `X` ist nicht im Host-`node_modules` und wurde nicht gebundelt. Entweder `X` in `dist/` bundeln (esbuild, §5) oder — wenn host-bereitgestellt — als `peerDependencies` deklarieren. |
| Ingest warnt `peers_missing` | Eine deklarierte Peer-Dep fehlt im Host. Host-Dep ergänzen, oder (für eigene Deps) auf `dependencies` + Bundle umstellen. |
| `npm install` schlägt mit 404 auf `@omadia/*` fehl | Peers sind privat/nicht-npm. `.npmrc` mit `legacy-peer-deps=true`; `@omadia/*`-Typen via `tsconfig.paths` resolven. |
| Plugin taucht nicht im **Hub**-Tab auf, obwohl publiziert | Eine **lokale** Kopie gleicher `id` ist installiert → Merge bevorzugt lokal (local-wins). Built-ins (z.B. `@omadia/plugin-office`) sind deshalb nie im Hub-Tab — zum Test ein Nicht-Built-in publishen. |
| `409 publish.version_exists` | Version existiert (immutable). Version bumpen oder `?overwrite=true` (dev). |
| `401 publish.unauthorized` / `503 publish.disabled` | `HUB_PUBLISH_TOKEN` falsch/fehlt bzw. im Hub-Env nicht gesetzt. |
| Admin-UI/QR lädt nicht im Store-iframe | `fetch()` war absolut statt relativ, oder Response ohne `{ ok }`, oder `admin_ui_path` zeigt nicht auf `…/index.html`. Siehe §4b + admin-ui CLAUDE.md. |
| Install scheitert mit `install.missing_capability` | `requires:` im Manifest hat keinen aktiven Provider → der Install-Wizard zeigt die zu installierende Chain. |

---

## Referenzen

- Package-Contract Agent (10 Punkte): `middleware/assets/boilerplate/agent-pure-llm/CLAUDE.md`
- Admin-UI-Constraints: `middleware/assets/boilerplate/agent-integration/assets/admin-ui/CLAUDE.md`
- Kanonischer Agent: `middleware/packages/agent-seo-analyst/`
- Channel-SDK: `middleware/packages/harness-channel-sdk/src/` (`@omadia/channel-sdk`) — inkl. `getChatAgent(ctx)`
- Öffentliches Channel-Referenz-Plugin: `byte5ai/omadia-channel-whatsapp`
- Runtime-Contract: `middleware/packages/plugin-api/src/pluginContext.ts` (`@omadia/plugin-api`)
- Manifest-Schema (inkl. `channel:`-Block §14): `docs/harness-platform/manifest-schema.v1.yaml`
- Channel-Resolver (Export-Shapes): `middleware/src/channels/dynamicChannelResolver.ts`
- Turn-Dispatcher (CoreApi → Orchestrator): `middleware/src/channels/coreApi.ts` + `middleware/src/index.ts`
- Dep-Resolution / Symlink-Bridge: `middleware/src/plugins/{packageUploadService,uploadedPackageStore}.ts`
- Hub-Publish-Route (Service): `hub/app/api/publish/route.ts`
