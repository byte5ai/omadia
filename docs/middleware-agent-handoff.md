# Middleware, Agent & Memory — Handoff

Starting point for a fresh session. This document is self-contained; the
previous conversation is not carried over.

**Sprachkonvention:** Prosa auf Deutsch (byte5-Arbeitssprache), Code-
Identifier und Tool/API-Namen auf Englisch. Scope dieser Session:
**Backend**, also `middleware/` + `skills/`. Für `web-ui/` existiert ein
separater Handoff unter [docs/dev-frontend-handoff.md](dev-frontend-handoff.md).

---

## 1. Was byte5 hier baut

Ziel: eine Middleware als **Single Point of Answer** für interne Fragen
zu Odoo-Produktion + Confluence-Playbook + (später) weiteren Systemen.
Langfristperspektive: Unternehmensintelligenz auf Knowledge-Graph-Basis,
nicht nur ein Chatbot.

### Drei-Schichten-Architektur (mental model)

1. **Execution-Layer** — Orchestrator + Domain-Sub-Agents. Tool-Loop gegen
   Anthropic Claude. **Läuft vollständig lokal in-process** (kein Managed
   Agent mehr).
2. **Knowledge-Layer** — Lokaler Knowledge-Graph über Sessions, Turns und
   die Odoo/Confluence-Entities, die sie berührt haben. Wird beim
   Startup aus den Markdown-Transkripten rehydriert.
3. **Retrieval-Layer** — Noch nicht gebaut. Vector-Store + GraphRAG-
   Queries sind auf der Roadmap.

### Entry-Points für User

- **Teams-Bot** — Bot Framework, `/api/messages`. In Prod via Fly.
- **HTTP Chat** — `/api/chat` (blocking) + `/api/chat/stream` (NDJSON).
  Wird von der Dev-UI (`web-ui/`) genutzt.

---

## 2. Verzeichnis-Layout

```
/Users/johndoe/sources/odoo-bot/
├── agent-config-accounting.yaml       # Alte Managed-Agent-Configs,
├── agent-config-confluence.yaml       # werden nicht mehr aktiv genutzt
├── agent-config-hr.yaml               # (Referenz für Skill-Descriptions)
├── agent-config.yaml
├── docs/
│   ├── day-one-learnings-2026-04-17.md
│   ├── dev-frontend-handoff.md        # UI-Handoff (separater Scope)
│   └── middleware-agent-handoff.md    # DIESES Dokument
├── middleware/                        # FOKUS dieser Session
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   ├── test/
│   ├── scripts/
│   ├── seed/memory/                   # Wird beim Startup in /memories/_rules/ kopiert
│   ├── fly.toml
│   ├── Dockerfile
│   └── .env                           # Lokale Credentials (nicht im Repo)
├── skills/
│   ├── odoo-accounting/SKILL.md       # System-Prompts für Sub-Agents
│   ├── odoo-hr/SKILL.md
│   └── confluence-playbook/SKILL.md
├── scripts/                           # Repo-level Scripts (nicht Middleware-scripts!)
└── web-ui/                           # Dev-UI, eigener Scope
```

### `middleware/src/` im Detail

```
src/
├── index.ts                           # Bootstrap, Wiring, Express-Setup
├── config.ts                          # zod-Schema + .env-Loading
├── memory/
│   ├── store.ts                       # MemoryStore-Interface (Port)
│   ├── filesystem.ts                  # FS-Backend mit Path-Traversal-Schutz
│   └── seeder.ts                      # Kopiert Seed-Files beim Startup
├── routes/
│   ├── chat.ts                        # POST /chat + /chat/stream (NDJSON)
│   ├── messages.ts                    # Teams-Bot-Adapter
│   ├── admin.ts                       # Authentifizierte Memory-Mutation
│   ├── devMemory.ts                   # Unauth. Memory-Browser (flag-gated)
│   └── devGraph.ts                    # Unauth. Graph-Inspect (flag-gated)
├── services/
│   ├── orchestrator.ts                # Tool-Loop, chat + chatStream
│   ├── localSubAgent.ts               # Generischer Sub-Agent-Loop
│   ├── odooClient.ts                  # JSON-RPC + UID-Cache + TLS-Bypass
│   ├── odooCore.ts                    # Whitelist + Red-Line-Filter (shared)
│   ├── odooToolkit.ts                 # Baut odoo_execute-Tool pro Scope
│   ├── odooEntityExtractor.ts         # Odoo-Response → EntityRefs
│   ├── confluenceClient.ts            # REST-Wrapper
│   ├── confluenceCore.ts              # Space-Scoping + EntityRef-Publish
│   ├── confluenceToolkit.ts           # 5 Confluence-Tools
│   ├── confluenceEntityExtractor.ts   # Response → EntityRefs
│   ├── skillLoader.ts                 # Parse SKILL.md (Frontmatter + Body)
│   ├── sessionLogger.ts               # Schreibt Markdown + feedet Graph
│   ├── sessionTranscriptParser.ts     # Reverse von SessionLogger (für Backfill)
│   ├── entityRefBus.ts                # Publish/Subscribe mit Turn-Korrelation
│   ├── turnContext.ts                 # AsyncLocalStorage-Wrapper
│   ├── knowledgeGraph.ts              # Interface + ID-Helper (shared)
│   ├── inMemoryKnowledgeGraph.ts      # Aktive Implementierung
│   └── graphBackfill.ts               # Liest alle Transkripte → Graph
├── tools/
│   ├── memoryTool.ts                  # Wrapper um Anthropic memory_20250818
│   ├── domainQueryTool.ts             # DomainTool-Interface (akzeptiert Askable)
│   └── knowledgeGraphTool.ts          # query_knowledge_graph für Orchestrator
└── types/
    └── entityRef.ts                   # Gemeinsamer EntityRef-Type
```

---

## 3. Die Execution-Layer im Detail

### Orchestrator

- **Datei:** `services/orchestrator.ts`
- **Rolle:** Top-Level-Agent im Teams-Bot / HTTP-Chat-Kontext.
- **Model:** `claude-opus-4-7` (konfigurierbar via `ORCHESTRATOR_MODEL`).
- **Tools:**
  - `memory` (Anthropic managed memory_20250818, beta-header
    `context-management-2025-06-27`)
  - `query_knowledge_graph` (unser eigenes Tool, nur wenn Graph vorhanden)
  - `render_diagram` (unser eigenes Tool, nur wenn Kroki+Tigris-Stack
    konfiguriert — erzeugt Mermaid/PlantUML/Graphviz/Vega-Lite-PNG, gibt
    signierte Proxy-URL zurück, Teams-Adapter + Web-Dev-UI hängen Bild
    automatisch an die Card an. Vega-Lite = Chart-Engine für quantitative
    Daten: Balken/Line/Pie/Scatter aus einem JSON-Spec.)
  - Eine DomainTool-Instanz pro Sub-Agent (`query_odoo_accounting`,
    `query_odoo_hr`, `query_confluence_playbook`)
- **Methoden:** `chat()` blockierend, `chatStream()` als Async-Generator
  mit `ChatStreamEvent`-Events. Beide scopen ihren Turn via
  `turnContext.run` bzw. `turnContext.enter` für EntityRef-Korrelation.
- **System-Prompt:** Spricht Deutsch, liest zu Turn-Start `/memories/_rules`,
  nutzt Session-Transkripte nur auf Rückbezug, persistiert Learnings
  früh (im nächsten Tool-Call, nicht am Ende).

### Sub-Agents (lokal, in-process)

- **Datei:** `services/localSubAgent.ts` (`LocalSubAgent`-Klasse).
- **Rolle:** Ein Sub-Agent pro Domain. Interface `Askable` = `.ask(question): Promise<string>`.
- **Tool-Loop:** eigener kleinerer Loop gegen `messages.create`. Nutzt
  dasselbe SDK + Anthropic-Modell. Hat eigene `maxIterations`
  (`SUB_AGENT_MAX_ITERATIONS`, default 16) und eigene Tools.
- **Logging:** jede Tool-Ausführung loggt `[sub-agent <name>] <tool> → ok|ERR (<ms>, <chars>)`.
- **Kein Memory-Tool:** Sub-Agents sollen nicht eigenständig in den
  globalen Memory schreiben — nur der Orchestrator tut das. Das hält den
  Memory scharf fokussiert.

### Wer ruft wen?

```
User → Orchestrator.chatStream
  ├─ memory (orchestrator-eigene Writes)
  ├─ query_knowledge_graph (eigener Lookup)
  └─ query_odoo_hr (DomainTool)
        └─ LocalSubAgent.ask
              └─ messages.create + odoo_execute
                    └─ executeOdoo (services/odooCore.ts)
                          ├─ Whitelist-Check
                          ├─ Red-Line-Check (HR)
                          ├─ OdooClient.execute (JSON-RPC)
                          ├─ Red-Line-Strip (HR)
                          └─ entityRefBus.publish (tagged mit turnId)
```

---

## 4. Migration Managed Agents → Lokal

### Warum migriert

Managed Agents sind Anthropic-gehostete Beta-Feature. Wir nutzen sie nur
als Skill-Wrapper (unser Memory liegt eh lokal, Session-State haben wir
selbst). Für Produktions-kritische Unternehmensintelligenz ist der
Vendor-Lock-in + Beta-Risiko nicht tragbar. Lokal läuft außerdem
`messages.create` direkt, d.h. 1:1 im eigenen Process, voll loggbar, voll
testbar.

### Was dabei wegfiel

- `services/odooAgent.ts` (Managed-Agent-Client) — gelöscht
- `routes/odooProxy.ts` (HTTP-Proxy für Managed Agents) — gelöscht
- `routes/internal.ts` (Confluence-HTTP-Proxy) — gelöscht
- `routes/internalShared.ts` (Agent-Token-Auth-Middleware) — gelöscht
- Env: `AGENT_PROXY_TOKEN`, `CLAUDE_*_AGENT_ID`, `CLAUDE_*_ENVIRONMENT_ID`
  (entfernt aus config.ts und .env.example)

### Was extrahiert wurde

Die Kernlogik (Whitelists, Red-Lines, Space-Scoping, EntityRef-Publish)
ist in `odooCore.ts` und `confluenceCore.ts` gewandert. Das sind
**Single-Source-of-Truth**-Module: sowohl die früheren HTTP-Proxy-Routes
als auch die heutigen Toolkits hängen dran. Falls HTTP-Proxies mal wieder
gebraucht werden (externe Consumer), reimplementierbar als dünne Wrapper.

### Skill-Integration

Die Skills (`skills/<name>/SKILL.md`) waren für die Managed-Agent-Runtime
geschrieben (Bash/curl/$env-Variablen). Statt alle drei zu rewriten, wird
der **Runtime-Override** beim Sub-Agent-Bootstrapping (in `index.ts`,
Funktion `buildSubAgentSystemPrompt`) vorangestellt: der Sub-Agent wird
explizit instruiert, die HTTP/curl-Abschnitte zu ignorieren und direkt die
Tools zu nutzen. Funktionierte on first try.

---

## 5. Memory-System

### Zwei Memory-Typen

1. **Orchestrator-Memory** — das Anthropic-eigene `memory_20250818`-Tool.
   Der Orchestrator nutzt ein **virtuelles `/memories`-Verzeichnis**,
   dessen Inhalt physisch auf der Middleware liegt (nicht bei Anthropic).
2. **Session-Transkript** — vom `SessionLogger` geschrieben, *nicht* vom
   Modell. Jeder abgeschlossene Turn wird an eine tagesweise `.md`-Datei
   unter `/memories/sessions/<scope>/YYYY-MM-DD.md` angehängt.

### MemoryStore als Port

```ts
interface MemoryStore {
  list / fileExists / directoryExists / readFile /
  createFile / writeFile / delete / rename
}
```

Heute: `FilesystemMemoryStore` (Pfad-Traversal-Schutz, Null-Byte-Schutz,
URL-encoded-`..`-Schutz). Austauschbar gegen Postgres/S3 ohne
Call-Site-Änderung. Diese Abstraktion kostet fast nichts und macht
spätere Migrationen trivial.

### Namespace-Konventionen (im Orchestrator-System-Prompt festgeschrieben)

- `/memories/_rules/` — **Gepflegte Regeln aus dem Repo.** Wird beim
  Startup aus `middleware/seed/memory/_rules/` kopiert. Modus `missing`
  bedeutet: neue Files werden angelegt, existierende nicht überschrieben
  (Runtime-Edits bleiben). Modus `overwrite` würde pinning erzwingen.
  Der Orchestrator-Prompt sagt: nur mit expliziter User-Bestätigung
  ändern.
- `/memories/customers/<name>.md` — stabile Fakten pro Kunde.
- `/memories/observations/YYYY-QX.md` — Zeitstempelbezogen.
- `/memories/sessions/<scope>/YYYY-MM-DD.md` — Transkripte, *geschrieben
  von der Middleware*, nicht vom Modell. Modell soll bei Rückbezug
  reinlesen, nicht standardmäßig.

### Session-Transkript-Format

Jeder Turn-Block:
```md
### HH:MM:SS.mmmZ

**User:**

<user-message>

**Assistant:**

<assistant-answer-as-markdown>

*Telemetrie: tools=N, iterations=N*

<!-- entities: [{"s":"odoo","m":"hr.employee","id":42,"n":"Müller"}, …] -->

---
```

Die Millisekunden-Präzision im Heading ist **kritisch** — ohne sie
kollidieren back-to-back-Turn-IDs bei der Graph-Ingestion.
`sessionTranscriptParser.ts` nutzt dieses Format rückwärts. Jede Änderung
am Renderer in `sessionLogger.ts` muss im Parser gespiegelt werden, sonst
verschluckt der Backfill stumm.

---

## 6. EntityRef-System (Turn-Korrelation)

### Problem, das gelöst wird

Wenn der Sub-Agent `odoo_execute` auf `hr.employee` mit `search_read`
aufruft, liefert Odoo Records mit IDs. Diese IDs gehen normalerweise
verloren, sobald der Agent eine Prose-Zusammenfassung zurückgibt. Für
den Knowledge-Graph brauchen wir die strukturierten IDs aber permanent.

### Pipeline

1. **Publish:** In `odooCore.executeOdoo` (bzw. `confluenceCore.*`) wird
   nach erfolgreichem Call `extractOdooEntityRefs(...)` gelaufen, und
   jede gefundene Ref wird auf `entityRefBus.publish(ref)` gesetzt.
2. **Tagging:** `bus.publish` liest `turnContext.current()` und emittiert
   `{ ref, turnId }`.
3. **Collect:** Der Orchestrator ruft `bus.beginCollection(turnId)` am
   Turn-Start — der resultierende Listener filtert hart auf genau dieses
   Turn-Id.
4. **Drain:** Am Turn-Ende (oder im `finally`) `collection.drain()`, und
   die Refs fließen in `sessionLogger.log({ ..., entityRefs })`.
5. **Persistieren:** Der SessionLogger hängt die Refs als HTML-Kommentar
   ans Markdown **und** feedet sie in `knowledgeGraph.ingestTurn`.

### TurnContext via AsyncLocalStorage

- **Datei:** `services/turnContext.ts`
- **Warum ALS:** die Alternative wäre, turnId durch alle Funktions-
  signaturen zu schleifen — unzumutbar bei 4–5 Hops.
- **`run(turnId, fn)`** — für `orchestrator.chat()` (normale async fn).
- **`enter(turnId)`** — für `orchestrator.chatStream()`. ALS.run ist
  inkompatibel mit Async-Generators (kann nicht um `yield` herum), daher
  `enterWith`. Scope endet mit dem HTTP-Request-Resource-Lifecycle.
- **Filter per turnId** schützt gegen Cross-Contamination bei parallelen
  Teams-Konversationen.

### Entity-Extraktoren

- **Odoo** (`odooEntityExtractor.ts`):
  - `search_read` / `read` → Record-Array mit `{id, name, display_name?}`
  - `search` → ID-Array
  - `search_count` / `read_group` / `fields_get` → []
- **Confluence** (`confluenceEntityExtractor.ts`):
  - `getPage` / `getPageByTitle` → single page with `{id, title}`
  - `search` / `getChildren` → `{ results: [...] }` mit optionalem
    `content`-Wrapper pro Eintrag

---

## 7. Knowledge Graph

### Aktueller Stand

`InMemoryKnowledgeGraph` in `services/inMemoryKnowledgeGraph.ts`. Lebt
im Prozess, verlorenbei Restart. **Disk bleibt Source-of-Truth** — der
Backfill beim Startup restored den Graph aus `/memories/sessions/**.md`.

### Schema

- **Node-Typen:** `Session`, `Turn`, `OdooEntity`, `ConfluencePage`.
- **Edge-Typen:** `IN_SESSION` (Turn → Session), `NEXT_TURN`
  (chronologische Chain pro Session), `CAPTURED` (Turn → Entity).
- **Node-IDs (stabil, deterministisch):**
  - `session:${scope}`
  - `turn:${scope}:${isoTimestamp}` — Millisekunden-Präzision nötig
  - `${system}:${model}:${externalId}` für Entities

### Ingest-Pfad

`SessionLogger.log()` schreibt zuerst Markdown, dann ruft
`graph.ingestTurn(...)`. Fehler beim Graph-Ingest sind geswallowed, damit
das Transkript auf Disk immer konsistent bleibt. Fehler beim Markdown-
Write unterdrücken den Graph-Ingest (keine halb-konsistenten Zustände).

### Backfill

`graphBackfill.ts`: walkt alle `<scope>/*.md`, parst jeden Turn-Block mit
`sessionTranscriptParser.ts`, ruft `graph.ingestTurn()` pro Turn. Wird in
`index.ts` direkt nach Graph-Erzeugung aufgerufen, bevor der HTTP-Server
startet. Logged `scopes=N files=N turns=N skipped=N`.

### Dev-Query-API (nur lokal)

- `GET /api/dev/graph/stats`
- `GET /api/dev/graph/sessions`
- `GET /api/dev/graph/session/:scope`
- `GET /api/dev/graph/neighbors?nodeId=...`

Alle hinter `DEV_ENDPOINTS_ENABLED=true`. Admin-geschützte Variante für
Prod wäre machbar, aktuell nicht nötig.

### Agent-Query-Tool

`query_knowledge_graph` (in `tools/knowledgeGraphTool.ts`). Query-Typen:
- `stats`
- `list_sessions` (most-recent first, `limit` param)
- `find_entity` (`name_contains`, `model`, `limit`)
- `session_summary` (`scope`)

Wird vom Orchestrator aufgerufen, wenn der User auf prior art verweist.
End-to-End verifiziert: der Orchestrator nutzt das Tool von selbst, ohne
dass man ihn zwingt.

---

## 8. Skills

### Was ein Skill ist

Ein Ordner `skills/<name>/` mit einer `SKILL.md`. Frontmatter enthält
`name` + `description`. Body ist Prose, wird als System-Prompt des
Sub-Agents geladen (mit Runtime-Override-Preamble davor).

### Aktuelle Skills

- `odoo-accounting/SKILL.md` — Rechnungen, Zahlungen, offene Posten,
  Kontenplan. Allowed Models: `account.move`, `account.move.line`,
  `account.payment`, `res.partner`, `account.account`, `account.journal`,
  `res.currency`.
- `odoo-hr/SKILL.md` — Mitarbeiter, Abteilungen, Verträge, Urlaub,
  Anwesenheit, Bewerbungen. Hard Red Lines (server-side enforced) in
  `odooCore.HR_RED_LINE_FIELDS` + `HR_CONTRACT_BLOCKED_ALWAYS`: wages,
  tax IDs, bank accounts, private addresses, private contact data,
  emergency contacts.
- `confluence-playbook/SKILL.md` — Lesezugriff auf Space HOME, CQL-
  basierte Suche, Seiten-Lookup. Kein Odoo-Overlap.

### Wichtig

Die Skills wurden **nicht umgeschrieben** nach der Managed→Lokal-
Migration. Statt dessen überschreibt der Preamble in
`index.ts:buildSubAgentSystemPrompt()` die HTTP/curl-Anweisungen:

> Ignoriere alle Abschnitte des Skills, die `curl`, `$odoo_proxy_*`-Env-
> Variablen oder Bash-Snippets referenzieren — diese beschreiben die
> alte Managed-Agent-Laufzeit.

Funktioniert in der Praxis. Falls ein Sub-Agent dennoch curl-Muster
produziert, Skill selbst anpassen.

---

## 9. Tests (63 Stück, alle grün)

### Infrastruktur

Node's eingebauter Test-Runner + `tsx` als TS-Loader. Kein Vitest, kein
Jest.

```bash
npm test         # alles
npm run smoke:entity-refs   # E2E-Smoke ohne externe Creds
```

### Test-Dateien unter `middleware/test/`

- `odooEntityExtractor.test.ts` — Record/Array-Varianten, Edge-Cases
- `confluenceEntityExtractor.test.ts` — Single + search-list + malformed
- `turnContext.test.ts` — ALS-Propagation, Concurrent-Isolation
- `entityRefBus.test.ts` — Turn-Filter, Isolation, Drain-Idempotence
- `odooCore.test.ts` — Whitelist, Red-Line-Blocks, Red-Line-Strip
- `skillLoader.test.ts` — Frontmatter-Parsing
- `inMemoryKnowledgeGraph.test.ts` — Ingest, Chain, Upsert, Neighbors
- `sessionLoggerGraph.test.ts` — Integration zwischen Logger und Graph
- `sessionTranscriptParser.test.ts` — Round-Trip mit Renderer
- `graphBackfill.test.ts` — End-to-End: Live-Log → Markdown → Rebuild
- `devGraphRouter.test.ts` — Express-Integration mit Fetch
- `knowledgeGraphTool.test.ts` — Tool-Queries

### Was **nicht** abgedeckt ist

- `LocalSubAgent.ask` (Tool-Loop) — würde Anthropic-Mock brauchen
- `Orchestrator.chat/chatStream` — selbes Thema
- `OdooClient` (JSON-RPC + Auth) — würde HTTP-Mock oder Vitest brauchen
- `ConfluenceClient` — selbes
- Teams-Route — botbuilder-Mock

Diese fehlen bewusst; Mocks für die SDKs wären der Aufwand-Peak. Sobald
echte Regressions-Bugs auftauchen, gezielt nachrüsten.

---

## 10. Konfiguration

### `middleware/config.ts` — alle Env-Variablen mit zod-Schema

```
# Required
ANTHROPIC_API_KEY
# Core
ORCHESTRATOR_MODEL=claude-opus-4-7
ORCHESTRATOR_MAX_TOKENS=4096
MAX_TOOL_ITERATIONS=12
# Sub-agents
SUB_AGENT_MODEL=claude-opus-4-7     # kann auf haiku/sonnet runter
SUB_AGENT_MAX_TOKENS=4096
SUB_AGENT_MAX_ITERATIONS=16
SKILLS_DIR=../skills                # relativ zum middleware root
# Memory
MEMORY_DIR=./.memory
MEMORY_SEED_DIR=./seed/memory
MEMORY_SEED_MODE=missing            # missing | overwrite | skip
# Odoo
ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY
ODOO_PROXY_MAX_BYTES=500000
ODOO_INSECURE_TLS=false             # true nur lokal bei Private-CA
# Confluence
CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_BASE_URL
CONFLUENCE_SPACE_KEY=HOME
CONFLUENCE_PROXY_MAX_BYTES=200000
# Optional endpoints
ADMIN_TOKEN                         # mount /api/admin (mutating memory)
DEV_ENDPOINTS_ENABLED=false         # mount /api/dev/* (unauth!)# Teams
MICROSOFT_APP_ID, MICROSOFT_APP_PASSWORD, MICROSOFT_APP_TYPE=MultiTenant,
MICROSOFT_APP_TENANT_ID
# Diagram rendering (alle 7 müssen gesetzt sein, sonst wird Feature deaktiviert)
KROKI_BASE_URL=http://localhost:8765       # Kroki-Gateway (lokal aus compose.yml)
DIAGRAM_URL_SECRET                         # openssl rand -hex 32 — pro Env frisch
DIAGRAM_PUBLIC_BASE_URL=http://localhost:3979  # Base-URL für signierte URLs
DIAGRAM_SIGNED_URL_TTL_SEC=900             # 15 min
DIAGRAM_MAX_SOURCE_BYTES=64000             # Quellcode-Cap
DIAGRAM_MAX_PNG_BYTES=900000               # <1 MB Teams-Limit
# Object-storage (Tigris auf Fly, MinIO lokal — auto-provisioniert via `fly storage create`)
BUCKET_NAME, AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# Tenant-Scope (auch für Diagramm-Cache-Keys genutzt)
GRAPH_TENANT_ID=byte5
# Runtime
PORT=3979
```

`.env.example` ist gepflegt. Leere Strings parsed zod als `""`, nicht
`undefined` — daher muss der Fallback `||` sein, nicht `??`.

### Wichtige Gotchas

1. **`??` vs `||`** bei Env-Fallbacks — haben wir einmal gefangen, steht
   als Kommentar im Code. Zod macht leere `.env`-Werte zu leeren
   Strings, nicht zu `undefined`.
2. **tsx statt ts-node** für `npm run dev`. ts-node + ESM + NodeNext ist
   kaputt in aktueller Node-Version.
3. **`req.on('close')` feuert zu früh** in Express 5 (nach Body-Read,
   nicht nach Socket-Close). Auf `res.on('close')` mit
   `writableEnded`-Check wechseln. Siehe `routes/chat.ts`.
4. **`ODOO_INSECURE_TLS` ist scoped**: nur der `OdooClient` nutzt einen
   undici-Agent mit `rejectUnauthorized: false`. Global
   `NODE_TLS_REJECT_UNAUTHORIZED=0` **nicht** setzen — kompromittiert
   auch Anthropic-Verbindung.

---

## 11. Stream-Protokoll (`POST /api/chat/stream`)

NDJSON — eine vollständige JSON-Zeile pro Event. Event-Typen:

```ts
type ChatStreamEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; durationMs: number; isError?: boolean }
  | { type: 'done'; answer: string; toolCalls: number; iterations: number }
  | { type: 'error'; message: string }
```

Genau ein `done` oder `error` schließt den Stream. Header:
`Content-Type: application/x-ndjson; charset=utf-8`, `X-Accel-Buffering: no`
(nginx-buffer-off).

`orchestrator.chatStream` ist ein Async-Generator. Text-Deltas stammen
aus `anthropic.messages.stream` (nicht `.create`). Tool-Use-Deltas werden
nicht weitergeleitet — stattdessen emittiert das `tool_use`-Event einmal
den vollen Input, sobald der Content-Block schließt.

---

## 12. Red-Line-Enforcement (HR)

**Defense in depth** — Skill sagt es, Core erzwingt es.

- `odooCore.HR_RED_LINE_FIELDS` — globaler Blacklist (auch wage, ssnid,
  bank_account_id, private_*, emergency_*, …).
- `odooCore.HR_CONTRACT_BLOCKED_ALWAYS` — zusätzlich für `hr.contract`
  (wage, hourly_wage, struct_id).
- **Request-Check:** `findRedLineFieldViolation` in kwargs.fields, inkl.
  dotted sub-selectors (`contract_id.wage`).
- **Response-Strip:** `stripRedLineFields` rekursiv — selbst wenn ein
  Feld nicht angefordert wurde (Odoo returned manchmal Defaults), geht
  es nicht raus.

Ein Request mit Red-Line-Feld wird server-side mit 403-equivalent
abgelehnt (Sub-Agent kriegt `Error: hr_red_line_field — field \`wage\``
— lesbar für das LLM, damit es alternative Strategien finden kann).

---

## 13. Offene Roadmap

### Phase 5 — Business-Entity-Sync (nächster sinnvoller Task)

Aktuell landen Entities nur im Graph, wenn sie in einem Turn auftauchen.
Für proaktive Cross-Domain-Queries fehlen stabile Stammdaten.

**Scope:**
- `services/odooSync.ts` — periodischer Scan (setInterval mit Jitter)
  für `hr.employee` (ohne Red-Lines), `hr.department`, `res.partner`,
  `account.journal`, ggf. `project.project`
- `services/confluenceSync.ts` — Space-Crawl der Top-Level-Seiten +
  Ancestors-Graph
- Neue Edge-Typen: `BELONGS_TO` (employee → department), `RELATED_TO`
  (page → page via parent)
- `knowledgeGraphTool` erweitern um `traverse` / `path` Queries

### Phase 7 — Graph-Persistenz (optional, wenn Restarts oft)

In-Memory funktioniert solange Backfill aus Disk schnell bleibt (aktuell
<1s für 15 Turns). Ab ~10k Turns wird das nerven. Optionen:

- **Kùzu embedded** — Single-File Graph-DB, Node-Binding, Cypher-ähnlich,
  passt zu Fly-Volumes. Kein Sidecar.
- **FalkorDB** — Redis-basiert, separater Fly-Container. Wenn Graphiti
  irgendwann kommt.
- **Graphiti-Sidecar (Python)** — wenn LLM-basierte Entity-Extraction
  gewollt. Temporal-Graph-Modell, aber zusätzlicher Service.

Interface (`KnowledgeGraph`) ist bereits so geschnitten, dass ein
Swap-Out trivial ist. `InMemoryKnowledgeGraph` implementiert es, jede
Alternative muss dieselben Methoden erfüllen.

### Phase 8 — Eval-Harness

Ziel: Regression-Schutz für Agent-Qualität (nicht nur Code). Fixe
Test-Prompts, Golden-Antworten pro Domain, Diff-Report. Könnte als
`scripts/eval.ts` starten. Ohne das kann man kein Skill-Tuning
verteidigen.

### Phase 9 — Proper Auth für Dev-Endpoints

Aktuell sind `/api/dev/*` unauth'd hinter einer Flag. Sobald die
Middleware außerhalb localhost gehostet wird, muss mindestens ein
`DEV_TOKEN` ran. Der Memory-Admin-Router hat schon Constant-Time-Compare,
Pattern vorhanden.

### Phase 10 — Ollama-basierte Entity-Extraction aus Prose

Aktuell erfassen wir nur IDs aus Tool-Responses. "Wie geht's Müller?"
ohne Tool-Call hat keine ID → keine Graph-Verknüpfung. Lösung: nach
jedem Turn ein lokales LLM (Ollama) den Assistant-Answer parsen lassen
auf Entity-Mentions und gegen den bestehenden Graph matchen. Low-
confidence-Kanten mit Flag speichern, UI zeigt sie anders an.

### Phase 11 — Diagramm-Rendering auf Fly deployen

Feature ist lokal fertig (2026-04-19, siehe CHANGELOG für Architektur-Zusammenfassung). Offen:

1. Zwei Fly-Apps `odoo-bot-kroki` + `odoo-bot-kroki-mermaid` mit flycast-only Services (keine öffentlichen IPs). Dockerfile/fly-toml vorbereiten, z.B. unter `kroki/`.
2. Tigris-Bucket über `fly storage create -a odoo-bot-middleware`, dann einmalig `PutBucketLifecycleConfigurationCommand` mit 90-Tage-Expiration.
3. Fly-Secrets setzen: `DIAGRAM_URL_SECRET`, `KROKI_BASE_URL=http://odoo-bot-kroki.flycast:8000`, `DIAGRAM_PUBLIC_BASE_URL=https://odoo-bot-middleware.fly.dev`.
4. Smoke-Probe in Teams: "Flow A→B→C als Mermaid" → Card mit PNG.

Lokale Reproduktion jederzeit via `docker compose up -d` + `npm run smoke:diagrams`.

### Phase 12 — tenantId im TurnContext

Diagramm-Cache-Keys nutzen aktuell `config.GRAPH_TENANT_ID` (statisch `byte5`).
Sobald wir mehrere Teams-Tenants bedienen, muss `tenantId` aus der Teams-Activity
in `TurnContextValue` fließen — analog `turnId`. `DiagramService` liest dann
`turnContext.currentTenantId()` statt `config.GRAPH_TENANT_ID`.

---

## 14. Commands (vom `middleware/`-Dir aus)

```bash
npm install                   # einmalig
npm run dev                   # tsx watch src/index.ts
npm run typecheck             # tsc --noEmit
npm run lint                  # eslint src/
npm run lint:fix              # eslint --fix
npm run format                # prettier --write
npm test                      # Node --test mit tsx-Loader, 63 Tests
npm run smoke:entity-refs     # E2E-Smoke für EntityRef-Capture-Pfad
```

**Nicht aufrufen:** `npm run build` — Repo-Konvention sagt
"dev-only, typecheck + lint reichen".

### Aktuell laufende Background-Tasks

- `bmp0cq4cz` — Middleware-Dev (`tsx watch src/index.ts`)
- `b837rubug` — Next.js-Dev-UI

Beide überleben den Session-Clear nicht automatisch. Bei neuem Chat ggf.
neu starten.

---

## 15. Git-Status (Repo ist **keine** Git-Repo!)

`/Users/johndoe/sources/odoo-bot/` ist laut CLAUDE-Env-Info **kein
Git-Repository**. Keine Commits, kein Branch-Management nötig. Änderungen
werden direkt auf Files gemacht. Das ist bewusst und für die gesamte
Session so — nicht versuchen zu committen.

---

## 16. Fly-Deployment (aktuell nicht primär)

Middleware liegt als `fly.toml` und `Dockerfile` vor. Eine Fly-App
`odoo-bot-middleware` existiert in Prod und läuft mit leicht anderer
Config (Managed Agents nutzend — veraltet, sollte irgendwann auf lokale
Sub-Agents umgestellt werden). Lokaler Stand ist der **neuere**. Ein
Sync auf Fly würde:

- `ODOO_INSECURE_TLS=false` setzen (Fly-CA-Store kennt das Cert)
- `DEV_ENDPOINTS_ENABLED=false` lassen (Prod-Schutz)
- `SKILLS_DIR` auf Container-Pfad setzen
- Ggf. `SUB_AGENT_MODEL=claude-sonnet-4-6` für Kosten

Solange du primär lokal entwickelst, Fly nicht anfassen.

---

## 17. Für den ersten Prompt im neuen Chat

Gute Einstiegs-Prompts, geordnet nach erwartetem Gewinn:

**Klein & konkret:**
- "Schau dir `services/localSubAgent.ts` an und schreib einen Mock-SDK-
  Test, der den Tool-Loop auf Happy-Path + Error-Path abdeckt."
- "Füge dem `knowledgeGraphTool` einen Query-Typ `entity_neighbors` hinzu,
  der alle Turns + benachbarten Entities eines Entity-IDs zurückgibt."
- "Das HR-Skill hat im 'Query Pattern'-Abschnitt noch bash/curl-Beispiele.
  Schreib den Abschnitt so um, dass er das `odoo_execute`-Tool direkt
  referenziert statt HTTP."

**Mittel:**
- "Beginn Phase 5: implementier `services/odooSync.ts`, das alle 30min
  `hr.employee` und `hr.department` in den Graph syncet. Füge einen
  Test dazu und verdrahte in `index.ts`."
- "Baue ein `scripts/eval.ts`, das eine Liste fixer Prompts gegen die
  laufende Middleware fährt und Antworten + Tool-Counts + Dauer
  protokolliert. Erstmal nur aufzeichnen, kein Diff noch."

**Groß:**
- "Evaluiere, ob wir `InMemoryKnowledgeGraph` auf Kùzu-embedded migrieren
  sollten. Schau die aktuelle Interface-Surface in `knowledgeGraph.ts`
  an, recherchier den Kùzu-Node-Client, schreib einen Prototyp-Adapter.
  Tests sollen identisch grün bleiben."

### Grundsätzliche Arbeitsweise

- User ist Senior-Dev, architektur-first, knappe Tech-Sprache bevorzugt.
- Tools vor Prosa: `lint:fix` + `typecheck` + `test` nach jeder Änderung.
- Keine Auto-Deploys, keine Fly-Kommandos ohne explizite Ansage.
- Memory-System ist Projekt-kritisch — Änderungen am Session-Transkript-
  Format brauchen Parser-Update im selben Commit.
- Red-Lines sind heilig — nie abschwächen, nur durch explizite User-
  Entscheidung.

### Wenn du unsicher bist

- `.env.example` ist aktuell, liest sich wie Spec.
- `package.json`-Scripts zeigen alles was supported ist.
- Alle 63 Tests in einem Lauf geben eine schnelle "funktioniert noch
  alles"-Antwort.
- Die Dev-UI unter `http://localhost:3000` ist der schnellste Weg, Agent-
  Verhalten interaktiv zu testen — sie streamt Tool-Calls live.
