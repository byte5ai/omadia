# Ein Plugin bauen & im Hub veröffentlichen

Diese Anleitung führt von „leeres Verzeichnis" bis „installierbar aus dem Hub".
Ein Plugin ist ein **standalone Package**, das als `.zip` hochgeladen wird — der
Server validiert das Manifest, prüft Peer-Dependencies und registriert es im
Katalog. Es gibt drei `kind`s:

| kind | Was es ist | Beispiel |
|---|---|---|
| `agent` | Capability-Anbieter mit Toolkit (Zod-Tools) + System-Prompt | `agent-seo-analyst` |
| `integration` | reiner Credential-/HTTP-Client, kein Toolkit | `de.byte5.integration.odoo` |
| `channel` | User-Surface (Teams, Telegram, …) mit Transport + Adaptern | `harness-channel-teams` |

> **Quellen der Wahrheit (nicht halluzinieren):**
> Referenz-Agent `middleware/packages/agent-seo-analyst/`,
> Boilerplate `middleware/assets/boilerplate/{agent-pure-llm,agent-integration}/`,
> Package-Contract `middleware/assets/boilerplate/agent-pure-llm/CLAUDE.md`
> (die 10 Checkliste-Punkte), Runtime-Contract
> `middleware/src/platform/pluginContext.ts`.

---

## 0. Voraussetzungen

- Node `>=20` (das Repo pinnt `22.x` in `.nvmrc` → `nvm use`).
- Zugang zur Admin-UI (`https://odoo-bot-harness.fly.dev`) für den Upload.
- Zum **Publishen** auf den Hub: das `HUB_PUBLISH_TOKEN` (Bearer-Token, liegt
  im Vercel-Env des Hub-Projekts — write-only, nicht im Chat leaken).

---

## 1. Scaffold aus der Boilerplate

Wähle das Template nach Bedarf: `agent-pure-llm` (kein externes API, reines
Prompting) oder `agent-integration` (echter HTTP-Client + Secrets).

```bash
cp -R middleware/assets/boilerplate/agent-pure-llm \
      middleware/packages/agent-<slug>
cd middleware/packages/agent-<slug>

# Skill-Datei umbenennen
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

---

## 2. Manifest ausfüllen (`manifest.yaml`)

Ersetze alle `{{PLATZHALTER}}`. Die **`identity`**-Felder + `compat.core` sind
das, was Hub und Katalog für die Listing-Kachel lesen — der Rest wird beim
Install voll validiert.

```yaml
schema_version: "1"

identity:
  id: "de.byte5.agent.<slug>"      # lowercase, dotted; === package.json "name"
  kind: "agent"                    # agent | integration | channel
  domain: "<domain>"               # z.B. coaching, m365.sharepoint
  name: "<Anzeigename>"
  version: "0.1.0"                 # SemVer; === package.json "version"
  description: "<Beschreibung DE>"
  authors:
    - name: "byte5 GmbH"
      email: "info@omadia.ai"
  license: "Proprietary"           # oder MIT, …
  icon: "./assets/icon.png"
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

capabilities: []                   # Tools liefert das toolkit; [] = pure-LLM

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
- Deps via `peerDependencies` (nicht `dependencies`) — Ingest warnt sonst via `peers_missing`.
- `setup.fields` nur deklarieren, wenn der Parent (`depends_on`) sie **nicht** schon hat (sonst silent override).

---

## 3. Implementieren

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

Details + Zod-Support-Matrix + Lifecycle-Budgets: die 10 Punkte in
`middleware/assets/boilerplate/agent-pure-llm/CLAUDE.md`. Kanonische Vorlage:
`middleware/packages/agent-seo-analyst/`.

```bash
npm install
npm run lint:fix && npm run typecheck   # nicht bauen — nur prüfen
```

---

## 4. ZIP bauen

```bash
node scripts/build-zip.mjs
# ▶ tsc … ✓ built out/de.byte5.agent.<slug>-0.1.0.zip
```

Das Script: `tsc` → `dist/`, kopiert Runtime-Artefakte (`manifest.yaml`,
`package.json`, `README.md`, `dist/`, `skills/`, `assets/`) nach
`out/<id>-<version>-package/`, verifiziert dass der `dist/`-Entry existiert,
und zippt nach `out/<id>-<version>.zip`. **Im ZIP sind nur Runtime-Artefakte**
— keine `*.ts`-Quellen außerhalb `dist/`, kein `node_modules`, kein `.env`.

---

## 5. Lokal installieren (Smoke-Test vor dem Publish)

In der Admin-UI: **Store → Tab „Lokal" → Upload-Dropzone** → `out/<id>-<version>.zip`
hineinziehen. Der Server validiert das Manifest und registriert das Package im
Katalog; es erscheint als **Verfügbar** im Lokal-Tab. Ein Klick auf die Kachel →
Detailseite → **Jetzt installieren** (Setup-Felder rendern automatisch aus
`setup.fields`).

Äquivalent per Admin-API (alle JWT-gated):
`POST /api/v1/install/plugins/:id` → `POST /api/v1/install/jobs/:id/configure`.

---

## 6. Auf den Hub veröffentlichen

Der Hub (`hub.omadia.ai`) ist eine **dumme Registry**: ein Publish schreibt nur
Artefakt + `index.json` um, **kein Redeploy**. Der nächste Index-Read enthält
das Plugin. Versionen sind **immutable**.

```bash
HUB=https://hub.omadia.ai
ZIP=out/de.byte5.agent.<slug>-0.1.0.zip

curl -sS -X POST "$HUB/api/publish" \
  -H "Authorization: Bearer $HUB_PUBLISH_TOKEN" \
  -F "file=@${ZIP}"
# → 201 { "ok": true, "id": "...", "version": { ... } }
```

- Auth: `Authorization: Bearer <HUB_PUBLISH_TOKEN>` (timing-safe geprüft).
- Body: multipart `file=<zip>` **oder** roher `Content-Type: application/zip`.
- Max 50 MiB (= Core's Artefakt-Cap).
- Re-publish derselben `(id, version)` → **409 `publish.version_exists`**.
  Zum Überschreiben (nur dev): `?overwrite=true` anhängen. Sonst:
  Version in `manifest.yaml` + `package.json` bumpen, neu bauen, neu publishen.
- Der Hub extrahiert `manifest.yaml` + `package.json`, validiert leicht (`schema_version: "1"`,
  `identity.*`, gültiger `kind`), rechnet sha256 über die **exakten** Upload-Bytes
  und legt den Index-Eintrag an.

Index + Artefakt prüfen:

```bash
curl -sS "$HUB/registry/index.json" | jq '.plugins[].id'
# → "de.byte5.agent.<slug>"
# Artefakt-URL (host-gepinnt, wird beim Read auf HUB_PUBLIC_URL umgeschrieben):
#   $HUB/registry/<id>/<version>/plugin.zip
```

---

## 7. Im Hub-Tab erscheinen lassen

In der Admin-UI ist die Default-Registry `hub.omadia.ai` bereits geseedet
(verwalten unter **Admin → Registries**). **Store → Tab „Hub"** zieht
`index.json` und zeigt dein Plugin als **Verfügbar** mit dem Badge
`Hub · <registry>`. „Jetzt installieren" lädt das ZIP, prüft sha256, ingestet
es lokal und startet dann den normalen Install-Job.

**Zwei harte Constraints** (aus dem Core-Client — sonst schlägt der Install fehl):
1. Die ZIP-Route **streamt** das Artefakt (kein 302-Redirect) — der Client
   fetcht mit `redirect: 'error'`.
2. Der `download_url`-Host muss == registrierter Registry-Host sein
   (**Host-Pinning**) — nie eine Blob-/`*.vercel.app`-URL.

---

## 8. Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| Plugin taucht nicht im **Hub**-Tab auf, obwohl publiziert | Eine **lokale** Kopie gleicher `id` ist installiert → der Merge bevorzugt lokal (local-wins) und droppt den Remote-Eintrag. Built-in-Plugins (z.B. `@omadia/plugin-office`) sind deshalb nie im Hub-Tab sichtbar — zum Test ein **Nicht-Built-in** publishen. |
| `409 publish.version_exists` | Version existiert schon (immutable). Version bumpen oder `?overwrite=true` (dev). |
| `401 publish.unauthorized` | `HUB_PUBLISH_TOKEN` falsch/fehlt. |
| Ingest warnt `peers_missing` | Deps stehen unter `dependencies` statt `peerDependencies`. |
| Install scheitert mit `install.missing_capability` | `requires:` im Manifest hat keinen aktiven Provider → der Install-Wizard zeigt die zu installierende Chain. |

---

## Referenzen

- Package-Contract (10 Punkte): `middleware/assets/boilerplate/agent-pure-llm/CLAUDE.md`
- Kanonischer Agent: `middleware/packages/agent-seo-analyst/`
- Runtime-Contract: `middleware/src/platform/pluginContext.ts`
- Store-/Install-Routen: `middleware/src/routes/{store,install,registryInstall}.ts`
- Registry-Client (Hub-Konsum): `middleware/src/plugins/registryClient.ts`
