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

### Plugin-Tool-Readiness-Gate (#474)

`Orchestrator.isToolAvailable(agentId)` entscheidet pro Tool, ob es dem
Modell angeboten und bei Dispatch ausgeführt wird. Ohne `agentId`
(kernel-interne Registrierungen wie `render_diagram`) oder ohne
verdrahtetes `isPluginToolsReady` (Legacy-Hosts, Unit-Tests) bleibt das
Verhalten exakt wie vor #474 — immer verfügbar. Konsultiert an jeder Stelle,
die ein Tool-Name→Handler-Mapping liest: `buildToolsList()` (Tool-Specs,
inkl. des Anthropic-`memory`-Fast-Path, falls ein Plugin ihn via
`ctx.tools.registerHandler('memory', …)` registriert hat),
`dispatchToolInner()` (derselbe Fast-Path plus die generischen
`NativeToolRegistry`- und `DomainTool`-Handler), `getSystemPrompt()`
(promptDoc-Splice + Fach-Agenten-Roster — ein gegatetes Tool taucht weder in
den Specs noch in Doku/Roster auf), `directLineObligationState()` (#332
Forced-`tool_choice`) und `executeDirectLine()` (`#token`-Kandidatenauflösung,
degradiert auf die bestehende "Specialist … is no longer available."-Notiz
statt den internen Dispatch-Fehler zu zeigen). Die parallele
`ToolDispatchService` (Subscription-CLI-Bridge) trägt dieselbe Gate-Logik
unabhängig nach, da sie ohne Orchestrator-Instanz läuft.

Zwei unabhängige Readiness-Signale werden UND-verknüpft (jedes kann
Verfügbarkeit allein verweigern) — bewusst zwei getrennte Caches statt einem
gemergten, damit keins das Urteil des anderen stillschweigend überschreiben
kann:

- **`PluginStatusRegistry`** (`middleware/src/platform/pluginStatusRegistry.ts`)
  — explizit, vom Plugin selbst via
  `ctx.status.report({state:'needs_action'|'error'})` gesetzt.
- **`OAuthReadinessTracker`** (`middleware/src/plugins/oauth/oauthReadinessTracker.ts`)
  — automatisch, aus demselben Vault-Token-State abgeleitet, den
  `ctx.oauthTokens` liest; refreshed bei jedem
  `ToolPluginRuntime`/`DynamicAgentRuntime.activate()` (Install,
  Boot-Reaktivierung, Post-Connect). Deckt den Fall, dass
  `installService.ts` ein `type:'oauth'`-Plugin schon beim `configure()`
  aktiviert — bevor der Operator "Connect" geklickt hat —, ohne dass der
  Plugin-Autor dafür einen eigenen `status.report()`-Call schreiben muss.

Beide werden am Boot hinter dem Service-Registry-Key
`installedPluginToolsReadyReader` (`middleware/src/index.ts`)
veröffentlicht und von `harness-orchestrator/src/plugin.ts` als
`OrchestratorOptions.isPluginToolsReady` verdrahtet. Bewusst getrennt von
der MCP-Server-spezifischen Auth-Lücke (`mcpOAuthService`), die für
MCP-Server bereits existiert — dieses Gate deckt nur native
Plugin-Tool-Registrierungen ab.

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

### Channel → Orchestrator-Dispatch (per-Channel, Omadia UI)

Ein Channel-Turn erreicht den Orchestrator über den **`orchestratorDispatcher`**
(`TurnDispatcher` in `src/channels/coreApi.ts`, verdrahtet in `index.ts`).
`CoreApi.handleTurnStream(turn)` reicht `channelId` durch; der Dispatcher löst
**pro Turn lazy** den Ziel-Service aus der Service-Registry auf:

```
dispatchService = pluginCatalog.get(channelId)?.plugin.channel?.dispatch_service ?? 'chatAgent'
agent           = serviceRegistry.get<ChatAgentBundle>(dispatchService)?.agent
```

`resolveDispatchService` (`src/channels/dispatchService.ts`) kapselt den
Fallback. **Klassische Channels deklarieren kein `channel.dispatch_service`** und
landen unverändert bei `'chatAgent'`. Omadia UI setzt im Channel-Manifest
`dispatch_service: canvasChatAgent` (**bare Key, kein `@N`** — die Registry
strippt keine Versionen) und routet so seine Turns an den
`omadia-ui-orchestrator` (publiziert `canvasChatAgent@1`, runtime-Key
`canvasChatAgent`). Annahme: `IncomingTurn.channelId` == Plugin-Catalog-Id des
Channels; trifft das nicht zu, greift sicher der `'chatAgent'`-Default.
Zusätzliches additives Manifest-Feld: `channel.canvas_protocol_version`
(informativ; die echte Version wird im Boot-Handshake verhandelt).

### Canvas-Sentinels (Omadia UI, PR-7a)

Canvas-aware Tier-3-Tools (und der Canvas-Client für `_pendingMutation`)
emittieren strukturierte Payloads als **In-Band-JSON-Sentinels** im Tool-Result-
String — dasselbe Muster wie `_pendingUserChoice` / `_pendingRoutineList`
(`parseToolEmittedChoice` in `orchestrator.ts`). Neu in
`harness-orchestrator/src/canvasSentinels.ts`: die reinen Parser
`parseToolEmitted{StructuredPayload,CanvasTree,Mutation}` plus der
**`canvas-output`-Gate** (`isCanvasOutputAuthorized`, **deny-by-default**) —
ein Tool-Sentinel wird nur akzeptiert, wenn das Plugin die `canvas-output`-
Capability deklariert. Parser sind tolerant (malformed JSON / Shape-Mismatch →
`undefined`). **Noch nicht** in den Tool-Loop verdrahtet: das Enforcement plus
das beim Boot aus dem `pluginCatalog` berechnete Allow-Set (welche Tools
`canvas-output` führen) kommt mit dem Canvas-Orchestrator (PR-9), zusammen mit
den Tools, die diese Sentinels überhaupt erst erzeugen. Bis dahin emittiert
niemand sie — Wiring jetzt wäre spekulativ.
### Write-Capabilities + `structured?`-Tool-Output (Omadia UI, PR-8)

`plugin-api` additiv: `LocalSubAgentToolResult.structured?`
(`StructuredToolOutput` — die **getypte Alternative** zum
`_pendingStructuredPayload`-Sentinel-im-String) und der `WriteCapability`-
Vertrag (ein Tool deklariert pro `dataClass`/`operation`, was es mutieren darf).
**Wichtig:** `writeCapabilities` ist **kein** Feld auf `NativeToolSpec` — der
Spec geht via `buildToolsList` verbatim in die Anthropic-Tool-Liste, und
Anthropic lehnt unbekannte Felder ab (gleicher Grund, warum `piiFields` am
LocalSubAgentTool-**Wrapper** hängt, nicht am Spec). Der Anbindungspunkt
(Manifest-Annotation / Registration-Metadata, non-model-facing) wird mit dem
ersten Consumer (PR-9) verdrahtet. `deriveMutabilityCapabilities(caps, dataClass)` in
`plugin-api/src/writeCapabilities.ts` leitet daraus **deterministisch** (kein
LLM-Call) `editable` / `canAddItems` / `canRemoveItems` / `canReorder` ab:
`update`→editierbare Felder, `create`→`canAddItems` + Required-Fields,
`delete`→`canRemoveItems`, `reorder`→`canReorder`. **Fehlende Annotation ⇒
read-only** (strenger Default gegen Rollback-Hölle). Noch **nicht** verdrahtet:
Manifest-Loader-Parsing von `writeCapabilities` + System-Prompt-Emission +
das Threading von `structured` durch `localSubAgent.ts` kommen mit dem
Canvas-Orchestrator (PR-9, erster Consumer).

### omadia-ui-orchestrator (Tier-2, Skeleton, PR-9a)

Neues Plugin-Package `packages/omadia-ui-orchestrator/` (`@omadia/ui-orchestrator`,
`kind: extension`) — wird vom `builtInPackageStore` automatisch entdeckt (jeder
`packages/*`-Ordner mit gültiger `manifest.yaml`), **kein Boot-Edit nötig**. Es
publiziert `canvasChatAgent@1` (runtime bare-key `canvasChatAgent`) — den
Service, an den ein Canvas-Channel via `channel.dispatch_service` (PR-6)
dispatcht. **v0 ist ein dünnes Delegations-Skeleton:** `canvasChatAgent` leitet
`chat`/`chatStream` an den Basis-`chatAgent` weiter (pro Call lazy aufgelöst),
schließt damit die End-to-End-Plumbing, synthetisiert aber **noch keine
Canvas-Surface**. `requires: chatAgent@^1` (nur Ordering; ohne Basis hält das
Plugin zurück und degradiert sauber). CCM ist **kein** hartes `requires`. Die
echte Canvas-Arbeit — UI Skill (Kompositions-Idiom-Bibliothek), `surface_*`-
Synthese, per-`canvasSessionId`-Mutex, Cache — plus die aufgeschobenen Wirings
(PR-7b Sentinel-Gating, `writeCapabilities`-Anbindung, `structured`-Threading)
sind Folge-Slices. **Surface-Synthese aufgelöst durch PR-9b-1 (unten).**

### Tier-2 Surface-Synthese (Omadia UI, PR-9b-1)

Macht `canvasChatAgent` zum echten Stream-Transformer — **ohne den geteilten
Base-Orchestrator-Tool-Loop anzufassen**. Für einen **Canvas-Turn** (einen, der
`input.canvasSessionId` trägt) wickelt `canvasChatAgent` den `base.chatStream`-
Event-Stream in `synthesizeSurfaceEvents` (`packages/omadia-ui-orchestrator/src/
surfaceSynthesis.ts`): pro `tool_result` eines **autorisierten** Tools wird die
Ausgabe mit `parseToolEmittedCanvasTree` (#169) gescannt; bei einem
`_pendingCanvasTree`-Sentinel wird ein `surface_snapshot` synthetisiert und in
den Stream injiziert (per-Stream monotone `surfaceSeq` + Revision, gestempelt mit
`canvasSessionId`). Alle anderen Events passieren unverändert; Nicht-Canvas-Turns
und der `chat()`-Pfad gehen byte-genau durch.

- **Gate (deny-by-default):** nur Tools in `authorizedToolNames` werden gescannt.
  Das Set ist **heute leer** — die boot-berechnete canvas-output-Allow-Liste wird
  mit dem ersten Producer-Tool (PR-9b-2) verdrahtet; bis dahin ist der
  Synthesizer in Produktion korrekt inert (secure-by-construction). Der
  Gate-Mechanismus selbst ist live + getestet.
- **`canvasSessionId`-Threading** (2 geteilte Dateien, additiv): `ChatTurnInput`
  bekommt ein optionales `canvasSessionId`; der `orchestratorDispatcher` liest es
  aus den Turn-Metadaten (vom Canvas-Channel gesetzt, PR-10b) und reicht es in
  `chatStream` durch. Klassische Channels setzen es nie → unverändert.
- **Dependency:** `@omadia/orchestrator` als peerDep des ui-orchestrator (für die
  #169-Parser).

**Noch offen (spätere 9b-Slices):** der **Producer** (canvas-output-Tool / UI
Skill, das `_pendingCanvasTree` tatsächlich emittiert — bis dahin läuft die
Synthese nur in Tests) + das Allow-Set-Boot-Wiring (9b-2);
`_pendingStructuredPayload` → `surface_data_ref_created` (braucht DataRef-HMAC);
per-`canvasSessionId`-Mutex + cross-turn-`surfaceSeq`-Kontinuität + Cache (9b-3).

Test: `test/uiOrchestratorSurface.test.ts` treibt `synthesizeSurfaceEvents` mit
einem Fake-Base-Stream (autorisierter Sentinel → `surface_snapshot`; leeres
Allow-Set → nichts; kein Sentinel → nichts; Nicht-Tool-Events unverändert;
monotone `surfaceSeq`/Revision).

### Tier-2 Haiku-Komposition (Omadia UI, PR-9b-2)

Macht den `canvasChatAgent` zum echten Tier-2-Composer. Für einen Canvas-Turn
(`input.canvasSessionId` gesetzt) laufen drei Schritte; Nicht-Canvas-Turns und
`chat()` bleiben Byte-für-Byte-Passthrough (testbelegt, null LLM-Calls):

1. **Skeleton-first** (`src/composition.ts`): ein Fast-Tier-Call
   (`ctx.llm.complete`, Modell aus Setup-Feld `ui_orchestrator_model`, Default
   `claude-haiku-4-5`; Manifest-Gate `permissions.llm`) erzeugt
   `{ tree, dataRequirements }`. Der Tree wird **server-seitig gegen die
   Protokoll-Schemas validiert** (`src/treeValidator.ts`, Ajv 2020 über die
   nach `packages/omadia-ui-orchestrator/schema/` **vendorte** Kopie der
   omadia-ui-Spec 1.0); ein begrenzter Repair-Retry trägt die Validator-Fehler
   in den Prompt; danach deterministischer Fallback (`FALLBACK_SKELETON`) —
   die Komposition blockiert den Turn **nie** (auch ohne `ctx.llm`). Das
   Skeleton geht als `surface_snapshot` (Revision `"0"`) raus, **bevor** der
   langsame Hauptturn startet (~500ms-Ziel, implementation-plan Risiko #1;
   Spike-Gate: <95% First-Attempt-Validität → Modell auf Sonnet pinnen).
2. **Requirement-Handoff**: der delegierte Hauptturn bekommt die
   `dataRequirements` als `[canvas-context]`-Block an die `userMessage`
   angehängt (containerIds + exakte fieldKeys + Instruktion) — Tier-3
   Sub-Agents liefern ihre `_pendingStructuredPayload`s damit genau passend
   zu dem, was das Skeleton versprochen hat.
3. **Synthese-Fortsetzung** (`src/surfaceSynthesis.ts`, erweitert):
   `startSurfaceSeq`/`baseRevision`/`baseTree` setzen die Zähler **nach** dem
   Skeleton fort. Neu: `_pendingStructuredPayload` (autorisiertes Tool) wird
   **deterministisch, ohne LLM-Call** auf das Skeleton gemappt
   (`src/patchComposition.ts`): Rows gegen die `columns[].fieldKey`s der
   Skeleton-Tabelle, `surface_patch` in der in omadia-ui
   `docs/protocol/1.0.md` §5.1 gepinnten RFC-6902-Subset-Grammatik
   (`replace loading` + `add rows/-`), Post-Patch-Tree validiert.
   **Unmappbare Payloads werden übersprungen** (Daten kommen weiter als Prose
   an) — bewusste Slice-Entscheidung statt LLM-Rekompositions-Snapshot
   mid-stream.

**Allow-Set (Interim):** Setup-Feld `canvas_output_tools` (kommagetrennte
Tool-Namen) füllt das deny-by-default-Gate, bis das boot-berechnete
canvas-output-Capability-Wiring (PR-7b) landet. Leer → keine Synthese.

**Weiter offen (9b-3):** per-`canvasSessionId`-Mutex, cross-turn-`surfaceSeq`/
State-Persistenz (Re-Handshake-Snapshot-Replay), `surface_data_ref_created` +
DataRef-HMAC, `writeCapabilities`-Ableitung.

Test: `test/uiOrchestratorComposition.test.ts` — `composeSkeleton`
(Model-Pfad, Repair-Retry mit Validator-Fehlern, Fallback bei Non-JSON /
Invalid-Twice / fehlendem LLM), `composeStructuredPayloadPatch` (Mapping +
gepinnte Patch-Grammatik, `null` bei unmappbar), Plugin-Ebene (Skeleton ist
**erstes** Event, `[canvas-context]` am Hauptturn, Payload → `surface_patch`
`basedOnRevision "0"`, Nicht-Canvas-Turn → null LLM-Calls).

### omadia-ui-channel (Tier-1 Server, Skeleton, PR-10a)

Neues Channel-Plugin `packages/omadia-ui-channel/` (`@omadia/ui-channel`,
`kind: channel`). Das Manifest deklariert die Canvas-Surface —
`channel.capabilities: [text, canvas]` + `channel.dispatch_service:
canvasChatAgent` —, sodass ein Turn an den `omadia-ui-orchestrator` routet
(#168 + #171). **v0** registriert via `core.registerRoute` einen
Discovery-Endpoint (`GET /omadia-ui/info`), der Protokoll-/Catalog-Versionen +
Capabilities annonciert (was ein Client vor dem Connect liest).

**Wichtiger Befund / aufgeschoben:** Der eigentliche **bidirektionale
WebSocket-Transport** (Handshake `offer→select→ack`, `IncomingTurn`-Bildung,
`surface_*`-Event-Fan-out) fehlt — die **`CoreApi` bietet nur Express-Route/
Router-Registrierung, keinen WebSocket-Upgrade**. Um den Canvas-WebSocket zu
hosten, braucht es eine **CoreApi-SDK-Erweiterung** (WS-/`upgrade`-Registrierung
für Channel-Plugins), die in der Concept-„SDK changes"-Liste **fehlt** — als
Plan-Feed-back vermerkt, eigene Folge-PR. Die Dispatch-Verdrahtung
(`dispatch_service` → `canvasChatAgent`) ist bereits durch #168 validiert.
**Aufgelöst durch PR-11** (unten).

### Canvas WebSocket-Transport (Omadia UI, PR-11)

Schließt die in PR-10a benannte CoreApi-Lücke: additive WebSocket-Registrierung
für Channel-Plugins — das Gegenstück zu `registerRoute`, eine Ebene höher.

- **SDK** (`@omadia/channel-sdk`, additiv): `ChannelSocket` (transport-agnostisch,
  Text-Frames; **kein `ws`-Import im SDK**), `ChannelSocketHandler`,
  `ChannelSessionClaims` und die optionale Methode
  `CoreApi.registerWebSocket?(channelId, path, handler)`. Optional (`?`), damit
  bestehende Channels und Nicht-WS-`createCoreApi`-Wirings unberührt bleiben —
  Channels feature-detecten (`typeof core.registerWebSocket === 'function'`).
- **Kernel** `src/channels/webSocketRegistry.ts`: spiegelt `ExpressRouteRegistry`
  (per-Channel-`active`-Flag; `deactivateChannel` lehnt neue Upgrades ab **und**
  schließt Live-Sockets). Ein einzelner `ws.Server` im `noServer`-Modus;
  `attach(server)` hängt sich an `server.on('upgrade')`. Pfad-/Active-Match →
  Auth → `handleUpgrade`. **Single-Owner-Invariante:** die Registry ist der
  einzige `upgrade`-Consumer des Prozesses (heute kein anderer); unbekannter
  Pfad → `404` + `destroy`. Ein künftiger zweiter WS-Consumer müsste das zu
  einer Delegations-Kette machen statt unmatched Sockets zu zerstören.
- **Auth — vor dem Upgrade, nicht danach.** Der `upgrade`-Request trägt das
  Session-Cookie (`omadia_session`) in `req.headers.cookie`. Die Registry parst
  es selbst (beim rohen `upgrade` läuft **kein** `cookie-parser` davor) und ruft
  `verifySession(token, sessionSigningKey)` — **derselbe Key wie `requireAuth`**.
  Fehlt/ungültig → rohes `401` + `socket.destroy()` **vor** dem `101`; für einen
  unauthentifizierten Peer wird kein WebSocket allokiert. Nur authentifizierte
  Upgrades werden zu `ChannelSocket`s; die verifizierten `ChannelSessionClaims`
  (`subject`/`email`/`displayName`/`provider`/`omadiaUserId?`) gehen an den
  Handler. Zusätzlich der **gleiche Entra-Whitelist-Gate** wie `requireAuth`:
  eine OIDC-(`entra`)-Session mit nicht (mehr) whitelisteter E-Mail → `403`
  (Auth-Parität zu den HTTP-Routes; der `EmailWhitelist` wird mitinjiziert).
  (Hinweis: `CoreApi.resolveIdentity` ist channel-natives User-Mapping,
  **nicht** Session-Auth — daher direkt `verifySession`.)
- **Wiring** (`index.ts`): `new WebSocketRegistry({ signingKey: sessionSigningKey })`
  vor `createCoreApi({ … webSockets })` (≈2505), zusätzlich an die
  `DefaultChannelRegistry` gereicht (Lifecycle-Spiegel zu `routes`), und
  `attach(server)` nach `const server = app.listen(PORT, '::')` (≈2592) —
  dasselbe `http.Server`, der Dual-Stack-`::`-Bind serviert WS mit.
- **Dependency:** `ws` + `@types/ws` nur im Kernel, nicht im SDK.

Test: `test/webSocketRegistry.test.ts` fährt einen echten `http.Server` + echten
`ws`-Client (authentifizierter Upgrade → Claims + Echo-Frame; ohne Cookie →
`401`; unbekannter Pfad → `404`; deaktivierter Channel → `503`). Damit ist der
Transport bereit für **PR-10b** (echter Canvas-Channel: Handshake-`offer→select→
ack`, `IncomingTurn`-Bildung, `surface_*`-Fan-out).

### Canvas WebSocket-Channel (Omadia UI, PR-10b)

Macht aus dem `omadia-ui-channel`-Skeleton (PR-10a) den echten Transport, auf
PR-11s `CoreApi.registerWebSocket` aufsetzend. Drei neue Module im Package
`packages/omadia-ui-channel/src/`:

- **`protocol.ts`** — die Wire-Nachrichten des Channels:
  Server→Client `handshake_offer`/`handshake_error`/`handshake_ack` +
  die Turn-Lifecycle-Envelopes `agent_text_delta`/`turn_complete`/`turn_error`;
  Client→Server `handshake_select` + `turn`. Die `surface_*`-Events selbst
  werden **nicht** re-deklariert — sie sind `SurfaceStreamEvent` aus dem SDK und
  werden 1:1 weitergereicht. Plus ein toleranter `parseClientMessage`
  (Nicht-JSON / unbekannter `type` → verworfen).
- **`canvasConnection.ts`** — `handleCanvasSocket(socket, session, deps)`, die
  per-Verbindungs-State-Machine (DI-freundlich, ohne echten Socket testbar):
  1. **Handshake:** server-initiiertes `handshake_offer` beim Connect; auf
     `handshake_select` Versions-Match (Protokoll **und** Ops-Catalog) → mintet/
     übernimmt `canvasSessionId` und schickt `handshake_ack`; Mismatch →
     `handshake_error` (eine Downgrade-Chance, zweiter Mismatch → `close`).
  2. **Turn-Bildung:** je `turn`-Nachricht ein `IncomingTurn` —
     `channelId`, `userRef` (`kind: 'custom'`, `id = session.subject`), `text`,
     optional `target`/`viewState`/`viewStateTruncated`, `tenantId` aus
     `ctx.services.get('graphTenantId')` (sonst Core-Default `'default'`).
     **`conversationId = `${session.subject}::${canvasSessionId}``** — der
     Core-Scope ist `${channelId}::${conversationId}` und **nicht** user-gescopet,
     darum wird die client-gelieferte `canvasSessionId` unter dem
     authentifizierten Subject genamespacet (sonst Cross-User-Canvas-Zugriff,
     Codex-Blocker). Der rohe `canvasSessionId` bleibt in `metadata` + im Ack.
     `target`/`viewState` werden vor Dispatch leichtgewichtig shape-geprüft
     (Objekt + `target.kind` String) — Vollvalidierung der 10 TargetRef-Varianten
     ist Tier-2-Whitelist; malformed → `turn_error`, kein Dispatch.
  3. **Fan-out:** iteriert `core.handleTurnStream(turn)` und reicht `surface_*`
     **1:1** an den Client (gegen ein explizites Typ-Set, nicht per
     `surface_`-Prefix), faltet `text_delta` → `agent_text_delta`; ein `error`
     **terminiert** den Turn (`turn_error` statt, nicht zusätzlich zu,
     `turn_complete`). Orchestrator-Telemetrie (`iteration_start`, `tool_*`,
     `verifier`, …) wird **verworfen**. Turns sind **pro Verbindung
     serialisiert** (Promise-Chain), damit Surface-Frames nicht interleaven.
- **`plugin.ts`** — `activate` registriert zusätzlich zur Discovery-Route
  (`GET /omadia-ui/info`, jetzt `websocket: /omadia-ui/canvas`) den WS-Endpoint
  via `core.registerWebSocket` — **feature-detected**: fehlt die Methode (kein
  WS-Registry verdrahtet), degradiert der Channel auf Discovery-only, inert. Die
  Auth macht der Kernel **vor** dem Handler (PR-11); `session` ist verifiziert.
  Teardown: Routes + WS-Registrierungen + Live-Sockets räumt der Kernel pro
  `channelId` beim Deactivate ab.

**Client-Context-Passthrough** (Folge-Slice): die im `handshake_select`
deklarierten **`localOperations`** (das Ops-Catalog-Subset des Clients — die
Tier-2-Routing-Wahrheit für Class-B-Aktionen) werden pro Verbindung gehalten und
auf jedem Turn als `IncomingTurn.metadata.localOperations` mitgegeben (Key fehlt,
wenn der Client nichts deklariert). Außerdem kann ein `turn` eine strukturierte
**`action`** tragen (Button-/Row-Click; Objekt mit String-`type`, sonst
`turn_error` ohne Dispatch) → `IncomingTurn.metadata.action`. Beides additiv via
`metadata`, bis das SDK typed Fields bekommt (Protokoll-Feedback omadia-ui
`docs/protocol/1.0.md` §5.1).

Test: `test/uiChannelWebSocket.test.ts` treibt `handleCanvasSocket` mit
Mock-`ChannelSocket` + Mock-`handleTurnStream` (offer; matching select → ack mit
client-`canvasSessionId`; Versions-Mismatch → error, zweiter → close; Turn →
korrekt geformter `IncomingTurn` + `surface_*`/`agent_text_delta`/`turn_complete`
Fan-out; Turn vor Handshake wird verworfen; `localOperations`/`action` landen in
`metadata`, malformed `action` → `turn_error`). Real-Socket-Pfad ist durch PR-11s
`webSocketRegistry.test.ts` abgedeckt. **Damit kann der Agent live UI über den
Canvas synthetisieren, sobald Tier 2 (`omadia-ui-orchestrator`) `surface_*`
emittiert** — der Transport ist vollständig.

### Conductor Workflow-Templates (Operator-API, #429)

Kuratierter, file-basierter Template-Katalog für Conductor: `TemplateManifest`s
(kompletter `WorkflowGraph` mit `slot:<kind>:<key>`-Platzhaltern in den fünf
Ref-Feldern + Slot-Deklarationen, Contract in `@omadia/conductor-core`;
Name/Description/useCase und Slot-Label/-Beschreibungen sind **im Manifest
lokalisierbar** — `LocalizedText` = plain string oder `{ en, de?, … }` mit
Pflicht-`en`, Auflösung via `resolveLocalizedText`, UI löst client-seitig per
`useLocale()` auf; `GET /templates` liefert weiterhin unaufgelöste volle
Manifeste) liegen
als JSON in `middleware/src/conductor/templates/` und werden beim Wiring einmal
via `loadTemplateCatalog()` geladen (`templateCatalog.ts`; invalide Assets
werden mit Log-Zeile übersprungen, CI-Gate ist
`test/conductorTemplateCatalog.test.ts`). Drei neue Routes in
`src/conductor/routes.ts`, gemountet unter dem auth-gated
`/api/v1/operator/conductors`, **vor** dem `/:slug`-Catch-all registriert:

- **`GET /templates`** → `200 { templates: TemplateManifest[] }` — volle
  Manifeste inkl. Graph + Slots (maschinenlesbar für #330/Facilitator). Ohne
  verdrahteten Katalog `{ templates: [] }`; Fehler →
  `500 conductor.templates_failed`.
- **`POST /templates/:id/resolve`** — Body `{ mapping }`. Ephemere
  Instanziierung (der #330-Seam und "Open in designer" der UI): Slot-Mapping
  substituieren, validieren, Graph zurückgeben, **nichts persistieren** →
  `200 { graph }`. Fehler: `404 conductor.template_not_found`;
  `400 conductor.template_slot_mapping_incomplete` mit
  `missing: [{ kind, key, label }]` (fail-clear vor allem anderen);
  `400 conductor.invalid_graph` mit den bekannten `unknown_*_ref`-Codes.
- **`POST /templates/:id/instantiate`** — Body
  `{ slug, name?, description?, mapping, enable? }`. Gleiche Fehlerpfade wie
  `resolve`, plus: fehlender/leerer `slug` → `400 conductor.invalid_input`;
  Slug-Kollision → `409 conductor.slug_exists` (**bewusste Abweichung** von der
  Upsert-Semantik von `POST /` — Instanziieren heißt "neu anlegen", nie still
  über einen bestehenden Workflow publishen). Die Kollision wird **atomar** im
  Store erkannt: `createOrPublish({ expectNew: true })` →
  `INSERT … ON CONFLICT (slug) DO NOTHING`, null Rows → Transaktion bricht mit
  `WorkflowSlugExistsError` ab, Route mappt auf den 409 — kein racy
  `getBySlug`-Pre-Check mehr; von zwei parallelen Instanziierungen desselben
  frischen Slugs gewinnt genau eine. Publish sonst exakt wie
  `POST /` inkl. atomarem Cron-Schedule-Reconcile (`onPublished` →
  `scheduleStore.reconcileOnClient`); `enable` default `false`; `name`/
  `description` defaulten aufs Manifest (en-aufgelöst) →
  `201 { workflow, version }`.

**Validierungs-Unterschied zu `POST /`:** beide Template-Routes validieren mit
**live `KnownRefs`** (Agent-Slugs aus der Registry, Action-Ids, Role-Keys,
Event-Katalog — `templateKnownRefs` in `src/conductor/index.ts`), `POST /` nur
strukturell. Bewusst strenger: eine Template-Instanz muss lauffähig sein, nicht
nur wohlgeformt. Ergebnis der Instanziierung ist ein gewöhnlicher versionierter
Workflow ohne Rückverweis aufs Template (Copy, not Reference — seit #478 mit
`template_id`/`template_version`-Provenance-Stempel auf der Workflow-Row, aber
weiterhin nie zur Laufzeit dereferenziert).

**Templates v2 (#478): DB-Store + Composite-Katalog + CRUD/Versionierung.**
Conductor-Migration **`0006_templates.sql`** (eigene Chain,
`_conductor_migrations`): `conductor_templates` (Owner, Review-`status`
`private|pending|shared` ohne CHECK, `latest_version`, `reviewed_by`),
`conductor_template_versions` (immutable JSONB-Manifeste, PK
`(template_id, version)`), `conductor_template_instantiations` (append-only,
anonym, denormalisierter `template_name`), plus Provenance-Spalten auf
`conductor_workflows`. `src/conductor/templateStore.ts` =
`createTemplateStore(pool, log)` (create/addVersion atomar per `FOR UPDATE`/
get/list/delete/setStatus/listVersions/getVersion/recordInstantiation/
instantiationCounts/stampWorkflowProvenance); die `version`-Spalte ist
autoritativ und wird beim Lesen in `manifest.version` gestempelt.

Der **Composite-Katalog** (`createCompositeTemplateCatalog` in
`templateCatalog.ts`; Bundled-Files + DB-User-Templates + Plugin-Seam
`registerPluginTemplates`/`unregisterPluginTemplates` für B3) ist
viewer-scoped: `{ list(viewer), get(id, viewer) }`, Viewer =
`req.session?.sub ?? 'operator'`. **Sichtbarkeitsregel (Review-Gate-Fix):**
bundled/plugin für alle; User-Template sichtbar wenn `shared` ODER
`createdBy = viewer` ODER **`pending`** (jeder Operator auf der single-tier
Operator-API ist potenzieller Reviewer); nur fremde `private` bleiben
verborgen. `get` wendet exakt die List-Regel an (kein 404-vs-List-Drift).

Routes (in `src/conductor/templateRoutes.ts` ausgelagert, Registrierung
unverändert **vor** `/:slug`): `GET /templates` liefert jetzt
`TemplateSummary` = Manifest + **additive** Felder `source`
(`bundled|user|plugin`), `status?`, `createdBy?`, `version`, `latestVersion`,
`instantiationCount`, `updatedAt?` (v1-Felder unangetastet — #330 per
Contract-Test gesichert). Neu: **`GET /templates/:id`** (`404
conductor.template_not_found` wenn unsichtbar), **`POST /templates`** Body
`{ manifest }` (validiert, erstellt `private` im Besitz des Viewers → `201
{ template }`; `409 conductor.template_id_exists` bei Kollision mit
bundled/plugin/DB; `400 conductor.template_invalid` mit Issues-Array),
**`PUT /templates/:id`** (author-only `403 conductor.template_forbidden`;
`manifest.id` muss `:id` sein → 400; hängt Version `latestVersion+1` an —
Status bleibt bewusst unverändert: das Gate regelt das Teilen, nicht jede
Version), **`DELETE /templates/:id`** (author-only, nur User-Source → 204),
**`GET /templates/:id/versions`**. `resolve`/`instantiate` akzeptieren
optional `version` im Body (Default: latest); `instantiate` stempelt die
Provenance **in derselben Transaktion** wie den Publish (via `onPublished`)
und schreibt best-effort eine Telemetry-Row. Tests:
`test/conductorTemplateStore.test.ts` (stateful Fake-Pool) +
`test/conductorTemplateRoutes.test.ts` (echter Composite-Katalog; explizite
Reviewer-Reachability-Fälle: pending Template von A erscheint in Bs List/Get).

**Templates v2 (#478 B3): Authoring, Review-Gate, Plugin-Templates, Update-Hint.**
Neu in `templateRoutes.ts`: **`POST /:slug/save-as-template`** (der Router ist
auf `/api/v1/operator/conductors` gemountet — es gibt keinen
`/workflows`-Präfix) lädt die aktive publizierte Version und liefert per
`inferTemplateManifest` einen **Draft** `{ draft, sourceWorkflow: { slug,
version } }` — jede konkrete Ref wird deklarierter Slot (Label = ursprüngliche
Ref), NICHTS wird persistiert; die UI editiert und publisht via
`POST /templates` bzw. `PUT` (Body-Overrides `{ id?, name?, description?,
useCase? }`; Default-Id = Slug, bei Kollision `-template`-Suffix; `404
conductor.workflow_not_found` ohne publizierte Version). **Review-Gate**
(Make-Shape `private → pending → shared`): `POST /templates/:id/submit`
(author-only; `409 conductor.template_status_conflict` außer aus `private`),
`POST /templates/:id/approve` / `reject` (**jeder Operator** — erreichbar,
weil `pending` install-weit sichtbar ist; Auflösung über das viewer-scoped
Katalog-`get`, `reviewed_by = viewer` wird protokolliert; Self-Approval bleibt
erlaubt/auditierbar, Separation of Duties explizit deferred). Ein Reject durch
einen Nicht-Autor macht das Template `private` und damit für den Reviewer
unsichtbar — die Response trägt dann `template: null`. **Update-Hint:**
Workflow-List (`GET /`) und -Detail (`GET /:slug`) liefern additiv
`template?: { id, version, latestVersion, updateAvailable }` wenn die Row
Provenance trägt (`attachTemplateHints` in `templateHints.ts`; ein
Katalog-List-Read pro Request, viewer-scoped — ein unsichtbares Template
degradiert zu `latestVersion = version, updateAvailable: false`, kein
Existenz-Leak); `workflowStore` liest dafür `template_id`/`template_version`
mit (additiv auf `ConductorWorkflow`). **Plugin-Templates** (Trust-Boundary
dokumentiert in `docs/security-architecture.md` §4): Deklaration
`permissions.templates` (package-relative `.json`-Pfade, Parsing
`extractTemplateDeclarations` in `plugins/manifestLoader.ts`), Install-Gate
**fail-closed** in `plugins/pluginTemplates.ts` (`loadPluginTemplates`:
Pfad-Confinement nach Symlink-Unwrapping, Id-Namespace
`plugin:<pluginId>:<name>`, `checkTemplateManifest({ strict: true })`,
`isValidCron`); jeder Verstoß → `install.template_invalid`, Install
verweigert, nichts wird ausgeführt. Akzeptierte Manifeste registrieren als
read-only Source `plugin` im Composite-Katalog (InstallService-Dep
`conductorTemplates`, lazy aufgelöst — Registrar-Forward-Ref in
`src/index.ts`; Boot-Sweep `registerInstalledPluginTemplates` fail-open pro
Template), Deregistrierung beim Uninstall. Tests:
`test/pluginTemplates.test.ts` (Gate incl. Symlink-Escape,
InstallService-Integration, Boot-Sweep) +
`test/conductorTemplateRoutes.test.ts` (State-Machine incl.
Non-Author-Approve, Inferenz-Roundtrip, Update-Hint, Plugin-Source read-only).

**Templates v2 (#478 B4): Builder-Chat-Template-Awareness.** Der
Conversational-Builder (`src/conductor/builderAgent.ts`) sieht jetzt den
Template-Katalog: seine Deps bekommen den viewer-scoped Composite-Katalog
(`templateCatalog.list(viewer)`) plus `templateKnownRefs` (dieselbe — jetzt in
`src/conductor/index.ts` gehoistete — Funktion, gegen die auch
`resolve`/`instantiate` validieren). Der System-Prompt trägt einen kompakten
**Katalog-Digest** (pro sichtbarem Template: id, en-aufgelöste `name`/`useCase`
via `resolveLocalizedText`, Version, Slot-Liste inkl. Text-Slots; Cap 30
Templates mit Count-Note). Das Reply-Protokoll erlaubt zusätzlich zu
`{ reply, patches }` einen `templateProposals`-Block; **`POST /builder/turn`**
liefert ihn **additiv** durch (`templateProposals?: [{ templateId, version,
reason, prefill }]`, Feld fehlt komplett ohne Proposals — v1-Wire-Shape
byte-identisch). Serverseitiges Gate im Agent-Seam (defensiv, wirft nie):
unbekannte/unsichtbare Template-Ids werden gegen den viewer-scoped Katalog
gedroppt, Duplikate dedupliziert, max. 3 Proposals, `version` kommt
autoritativ aus dem Katalog (nicht vom LLM), `prefill`-Guesses nur für
deklarierte Slot-Keys und Ref-Kinds nur wenn sie gegen die live `KnownRefs`
auflösen (`channels` hat kein KnownRefs-Set → strukturell akzeptiert, wie in
`validate()`); gestrippte Guesses rendert das Formular leer statt kaputt. Ein
kaputter Katalog/KnownRefs-Read degradiert zum templatelosen Turn statt zum
500. Chat **proponiert und prefillt nur** — Instanziierung bleibt auf den
bestehenden `resolve`/`instantiate`-Routen (Formular-Flow, keine
Auto-Instanziierung). Der Viewer läuft als `req.session?.sub ?? 'operator'`
durch `runTurn({ ..., viewer })`. Tests: `test/conductorBuilder.test.ts`
(Digest-Sichtbarkeit inkl. pending/fremd-privat, Proposal-Vetting,
Malformed-Blocks, No-Proposal-Regression).

### Conductor Webhooks — Inbound + Outbound (#437)

Generischer Webhook-Mechanismus für Conductor, symmetrisch zum bisher
declared-but-dead `'webhook'`-`TriggerKind` (`conductor-core/src/types.ts`).

**Inbound:** `POST /api/hooks/:endpointId` — unauthenticated Mount **vor**
`app.use(express.json(...))` in `src/index.ts` (Forward-Reference-Pattern wie
`conductorTemplateRegistrarRef`: `conductorWebhookInboundDepsRef` wird früh
deklariert, der Router (`src/routes/conductorWebhooksInbound.ts`) mountet
sofort mit einem `getDeps()`-Getter darauf, die echten Deps werden erst tief
im `graphPool`-Block nach `wireConductor(...)` zugewiesen — by request time
immer aufgelöst). Raw-Body-HMAC (`x-webhook-signature: sha256=<hex>`) gegen
das per-Endpoint-Secret aus dem Vault (`webhookEndpointStore.ts`,
`core:conductor`-Namespace); unbekannte Endpoint-Id und falsches Secret
antworten **byte-identisch** mit `401` (kein Existenz-Leak). Verifizierte
Delivery → atomarer Claim der Delivery-Id (`x-webhook-delivery-id`, sonst
Server-generiert = kein Dedupe, aber kein stiller Drop) in
`conductor_webhook_inbound_deliveries`, dann `ConductorEventRouter.emit(
endpoint.eventId, payload, 'webhook:<endpointId>')` — jeder Workflow mit
passendem `event`- **oder** `webhook`-Trigger (`eventRouter.ts` matcht jetzt
beide Kinds identisch) startet einen Run. Jede geclaimte Delivery landet mit
genau einem terminalen `outcome`; Noise (disabled, malformed JSON, kein
Subscriber) antwortet immer `2xx` (Redelivery-Storm-Vermeidung), der globale
Kill-Switch ist `CONDUCTOR_WEBHOOKS_ENABLED` (§10).

**Outbound:** `ConductorWebhookDispatcher` (`webhookDispatcher.ts`) — ein
neuer `notifyRunEnded`-Hook in `ConductorRunExecutor` (feuert exakt an jedem
Punkt, an dem ein echter, nicht-Dry-Run-Run terminal wird — `driveFrom`s
Loop-Exit UND die drei direkten Terminal-Returns in `resolveAwait`/
`resolveDevJobAwait`/`expireAwait`, zentralisiert in `finalizeIfEnded`) löst
`run.completed`/`run.failed` aus. Der Dispatcher fächert an jede enabled
`conductor_webhook_subscriptions`-Row für das Event auf, signiert HMAC
(`x-omadia-signature`), und retried mit exponentiellem Backoff (Default 6
Attempts, 30s verdoppelnd bis 30min Cap) — `conductor_webhook_deliveries` ist
das persistente Delivery-Log; `ConductorWebhookRetryWorker` pollt fällige
Retries (überlebt Prozess-Restart). Zusätzlich: ein Built-in-Action
`webhook.post` (`webhookPostAction.ts`, special-cased in `src/index.ts`s
`invokeAction`-Wiring VOR dem `dynamicAgentRuntime`-Dispatch, kein Plugin
nötig) für Ad-hoc-Outbound-POST aus einem Workflow-Step.

**Security:** Secrets (Inbound-Endpoint + Outbound-Subscription) leben
ausschließlich im Vault (`core:conductor`, Split Metadata-in-Postgres /
Secret-in-Vault nach `DevGithubAppStore`-Vorbild) — nie in Graph-JSON, nie in
einer List/Get-Response (nur einmalig bei Create/Rotate). SSRF-Guard
(`webhookOutbound.ts`) wiederverwendet den bestehenden
`platform/ssrfGuard.ts`-Mechanismus (Literal-IP-Precheck + guarded undici
`Agent` gegen DNS-Rebinding) für **beide** Outbound-Pfade (Dispatcher +
`webhook.post`).

**Migration:** `src/conductor/migrations/0007_webhooks.sql` (eigene
`_conductor_migrations`-Chain, nächste freie Nummer nach `0006_templates.sql`)
— `conductor_webhook_endpoints`, `conductor_webhook_inbound_deliveries`,
`conductor_webhook_subscriptions`, `conductor_webhook_deliveries`.

**Admin-API:** CRUD + Secret-Rotation + Delivery-Logs unter dem bestehenden
auth-gated `/api/v1/operator/conductors/webhooks/*`
(`webhookRoutes.ts`, registriert **vor** `/:slug` wie die Template-Routes).
Eine minimale Admin-UI-Seite (`web-ui/app/admin/webhooks/`, Endpoints +
Subscriptions, Secret-Rotation, Delivery-History) **ist** Teil dieser
Änderung — sie erfüllt das Issue-Akzeptanzkriterium einer Admin-Oberfläche.
Die inbound-Endpoint-URL wird server-seitig aus `webhookInboundBaseUrl`
(`CONDUCTOR_WEBHOOK_PUBLIC_BASE_URL`, fällt zurück auf `PUBLIC_BASE_URL`)
gebaut und als `inboundUrl`-Feld zurückgegeben — die UI zeigt diesen Wert an,
nie `window.location.origin` (im lokalen Standard-Dev-Setup ist das der
Next.js-Dev-Server, der nur `/bot-api/*` proxied, nicht `/api/hooks/*`,
siehe `web-ui/next.config.ts`).

Tests: `test/conductorWebhookInbound.test.ts` (Route, Signatur/Dedupe/2xx-
Noise), `test/conductorWebhookDispatcher.test.ts` (Signing/Retry/Backoff),
`test/conductorWebhookEndpointStore.test.ts` (Vault-Split, Dedupe-Claim),
`test/conductorWebhookPostAction.test.ts` + SSRF-Guard-Unit-Tests,
`test/conductorEventRouterWebhookTrigger.test.ts` (`webhook`-Trigger-Kind
Matching, keine Regression auf `event`).
### Dataset-Routen + `query_dataset`-Tool (#430)

Neue REST-Oberfläche `src/routes/datasets.ts`, gemountet unter
`/api/v1/datasets` (ACL-Pattern wie `/api/v1/memory` —
`req.session.omadia_user_id`, kein anonymer Zugriff):

- `POST /api/v1/datasets` — multipart CSV-Upload (`multer`, ein File pro
  Request, `MAX_UPLOAD_BYTES` = 25 MB).
- `GET /api/v1/datasets` — Liste der eigenen Datasets.
- `GET /api/v1/datasets/:id` — Schema + Metadaten eines Datasets.
- `GET /api/v1/datasets/:id/rows` — paginierte Roh-Zeilen.
- `DELETE /api/v1/datasets/:id` — Dataset löschen.

Dieselbe Pipeline (`importCsvDataset` aus
`harness-orchestrator/src/datasetImport.ts`) läuft auch automatisch beim
CSV-Chat-Attachment-Pfad in `orchestrator.ts`'s `ingestAttachments` (ersetzt
dort den bisherigen 20.000-Zeichen-Text-Cutoff für CSVs) — siehe §7 für die
Knowledge-Graph-seitige Implementierung.

Neues natives Tool **`query_dataset`** (`tools/queryDatasetTool.ts`),
registriert wie die übrigen Orchestrator-Tools in §3's Orchestrator-Setup:
`list_datasets` / `get_schema` / `query_rows` gegen eine eingeschränkte
Filter/Aggregat-DSL (nie rohes SQL vom Modell), Ergebnisse immer
server-seitig paginiert/aggregiert bzw. auf 200 Gruppen gecappt.

**Identity-Resolution (Fixup Runde 5):** für einen Channel-Turn (Teams/
Slack/Telegram) ist `ChatTurnInput.userId` die RAW channel-native id, NICHT
die kanonische `omadiaUserId` uuid. `resolveTurnOwnerIdentity`
(`resolveTurnOwnerIdentity.ts`) löst sie EINMAL pro Turn auf (via
`KnowledgeGraph.resolveOrCreateChannelIdentity`, wenn `input.channelIdentity`
gesetzt ist — sonst fällt sie auf `input.userId` zurück, das für HTTP/CLI-
Turns bereits kanonisch ist) und legt sie in
`TurnContextValue.resolvedOmadiaUserId` ab — einmal in `runTurn` (non-
streaming) und einmal in `chatStream` (der Pfad, den
`createOrchestratorDispatcher` für Channel-Turns tatsächlich aufruft).
`QueryDatasetTool` und `ingestAttachments` lesen beide ausschließlich dieses
Feld für die Dataset-ACL (niemals das rohe `TurnContextValue.userId`) — vorher
schrieb der Import-Pfad unter der kanonischen id, während der Query-Pfad die
rohe id las, sodass ein Channel-User sein eigenes gerade importiertes Dataset
nie wiederfinden konnte.

### Plugin-contributed Navigation (#470, Phase 1 der Dev-Platform-Extraktion)

Damit ein Feature wirklich *installierbar* ist, muss sein Menü-Eintrag mit
dem Plugin mitreisen — bisher war die Navigation ein eingefrorenes Literal in
`web-ui/app/_components/Nav.tsx`. Neue Plugin-Fähigkeit:

```ts
ctx.uiRoutes.registerNav({ navId, href, cluster?, order?, label })
```

Bewusst getrennt von `ctx.uiRoutes.register()`: ein uiRoute-Descriptor
adressiert relativ zum `/p/<pluginId>`-Mount des Plugins, ein Nav-Eintrag
adressiert einen absoluten In-App-Pfad. Beides in einen Descriptor zu falten
würde eines der zwei Pfad-Felder zur Lüge machen. Beide teilen sich denselben
Lifecycle in `UiRouteCatalog` (`disposeBySource` räumt beide ab).

Neue Route: **`GET /api/v1/ui/navigation?locale=<l>`**
(`src/routes/uiNavigation.ts`), gemountet unter `/api` und zusätzlich
explizit hinter `requireAuth` — die Einträge verraten, welche Features
installiert sind. Antwort ist `no-store` und enthält **bereits aufgelöste**
Labels: der Browser bekommt die Locale-Map nie zu sehen, dadurch bleibt das
Web-UI auf genau einer i18n-Uhr (next-intl) statt auf zwei, die beim
Sprachwechsel auseinanderlaufen.

Die Shell holt die Einträge **server-seitig im Root-Layout** (`fetchNavEntries`
in `web-ui/app/_lib/navigation.ts`, 2s-Timeout, degradiert lautlos auf die
statische Navigation) und merged sie in `Nav.tsx`. Merge-Regeln: Eintrag
landet im benannten Cluster; unbekannter/fehlender Cluster wird zum
Top-Level-Eintrag (statt still verschluckt zu werden); ein href-Konflikt mit
einem statischen Eintrag wird verworfen, damit ein Plugin kein Core-Ziel
überschatten kann.

Jedes vom Plugin gelieferte Feld gilt als **untrusted input**, weil es im
vertrauenswürdigen Header gerendert wird: `href` nur in kanonischer In-App-Form
(kein `//host`, keine Dot-Segments, keine Query/Fragment/Prozent-Kodierung —
sonst wäre die „Core gewinnt"-Regel per Alias umgehbar), Labels längenbegrenzt
und gegen Control-, Bidi- und Zero-Width-Codepoints geprüft (Trojan-Source-
Spoofing benachbarter Core-Einträge). Dazu Obergrenzen für href-/navId-Länge,
Locale-Map-Größe und Einträge pro Plugin, weil der Katalog in jede
Root-Layout-RSC-Antwort serialisiert wird.

Erster Consumer ist die Dev Platform selbst: ihr Eintrag wird aus dem
bestehenden `DEV_PLATFORM_ENABLED`-Block in `index.ts` registriert
(`core:dev-platform`), nicht mehr in `Nav.tsx` hardcodiert. Wenn das Plugin-
Package landet, wird daraus `ctx.uiRoutes.registerNav(...)` in dessen
`activate()` — an der Shell ändert sich dabei nichts. Vollständiger Plan und
die verbleibenden Phasen: `specs/470-dev-platform-plugin/plan.md`.

---

### Public API Channel (issue #438)

Neues Built-in-Channel-Plugin `packages/harness-channel-api/`
(`@omadia/channel-api`, `kind: channel`), erster nicht-Session-Cookie-Ingress
für externe Systeme: **`POST /api/public/v1/chat`** treibt einen Turn genau
wie jeder andere Channel — über `core.registerRouter` +
`CoreApi.handleTurnStream` —, authentifiziert aber per **API-Key**
(`Authorization: Bearer omk_…`) statt Session-Cookie. NDJSON-Framing
identisch zu `/chat/stream` (`src/routes/chat.ts`); da der Turn über
`CoreApi.handleTurnStream` läuft, greifen PII-Masking (Privacy-Guard),
Memory und Knowledge-Graph unverändert — **kein zweiter Masking-Pfad**.

- **Credential-Modell** (geklärte Design-Entscheidung im Issue): ein API-Key
  **ist** seine eigene Identität — `ChannelUserRef{ kind: 'custom', id:
  'key:<id>' }` —, kein Delegat für einen menschlichen Endnutzer. Keine
  Impersonation-Fläche.
- **Storage:** vault-backed über `ctx.secrets` (eigener Plugin-Namespace,
  `permissions.secrets.runtime_write: true`) — kein DB-Migration nötig. Nur
  der sha256-Hash landet im Vault; der Klartext-Key wird genau einmal beim
  `create()` zurückgegeben (`packages/harness-channel-api/src/apiKeyToken.ts`,
  spiegelt `src/devplatform/jobToken.ts`s Mint/Hash/Verify-Muster —
  `crypto.timingSafeEqual`, kein früh-abbrechender String-Vergleich).
- **Rate-Limiting:** Fixed-Window-Token-Bucket pro Key
  (`rateLimiter.ts`, spiegelt `platform/httpAccessor.ts`s `TokenBucket`),
  Kapazität pro Key konfigurierbar (`create({ rateLimitPerMinute })`),
  Default 60/min. Über Budget → `429`.
- **Audit-Log:** jeder authentifizierte Call schreibt einen Eintrag
  (`keyId`, `route`, `method`, `at`, `status`) — vault-backed, auf die
  letzten `MAX_ENTRIES` (200) gedeckelt, Writes seriell über eine interne
  Promise-Queue (`auditLog.ts`).
- **Key-Lifecycle** (`GET`/`POST /api/public/v1/admin/keys`, `POST
  /api/public/v1/admin/keys/:id/revoke`) liegt bewusst unter demselben
  `/api/public/v1`-Prefix, ist aber **nicht** in
  `src/auth/publicPaths.ts`s Exemption-Liste — nur `.../chat` ist public.
  Ein früherer Stand dieser Notiz behauptete, das sei ein kompletter
  Auth-Bypass gewesen (jeder anonyme Caller könnte Keys minten/listen/
  revoken); das war empirisch falsch. `src/index.ts` mountet früh im Boot
  `app.use('/api', requireAuth, createChatRouter(...))` (der OB-106-Hotfix)
  — lange bevor `pluginRouteRegistry.mountAll(app)` später im selben Boot
  läuft. Express wertet Middleware in Mount-Reihenfolge für den gesamten
  `/api`-Prefix aus, unabhängig davon, welcher Router den Pfad am Ende
  bedient — `requireAuth` lief also bereits vor JEDEM `/api/*`-Request,
  auch plugin-gemounteten, außer der Pfad steht in
  `publicPaths.ts`. `/api/public/v1/admin/keys` stand dort nie, war also
  schon durch dieses Gate geschützt — genau wie jede andere
  nicht-exemptierte Channel-Route. Eine Minimal-Reproduktion mit dem
  echten Mount-Order (echtes `createRequireAuth` + `publicPaths`) bestätigt:
  ein anonymer Request auf `/api/public/v1/admin/keys` bekommt `401
  {code:'auth.missing'}` von diesem Gate, bevor er überhaupt den
  Plugin-Router (der selbst keine eigene Auth hat, da `core.registerRouter`
  nur active/inactive prüft) erreicht.

  Diese Absicherung ist real, aber implizit — sie hängt an der Mount-
  Reihenfolge und daran, dass der Pfad nie in `publicPaths.ts` landet.
  Beides kann ein künftiger Refactor versehentlich brechen, ohne dass
  etwas sichtbar fehlschlägt. Deshalb der reale Fix (Kernel-Ebene,
  Security-Nachbesserung), der die Absicherung explizit statt implizit
  macht: `PluginContext` bekommt ein optionales `ctx.operatorAuth`
  (`OperatorAuthAccessor`), vom Kernel published und in jede
  Plugin-Runtime durchgereicht (`ToolPluginRuntime`, `DynamicAgentRuntime`,
  `DefaultChannelRegistry`). `hasValidSession(cookieHeader)` nutzt exakt
  dieselbe Verifikationslogik wie `requireAuth`
  (`evaluateSessionToken` in `src/auth/requireAuth.ts`) — ein Code-Pfad,
  keine zwei, die auseinanderlaufen können. `adminKeysRouter.ts` wendet das
  jetzt als Router-Middleware VOR jedem Handler an: fehlende/ungültige
  Session → `401`; kein `ctx.operatorAuth` verfügbar → `503` (fail closed,
  nie stillschweigend offen). Der Vorteil ist, dass die Garantie nicht mehr
  an der Mount-Reihenfolge hängt und künftige Plugins mit Admin-Fläche den
  Accessor wiederverwenden können, statt sich auf dieselbe Koinzidenz zu
  verlassen. Siehe `docs/security-architecture.md` § 9 für die volle
  Mechanik.
- **Scope:** nur `chat` in v1 (Issue #438 explizit: "Start with chat …, then
  extend to other flows" — weitere Flows sind Folge-Issues).

Tests: `test/channelApi/` — u.a. eine echte Orchestrator- + echte
Privacy-Guard-Integration (`chatRouterPrivacyIntegration.test.ts`, spiegelt
`test/orchestrator/promptMaskPipeline.test.ts`s "realer Turn, gefakter LLM"-
Muster), Auth/Rate-Limit/Revoke/Audit-Wiring (`chatRouter.test.ts`), Key-CRUD
+ die reale `ctx.operatorAuth`-Verifikation inkl. Fail-closed-Pfad
(`adminKeysRouter.test.ts`), und die `publicPaths`-Exemption
(`publicPathsExemption.test.ts`).

---

### API-Keys als eigenständige Auth-Methode (issue #439)

Issue #438 hatte die Bearer-Auth plugin-intern gebaut und genau **eine** Route
abgesichert. #439 macht daraus eine allgemeine Authentifizierungs-Methode
neben dem Session-Cookie — Zielfall: eine Laravel/PHP-Integration, die omadia
vom eigenen Server aus aufruft, ohne menschliche Session.

- **Neues Workspace-Package `packages/harness-api-key-auth/`
  (`@omadia/api-key-auth`).** `apiKeyToken.ts`, `apiKeyStore.ts`,
  `rateLimiter.ts` und `auditLog.ts` sind aus `harness-channel-api/`
  hierher gezogen; es gibt danach **genau eine** Implementierung von
  Mint/Hash/Verify/Store. Warum ein Package und nicht `src/auth/`: der Kernel
  darf nie aus einem Channel-Plugin importieren, und ein Plugin kann keinen
  Kernel-Source importieren (eigenes `tsconfig` mit `rootDir: src`, Auflösung
  ausschließlich über `@omadia/*`). Ein Workspace-Package ist die einzige
  Stelle, die beide Richtungen bedient — dieselbe Rolle, die
  `@omadia/plugin-api` und `@omadia/channel-sdk` schon spielen.
  Das Package ist bewusst dependency-frei (nur `express` als Peer): die
  Storage-Abhängigkeit ist ein strukturelles Subset (`ApiKeySecretStorage` in
  `secretStorage.ts`), das `SecretsAccessor` ohne Adapter erfüllt.
- **`requireApiKey(...)`** (`requireApiKey.ts`) ist die mountbare
  Express-Middleware: Bearer-Parsing → `verify()` → Rate-Limit → Scope-Check,
  danach `req.apiKey: ApiKeyPrincipal`. Sie setzt **nicht** `req.session` —
  `SessionClaims.role` ist hart `'admin'`, eine synthetische Session würde
  jeden session-lesenden Downstream-Handler einen Key für einen Operator
  halten lassen. Fehlerform `{ error, message }` wie in #438 (nicht
  `{ code, message }` wie `createRequireAuth`), damit die Wire-Form von
  `POST /api/public/v1/chat` unverändert bleibt.
- **Scopes** (`apiKeyScopes.ts`): `<resource>:<action>` oder globales `*`,
  exakter Match, keine Prefix-Wildcards. Keys ohne persistiertes `scopes`-Feld
  (alles aus #438) werden auf `['chat:write']` normalisiert — genau die eine
  Fähigkeit, die sie beim Minten hatten. `*` als Default wäre eine per Upgrade
  ausgelieferte Rechteausweitung. Admin-Route nimmt `scopes` bei `POST`
  entgegen (Zod-validiert → 400 statt 500) und zeigt sie im `GET`.
  **`normalizeScopes` unterscheidet dabei *fehlend* von *kaputt*:** nur ein
  komplett fehlendes Feld (`undefined`) bekommt den Legacy-Default; ein
  vorhandenes, aber unlesbares Feld (kein Array, leeres Array, ungültige oder
  teilweise ungültige Einträge wie `"memory:read"` als String oder
  `['Chat:Write']`) ergibt die **leere** Scope-Menge — der Key
  authentifiziert weiter, ist aber für nichts autorisiert, jeder
  `hasScope`-Check schlägt fail-closed fehl. Beides in einen Grant zu
  kollabieren würde einem Key, den ein Operator bewusst von Chat
  weggeschnitten hat, genau diesen Chat-Zugriff zurückgeben. Jeder solche
  Fall loggt eine `[api-key-auth] malformed persisted scopes`-Warnung.
- **`publicPaths.ts` bleibt unverändert eng:** weiterhin nur
  `/api/public/v1/chat`. Wer `requireApiKey` auf eine neue Route mountet,
  braucht dort einen eigenen, möglichst engen Eintrag.

Tests: `test/auth/requireApiKey.test.ts` (Auth/Scope/Rate-Limit/Audit der
Middleware), `test/auth/apiKeyScopes.test.ts` (Scope-Modell inkl.
Legacy-Default), `test/channelApi/apiKeyAuthReuseSeam.test.ts` (strukturelle
Zusicherung, dass das Plugin keine zweite Kopie der Primitive hält und der
Kernel kein Channel-Plugin importiert). Die bestehenden `test/channelApi/`-
Suites laufen inhaltlich unverändert weiter, nur die Importpfade der
verschobenen Module zeigen jetzt auf `packages/harness-api-key-auth/`.

---

### Fehlercodes für die UI: `verifyErrorCode` + `ProviderVerification.code` (issue #604)

Die Middleware hat keine Request-Locale — niemand liest `Accept-Language`, und
`NEXT_LOCALE` verlässt die Next.js-Schicht nie. Jeder `message`-String auf
einem Fehler-Envelope ist damit per Konstruktion Englisch, und jede Oberfläche,
die ihn gerendert hat, hat einem deutschen Operator einen englischen Satz
gezeigt. Konsequenz für alles, was hier neu gebaut wird: **Codes raus, Sätze
behalten wir für Logs.**

- **`ProviderVerification.code`** (`src/platform/providerCredentialVerifier.ts`):
  optionales Feld, gesetzt ausschließlich von `rejected()` auf
  `'providers.key_rejected'`. `error` bleibt unverändert der englische
  Fallback-Satz für ältere Clients. Kein anderes Verdikt setzt `code` — ein
  `unverified` trägt seinen Grund weiterhin in `reason` (nie gerendert).
- **`verifyErrorCode`** auf der Provider-Zeile von `GET /v1/admin/providers`
  (`src/routes/adminProviders.ts`): konditionaler Spread neben dem bestehenden
  `verifyError`. Rein additiv — fehlt der Code, fehlt das Feld komplett, und
  ein Client von vor #604 sieht exakt die alte Payload.
- **Zwei Codes statt einem bei `PATCH /v1/admin/settings`**
  (`src/routes/adminSettings.ts`): Wird der ganze Batch abgelehnt, antwortet
  die Route mit `settings.invalid_values`, wenn der *Wert* mindestens einer
  bekannten Einstellung durch die Validierung gefallen ist, sonst weiter mit
  `settings.no_valid_changes` (kein gesendeter Key ist eine Einstellung, die
  dieser Server aktuell anbietet). Ein Code für beides hieß Copy, die im einen
  Fall lügt: ein `ANTHROPIC_API_KEY` im falschen Format wurde als unbekannte
  Einstellung gemeldet, mit "Seite neu laden" als Aktion. **Wer eine neue
  Wert-Validierung ergänzt, nutzt `rejectValue(key, message)` statt
  `errors.push(...)`** — sonst landet der Fall wieder im falschen Code.
- **Web-UI-Seite:** `ApiError.code` parst den Code einmal zentral,
  `web-ui/app/_lib/errorHelp.ts` löst ihn gegen
  `messages/{en,de}.json → errorHelp.<code>.{what,next}` auf, und
  `web-ui/app/_components/ErrorHelp.tsx` rendert beides plus eine
  eingeklappte Support-Disclosure (`supportDetail()` redigiert vorher).

**Key-Konvention** (`web-ui/messages/{en,de}.json`) — die Verschachtelung
spiegelt den Code: `store.list_failed` liegt unter
`errorHelp.store.list_failed`. Zwei Pflicht-Keys, je ein Satz:

```jsonc
{
  "errorHelp": {
    "providers": {
      "key_rejected": {
        "what": "The provider refused this API key.",
        "next": "Copy the key from the provider console once more and paste it here."
      }
    }
  }
}
```

- `what` — was passiert ist. Nie den Code-Identifier zurückspiegeln, nie den
  Satz des Servers hineinkopieren.
- `next` — die eine Aktion, die es löst, im Imperativ.
- `action` — optionales Link-Label, nur für Codes in `ERROR_HELP_ACTIONS`
  (ein Link auf die Seite, auf der man ohnehin steht, ist Rauschen).
- Chrome, das zur Komponente und nicht zu einem Code gehört (Summary der
  Disclosure, generische Fallback-Zeile), liegt im Nachbar-Namespace
  `errorHelpUi` — `errorHelp` bleibt damit ein reiner Code-Index.

**Einen Code ergänzen:** `code: '<family>.<name>'` in einer der fünf Dateien
emittieren → `what` + `next` in `en.json` → beide nach `de.json` spiegeln →
Code in `ERROR_HELP_CODES` (`web-ui/app/_lib/errorHelp.ts`) eintragen →
`npm test` in `web-ui/` wird grün. Die vollständige Key-Doku für die Web-UI-
Seite steht in `web-ui/messages/README.md`.
- **Abgedeckt sind nur** die Codes aus `src/routes/{install,runtime,`
  `adminProviders,store,adminSettings}.ts`. `web-ui/app/_lib/__tests__/`
  `errorHelpCoverage.test.ts` liest diese Dateien direkt und wird rot, sobald
  eine davon einen Code ohne Copy emittiert. Wer eine dieser fünf Dateien um
  einen Fehlerfall erweitert, braucht im selben PR zwei Sätze in beiden
  Locales.
- **Ein `code:`, das kein Literal ist, ist der gefährliche Fall.**
  `handleError` in `src/routes/install.ts` beantwortet einen geworfenen
  `InstallError` mit `{ code: err.code }` — zehn `install.*`-Codes stehen
  damit nirgends als Literal in der Route-Datei. Der Guard folgt diesem
  Forwarder nach `src/plugins/installService.ts` und verlangt auch dafür
  Copy. Jedes weitere nicht-literale `code:` in einer der fünf Dateien muss in
  `ACKNOWLEDGED_NON_LITERAL_CODE` mit Begründung eingetragen werden (Typ-
  Annotation, OAuth-Authorization-Code) — sonst wird der Test rot, statt den
  Code stillschweigend durchzulassen. Dasselbe gilt für eine Umstellung auf
  `sendError(...)` oder einen `error: '…'`-Envelope.

Tests: `test/providerCredentialVerifier.test.ts` (401 → `code`, jedes andere
Verdikt ohne `code`), `test/adminProvidersRoute.test.ts` (DTO trägt
`verifyErrorCode` beim abgelehnten Key, lässt das Feld sonst weg),
`test/adminSettingsRoute.test.ts` (abgelehnter Wert → `settings.invalid_values`,
unbekannter Key bzw. nicht installiertes Ziel-Plugin → `settings.no_valid_changes`).

### MCP Tool-List-Cache via `ttlMs`/`cacheScope` (issue #545)

MCP 2026-07-28 macht `tools/list`-Results cachebar (`CacheableResult`:
`ttlMs` + `cacheScope`). Umgesetzt auf SDK 1.30.0 — **kein** v2-Bump nötig,
die Felder überleben das loose Result-Parsing (gleiches Muster wie
`resultType`, #544).

- **Client** (`McpManager.listTools`, `packages/harness-orchestrator/src/mcp/
  mcpClient.ts`): TTL-Cache, Key via `mcpToolListCacheKey` — `public` ⇒ bare
  Server-ID, `private`/unbekannt/fehlend ⇒ Pool-Key (Server-ID + Token-Hash,
  Token-Rotation = Cache-Miss). Der Bare-Id-Probe akzeptiert nur als `public`
  abgelegte Einträge (`sharedPublic`-Flag): die private Liste eines token-losen
  Callers hat denselben Key (Pool-Key ohne Token = Server-ID) und darf nie
  über Auth-Kontexte geteilt werden. Rückgaben sind Deep-Copies in beide
  Richtungen — Caller-Mutation (Plugins!) erreicht den Cache nicht.
  Server-`ttlMs` geclampt auf 15 min
  (`MCP_TOOLLIST_MAX_TTL_MS`); fehlt `ttlMs`, greift ein Default von 60 s —
  **bewusste Spec-Abweichung** (Spec: fehlend ⇒ nicht cachen), Begründung in
  ADR-0009; `OMADIA_MCP_TOOLLIST_TTL_MS=0` stellt spec-strikt zurück.
- **Invalidierung:** `notifications/tools/list_changed` purgt sofort (Handler
  wird vor `connect` registriert); `close()`/`closeAll()` purgen mit; Expiry
  lazy beim Read (kein Timer, wie `evictIdle`).
- **Bypass:** Discovery (Builder-Route) und der Security-Rescan listen immer
  frisch (`fresh: true`) — ein Scan über eine gecachte Liste scannt nichts.
  Cache-Nutznießer ist der Plugin-Accessor `ctx.mcp.listTools()`.
- **Eigene Server emittieren:** Loopback `ttlMs: 300000` / `public` (Liste ist
  pro Turn-Instanz eingefroren, nicht caller-abhängig); Public-Server
  `ttlMs: 60000` / `private` (Liste ist per API-Key gefiltert — `private` ist
  Pflicht, sonst leaken fremde Tool-Sets; `tools/call` prüft Bindings weiter
  live, Revoke bleibt sofort wirksam). `list_changed`-*Emission* aus eigenen
  Servern ist bewusst Folge-Issue.

Tests: `test/mcpToolListCache.test.ts` (pure Regeln + Stdio-/HTTP-Fixtures),
Emission-Asserts in `test/cliBridge/loopbackMcpServer.test.ts` und
`test/publicMcp/publicMcpEndpoint.e2e.test.ts`.

---

### Conductor-Cancel + Approval-Härtung (#759)

Neu: **`POST /api/v1/operator/conductors/:slug/runs/:runId/cancel`** — `waiting`
endet sofort (Awaits → `'cancelled'`, synthetischer Step mit `operator_cancel`-
Actor), `running` wird geflaggt und stoppt an der nächsten Schrittgrenze
(`runStore.isCancelRequested`-Check am Loop-Kopf von `driveFrom`), terminal ⇒
409 `conductor.run_already_ended`. Schema: `conductor/migrations/0008_run_cancel.sql`.
Per-Step-Flag `human.strictApproval` (nur explizites `{approved:true}` führt
weiter; Designer-Checkbox). Validator liefert jetzt non-blocking `warnings`
(`timeout_equals_approval`, `approval_fail_open`) — im 201-Response von
`POST /` und amber im Designer. Rollen-Baton-Änderungen landen im
`admin_audit` (`conductor.role_holders_change`), verdrahtet über
`wireConductor.auditRoleChange`. Tests: `test/conductorCancelAndStrictApproval.test.ts`.
Known limitations: (a) im engen Expire-vs-Cancel-Race kann `notifyRunEnded`
**zweimal** feuern (Run-Ended-Webhooks sind at-least-once — Subscriber müssen
das tolerieren) und ein konkurrierender Writer kann auf `UNIQUE(run_id, seq)`
kollidieren (ein 500 beim Responder, Zustand bleibt korrekt); (b) verliert ein
`resolveAwait` das Lease an einen konkurrierenden Cancel, antwortet die
Respond-Route 500 statt 409 — Ergebnis korrekt (Run cancelled), Oberfläche
hässlich. Die Cancel-Flag-Spalten werden absichtlich NIE gelöscht — sie sind
der tragende Backstop aller Cancel-Races.

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

Alle hinter `DEV_ENDPOINTS_ENABLED=true` **und** der Operator-Session
(Issue #669 — vorher waren sie unauthentifiziert). Die Operator-Flächen
(KG-Lifecycle, KG-Priorities, Plugin-Domains) hängen nicht mehr an diesem
Flag, sondern liegen unter `/api/v1/admin/kg-*` bzw. `/api/admin/domains`.
Siehe `docs/security-architecture.md` §10.

### Agent-Query-Tool

`query_knowledge_graph` (in `tools/knowledgeGraphTool.ts`). Query-Typen:
- `stats`
- `list_sessions` (most-recent first, `limit` param)
- `find_entity` (`name_contains`, `model`, `limit`)
- `session_summary` (`scope`)

Wird vom Orchestrator aufgerufen, wenn der User auf prior art verweist.
End-to-End verifiziert: der Orchestrator nutzt das Tool von selbst, ohne
dass man ihn zwingt.

### Structured Datasets — CSV Import (#430)

Separate Ablage neben dem eigentlichen Graph — bewusst KEINE Graph-Node-
Explosion pro Zeile (Node-Properties sind GIN-indexiert, siehe
`ingestEntities`-Doku). Relationale Sidecar-Tabellen `datasets` +
`dataset_rows` (Migration `packages/harness-knowledge-graph-neon/src/
migrations/0029_datasets.sql`); pro Dataset genau EIN `Dataset`-Graph-Node
(`PluginEntity`, `system='dataset'`) für Recall/Zitation.

- **Interface:** `KnowledgeGraph.{ingestDataset,listDatasets,getDataset,
  queryDatasetRows,deleteDataset}` (`plugin-api/src/knowledgeGraph.ts`),
  implementiert in `@omadia/knowledge-graph-neon` (echtes SQL) UND
  `@omadia/knowledge-graph-inmemory` (volle Parität, kein Stub).
- **Import:** `POST /api/v1/datasets` (multipart CSV, `src/routes/
  datasets.ts`) sowie automatisch bei CSV-Chat-Attachments
  (`attachmentExtract.ts`'s `isCsvAttachment` branch in `orchestrator.ts`'s
  `ingestAttachments` — ersetzt den bisherigen 20.000-Zeichen-Text-Cutoff
  für CSVs).
- **Privacy:** jede importierte Zeile läuft vor dem Schreiben durch den
  bestehenden C0-Regex-Baseline-Detector (`@omadia/plugin-privacy-guard`'s
  `createBaselineDetector`/`maskPrompt`) — dieselbe Pipeline, die
  Freitext-User-Prompts schützt. Nur `string`/`date`-Spalten werden
  gescannt (Details + Kosten-Hinweis in `datasetImport.ts`'s Modul-Doc).
- **Query:** `query_dataset`-Tool (`tools/queryDatasetTool.ts`) — eine
  eingeschränkte Filter/Aggregat-DSL (nie rohes SQL vom Modell), immer
  server-seitig paginiert/aggregiert.
- **Admin-UI:** bewusst NICHT Teil dieser Änderung — siehe PR-Beschreibung
  von #430 für die Begründung; offener Folge-Task.

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

### Cross-Referenz: `query_dataset` (#430) ist kein Skill

AGENTS.md's Doku-Regel ordnet "Neue Route / Tool / Sub-Agent" §3 **und**
§8 zu. #430's `query_dataset`-Tool ist ein natives Orchestrator-Tool ohne
eigenen `skills/<name>/SKILL.md`-Ordner — es gehört also inhaltlich nicht
in "Aktuelle Skills" oben. Referenz statt Duplikat: volle Doku in §3
("Dataset-Routen + `query_dataset`-Tool") und §7 (Knowledge-Graph-Schicht).

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
DEV_ENDPOINTS_ENABLED=false         # mount /api/dev/* (Session-gated seit #669; Dev-Scaffolding)
DEV_ENDPOINTS_LOOPBACK_ONLY=false   # optional: /api/dev nur über Loopback (#669)
# Teams
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
# Conductor generic webhooks (issue #437) — Kill-Switch für POST /api/hooks/:endpointId
CONDUCTOR_WEBHOOKS_ENABLED=true
CONDUCTOR_WEBHOOK_MAX_DELIVERIES_PER_MINUTE=60   # Rate-Limit pro Endpoint (rolling minute)
# Tenant-Scope (auch für Diagramm-Cache-Keys genutzt)
GRAPH_TENANT_ID=byte5
# Prompt-PII C1-Detector (GLiNER-Sidecar, #361) — optional
PRIVACY_C1_DETECTOR_URL=http://pii-detector:8812   # unset ⇒ nur C0-Regex-Baseline
# Runtime
PORT=3979
```

`.env.example` ist gepflegt. Leere Strings parsed zod als `""`, nicht
`undefined` — daher muss der Fallback `||` sein, nicht `??`.

### Package-lokale Env-Variablen (`OMADIA_*`, ohne zod-Schema)

Das `harness-orchestrator`-Package importiert `config.ts` **nicht**; seine
Optionen laufen als `OMADIA_*`-Env mit Modul-Konstante als Default und werden
pro Aufruf aufgelöst (Änderung greift ohne Restart):

```
OMADIA_TOOL_DISPATCH_TIMEOUT_MS=240000      # äußere Dispatch-Deadline (W3-A)
OMADIA_MCP_CALL_TIMEOUT_MS=60000            # Idle-Budget pro MCP-Request (W0-2)
OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS=180000 # absolute Decke inkl. Retry (W0-2)
OMADIA_MCP_TOOLLIST_TTL_MS=60000            # Default-TTL Tool-List-Cache (#545,
                                            # ADR-0009); 0 = spec-strikt aus
```

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

### Prompt-PII-Masking (#361): C1-Transformer-Detector (GLiNER-Sidecar)

Das Privacy-Guard-Plugin (`middleware/packages/harness-plugin-privacy-guard`,
Manifest 0.4.0) maskiert bei aktiviertem Setup-Field `mask_user_prompt`
(default **off**) PII-Spans im freien User-Prompt durch Pseudonyme, bevor der
Text die LLM-Wire kreuzt; die Realwerte werden server-seitig in der finalen
Antwort restauriert. Zwei Detektor-Tiers:

- **C0** — deterministische Regex-Baseline (E-Mail, IBAN, Telefon, Adresse,
  Beträge, Daten), immer aktiv, wirft nie.
- **C1** — Transformer-Tier für Personennamen + Freiform-Adressen:
  `src/c1Detector.ts` (`createC1HttpDetector`, Detector-Id `c1-gliner`)
  spricht den GLiNER-Inference-Sidecar `middleware/sidecars/pii-detector/`
  über `POST /detect` an. Injection über den bestehenden
  `createPrivacyGuardService({c1Detector})`-Slot — **keine** Änderungen an
  `service.ts` / Orchestrator; `promptMask.ts` wurde nur durch den
  Overlap-Remainder-Fix (`6b42c6c`, siehe unten) angepasst.

Konfiguration (live pro Call aufgelöst, kein Restart nötig): Setup-Field
`c1_detector_url` zuerst, Env-Fallback `PRIVACY_C1_DETECTOR_URL` (leer =
unset). URL nicht gesetzt ⇒ C1 unkonfiguriert, es wird **kein** Call
versucht (kein Degrade-Audit-Noise). Docker: Overlay
`docker-compose.pii-detector.yaml` baut den Sidecar (keine published Ports —
er sieht rohe Prompt-PII, niemals öffentlich exponieren) und setzt die URL.

Fail-closed-Verhalten des Clients: Response-Schema wird **positiv**
validiert (skillspector-Präzedenz); Non-200, `ok:false`, malformed Spans,
Non-JSON oder Timeout (default 1500 ms) ⇒ throw ⇒ der Service degradiert
auditiert auf C0 (`promptMaskDegraded`-Log-Zeile), niemals ein stiller
unmaskierter Pass-Through. Offset-Kontrakt: der Sidecar liefert
Unicode-**Code-Point**-Offsets (Python-Semantik), der Client konvertiert
exakt nach UTF-16 und asserted pro Span `text.slice(...) === span.text` —
Mismatch ⇒ throw (ein falsch verankerter Personen-Span wäre ein Leak).
Fehlermeldungen tragen nie Prompt-Text oder Span-Werte (sie landen im
Audit-Log).

Manuelles E2E (dev):

1. `docker compose -f docker-compose.yaml -f docker-compose.pii-detector.yaml up -d`,
   warten bis `pii-detector` healthy (Modell-Load ~1-2 min).
2. Im Plugin-Setup `c1_detector_url` (`http://pii-detector:8812`) und
   `mask_user_prompt: on` setzen.
3. Prompt senden: *"What should we pay Anna Schmidt (32, lives at
   Bahnhofstr. 5, 60311 Frankfurt) given her salary of €72,000?"* —
   Service-Log zeigt `promptMask ... spans=N` inkl. `person`-Span, der
   Wire-Text trägt einen Surrogat-Namen, die finale Antwort den echten.
4. Sidecar stoppen, erneut senden — Log zeigt `promptMaskDegraded`, der
   Turn läuft auf C0 weiter (E-Mail/IBAN etc. weiterhin maskiert).
5. `mask_user_prompt: off` ⇒ byte-identisches Legacy-Verhalten.

Tests: `middleware/test/privacyPromptC1Detector.test.ts` (Client-Kontrakt +
Service-Komposition), `privacyPromptMask.test.ts` (Seam/Degrade generisch,
inkl. Regression: Overlap-Verlierer-Spans behalten ihre unbedeckten Reste —
ein langer C1-Adress-Span wird nie mehr komplett verworfen, nur weil ein
kurzer C0-Treffer in ihm liegt).

Recorded Validation-Run (2026-07-10, alle drei Detector-Sets × 6 Locales):
`middleware/packages/harness-plugin-privacy-guard/src/validation/RESULTS.md`
— de/en/it bestehen ALLE Gates auf `c0+c1`; es/fr/nl scheitern an
dokumentierten C0-Locale-Lücken (Beträge/Daten/Telefonformate). Flag-Policy
unverändert: Tabellen müssen vor dem Flag-Flip pro Locale auf Issue #361
gepostet sein.

### 10.x Setup-Felder der KI-Kennzeichnung (Epic #642 / #644)

Plugin-Setup-Felder des Orchestrators, **keine** Env-Variablen — gelesen in
`resolveAiDisclosureSetup` (`packages/harness-orchestrator/src/plugin.ts`):

| Feld | Werte | Wirkung |
|---|---|---|
| `ai_disclosure_level` | `standard` \| `concise` \| `off` | globale Stufe |
| `ai_disclosure_level_overrides` | `"telegram=concise,web=off"` | pro `ChannelKind` |
| `ai_disclosure_locale` | z. B. `de`, `en` | Sprache der Kennzeichnung |
| `ai_disclosure_assistant_name` | Freitext | Name in der Standardformulierung |
| `ai_disclosure_operator_note` | Freitext | wörtlicher Zusatz **hinter** der Zeile |

Auslieferungszustand ohne jedes gesetzte Feld: `standard`, aktiv,
`source: 'default'`. Drei Eigenschaften sind load-bearing:

- **Sobald EIN Feld gesetzt ist, ist die gesamte Policy operator-sourced** — erst
  das macht ein `off` überhaupt gültig. Ein Turn kann sich nicht selbst
  stummschalten.
- **Unbekannte Kanal-Tokens und Stufen werden mit einer Warnung verworfen.** Ein
  stiller Drop läse sich als "Kennzeichnung konfiguriert", wenn sie es nicht ist.
- **Nur `teams`/`slack`/`telegram` liefern heute pro Turn einen `channelKind`.**
  Ein Override für `email` oder `web` parst und wird angezeigt, wirkt aber nicht.
  `/health` und das Operator-Dashboard weisen seit #648 darauf hin.

Die aufgelöste Haltung ist ablesbar: `GET /health` → `disclosure`, plus
Boot-Warnung und Dashboard-Hinweis **nur** bei Abweichung vom Auslieferungszustand.

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

**Contract-Erweiterung — AI-Act-Kennzeichnung (Epic #642).** Der Ausgangs-Contract
trägt die KI-Kennzeichnung zusätzlich zum Antworttext:

- `SemanticAnswer.aiDisclosure` — strukturierter Marker (`text`, `level`, `locale`,
  `source`, optional `operatorNote`), liegt an **jedem** Turn an, solange der
  Betreiber die Kennzeichnung nicht auf `off` gesetzt hat. Auch am `done`-Event
  (`discloseDoneEvent`).
- `SemanticAnswer.text` — dieselbe Zeile wird beim **ersten** Turn eines Scopes in
  den Text gefaltet, damit sie auch Kanäle ohne Provenienz-Slot erreicht. `text`
  ist das einzige Feld, das jeder Connector rendern muss (`outgoing.ts:33`).
- Auf den beiden öffentlichen Egress-Pfaden zusätzlich maschinenlesbar: Header
  `X-AI-Generated: true` plus `provenance: { aiGenerated: true }` am `done`-Event
  (Public Chat API), `_meta["omadia.ai/provenance"]` am `tools/call`-Ergebnis
  (Public MCP). Der Header wird bei `flushHeaders()` gesetzt, also **vor** dem Turn
  — sonst fehlte er genau bei den Antworten, die mit einem Fehler enden.

Beide Felder sind additiv und optional im Sinne des Wire-Contracts: ein Client, der
sie nicht kennt, ignoriert sie, und NDJSON-Framing wie JSON-RPC-Envelope bleiben
rückwärtskompatibel. Vollständige Darstellung samt Grenzen:
[`ai-act-transparency.md`](ai-act-transparency.md).

`orchestrator.chatStream` ist ein Async-Generator. Text-Deltas stammen
aus `anthropic.messages.stream` (nicht `.create`). Tool-Use-Deltas werden
nicht weitergeleitet — stattdessen emittiert das `tool_use`-Event einmal
den vollen Input, sobald der Content-Block schließt.

### 11.1 Omadia UI — Canvas-Surface-Events (additiv)

Für die Omadia-UI-Canvas-Fläche (Spec: `byte5ai/omadia-ui` `CONCEPT.md` v0.15 /
`docs/implementation-plan.md`) wurde die SDK-Typ-Fläche **rein additiv**
erweitert. Bestehende Channels sind unberührt — sie deklarieren die neue
`'canvas'`-Capability nie und ignorieren die `surface_*`-Arme per Default
(kein exhaustiver `assertNever`-Consumer in der middleware). Konkret:

- **`ChatStreamEvent`** (`harness-channel-sdk/src/chatAgent.ts`) bekommt die
  `surface_*`-Familie via `| SurfaceStreamEvent` (`surface.ts`):
  `surface_snapshot`, `surface_patch`, `surface_data_ref_created`,
  `surface_data_ref_invalidated`, `surface_action_result`,
  `surface_local_action`, `surface_error`, `surface_mutation_resolved`. Jedes
  trägt `{ canvasSessionId, surfaceSeq }`; Revisions sind ein **opakes,
  branded `RevisionId`** (nur Gleichheit, keine Arithmetik); Bulk-Daten via
  `DataRef`.
- **`IncomingTurn`** (`incoming.ts`): additive `tenantId?` /
  `target?: TargetRef` / `viewState?: CanvasViewState` / `viewStateTruncated?`.
- **`SemanticAnswer.surface?: OutgoingSurface`** (`outgoing.ts`) +
  `ChatTurnResult.surface?` (`chatAgent.ts`), durchgereicht in
  `toSemanticAnswer`.
- **`TargetRef`** (neuer Shared-Typ in `@omadia/plugin-api`, `targetRef.ts`) —
  die kanonische Ziel-Adressierung (10 Varianten, Stable-IDs statt Positionen).
- Channel-Manifest-Enum **`ChannelCapability`** (`admin-v1.ts` +
  `manifestLoader.ts` `CHANNEL_CAPABILITIES`) bekommt `'canvas'`.

Noch **nicht** in diesem Schritt: Boot-Dispatch (`channel.dispatchService`),
die Canvas-Sentinel-Extractoren (`_pendingCanvasTree` etc.), das
`structured?`/`writeCapabilities`-Tool-Manifest und die zwei neuen Plugins
(`omadia-ui-orchestrator`, `omadia-ui-channel`) — separate Folge-PRs.

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

### KI-Kennzeichnung / Provenienz — offene Punkte (Epic #642)

Alles hier ist **nicht** umgesetzt. Vollständige Darstellung samt Codestellen:
[`ai-act-transparency.md`](ai-act-transparency.md).

- **C2PA für Bilder.** Im Baum existiert keine C2PA-Implementierung. Für
  gerenderte Diagramme wäre das der naheliegende nächste Schritt; heute trägt das
  PNG einen eigenen `iTXt`-Chunk, keinen C2PA-Manifest.
- **`.xlsx` gröber als `.docx`.** exceljs bietet keine verlässlichen
  benutzerdefinierten OOXML-Properties, deshalb fehlt der strukturierte
  `AIGenerated`-Flag. Ein Parser muss dort den Freitext der `category` auswerten.
  Behebbar nur durch Wechsel des Renderers oder Nachbearbeitung des ZIP.
- **Zwei Provenienz-Vokabulare.** Office und PNG benutzen `AIGenerated` /
  `Generator` / `ProvenanceStandard`, der API-/MCP-Envelope `aiGenerated`. Beide
  dokumentiert, aber ein Konsument muss beide kennen.
- **Per-Kanal-Overrides greifen nur auf `teams`/`slack`/`telegram`.** `email`,
  `web` und die kind-losen Kanäle tragen keinen `channelKind` in den Turn. Die
  Lücke ist gemeldet (#648), aber nicht geschlossen — dafür müsste
  `orchestratorDispatcher.toChannelKind` mehr Kanäle auflösen.
- **Fließtext-Kanäle bleiben ohne maschinenlesbare Markierung.** Teams, Slack,
  Telegram, WhatsApp bieten keinen Slot, und für reinen Text existiert kein
  Standard, den ein Empfänger auswerten würde. Kein offener Task, sondern eine
  Grenze, die benannt bleiben muss.

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

### Phase 13 — Cross-Channel Conversation Memory

Durable, user-scoped Conversation-Memory über Channel-Grenzen hinweg.
Treiber: omadia-ui-Orchestrator deklariert `requires:
crossChannelConversationMemory@1`. Use-Case ist die "S-Bahn → Büro"-
Continuity (Telegram unterwegs → Desktop-App im Büro nahtlos weiter).

Spec liegt als RFC unter [docs/cross-channel-memory.md](cross-channel-memory.md).
Kurzfassung:

- Zwei neue Capabilities: `platformIdentity@1` (ChannelUserRef → stabile
  userId) und `crossChannelConversationMemory@1` (append-only durable
  Conversation-Log pro userId, channel-agnostisch). Service-Registry-Keys
  sind bare names (`platformIdentity`, `crossChannelConversationMemory`),
  Capability-Refs mit `@major` nur im Manifest.
- Vier Plugins als Provider, je Neon + Inmemory-Sibling pro Capability;
  Mutual-Exclusion pro Capability — Operator wählt Neon für Prod,
  Inmemory für CI / Smoke / Local-Dev. Pattern analog
  `harness-knowledge-graph-neon` / `-inmemory`. Inmemory-Sibling ist
  explizit nur Single-Process; Multi-Pod-Setups erfordern Neon.
- Identity-Modell v1: Auto-Merge bei E-Mail-Gleichheit ist **opt-in pro
  Tenant** (`pi_auto_merge_on_email`, default `false`) und greift nur
  bei `email_verified=true`. Race-Sicherheit per `UNIQUE`-Index +
  `INSERT ... ON CONFLICT`. Shared-Mailbox, Recycled-Email und
  Email-Rename sind als Edge-Cases im RFC dokumentiert.
- Backward-compat: `ConversationHistoryStore` aus `harness-channel-sdk`
  bleibt unverändert. Neuer `DurableConversationHistoryStore`-Adapter
  fungiert als Bridge zur Capability; Channel-Plugins opten pro PR ein.
  Fehlt die Capability (CI / Dev), fällt der Adapter auf das bisherige
  `InMemoryConversationHistoryStore`-Verhalten zurück. Type-Bridge
  zwischen den zwei `ConversationTurn`-Shapes im SDK ist in §7.2 des
  RFC spezifiziert.
- `TurnContextValue` bekommt drei additive optionale Felder
  (`tenantId?`, `originatorUserRef?`, `originatorUserId?`) — landet in
  PR 4 zusammen mit dem Adapter und absorbiert die `tenantId`-Arbeit
  aus Phase 12.
- Persistenz raw, Egress-Redaction unverändert; optionaler
  Pre-Persist-Redaction-Hook pro Tenant (`ccm_redact_on_persist`).
  Lese-Default schließt Rows mit `redaction_state='pending'` aus.
  Privileged-Reads (`includeRaw=true`) sind admin-only und werden in
  einer eigenen `ccm_audit_events`-Tabelle persistiert — nicht über
  `ctx.notifications` (Cross-Channel-User-Fan-out, falsche Surface).
- Capacity: TTL 90 Tage (konfigurierbar), Per-User-Count-Cap 10000
  Turns, zusätzlich Per-User-Byte-Cap (~50 MB), `ccm-gc`-Cron mit drei
  Passes (TTL → count → bytes). Outbox-Tabelle plus separater
  `ccm-outbox`-Job für Late-Delivery bei transienten Schreibfehlern.
  Kein Score-Decay / Tier-Rotation — chronologisch, v2-Pfad offen.
- Observability: PluginContext hat heute kein Metrics-API; CCM betreibt
  einen plugin-internen Counter-Registry und exponiert `/ccm/metrics`.
  Wenn `ctx.metrics` kommt, migriert die Surface.

PR-Sequenz (additiv gegen `main`, **source-mergeable**; Deployment
gekettet, weil `requires` beim Boot enforced wird): docs-RFC (diese PR)
→ `platformIdentity@1`-Provider → `ccm@1`-Provider → Adapter im SDK
(plus `TurnContextValue`-Extension) → vier Per-Channel-Opt-in-PRs →
omadia-ui-Orchestrator-Consumer. Details + per-PR-Doc-Pflichten in §15
des RFC.

### Phase 14 — Admin-UI für Dataset-Upload/Schema/Delete (#430 Follow-up)

Der #430-Scope (CSV-Import + `query_dataset`-Tool, siehe §3 und §7) deckt
absichtlich **keine** Admin-UI ab — Upload/Schema-Browse/Delete bleibt
API-only (`POST/GET/DELETE /api/v1/datasets*`, siehe §3). #430's eigene
Triage-Acceptance-Criteria verlangen aber genau diese UI; der Branch
schließt das Issue deshalb NICHT, sondern "addresses" es — ein
Folge-Issue für die Admin-UI-Seite (`web-ui/app/admin/datasets/` o.ä.,
Upload-Dropzone + Schema-Tabelle + Zeilen-Preview + Delete-Bestätigung,
Pattern analog zur bestehenden Package-Upload-Seite) ist offen zu
erfassen.

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
