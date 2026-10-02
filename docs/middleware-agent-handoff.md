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
  - `get_chat_participants` (unser eigenes Tool, **nur auf Turns mit
    Roster-Provider** — seit #1108, siehe Unterabschnitt unten)
  - Eine DomainTool-Instanz pro Sub-Agent (`query_odoo_accounting`,
    `query_odoo_hr`, `query_confluence_playbook`)
- **Methoden:** `chat()` blockierend, `chatStream()` als Async-Generator
  mit `ChatStreamEvent`-Events. Beide scopen ihren Turn via
  `turnContext.run` bzw. `turnContext.enter` für EntityRef-Korrelation.
- **System-Prompt:** Spricht Deutsch, liest zu Turn-Start `/memories/_rules`,
  nutzt Session-Transkripte nur auf Rückbezug, persistiert Learnings
  früh (im nächsten Tool-Call, nicht am Ende).

### `get_chat_participants` — per-Turn-Roster-Gating (#1108)

- **Datei:** `packages/harness-orchestrator/src/tools/chatParticipantsTool.ts`.
- **Rolle:** Liefert dem Modell die Teilnehmer des aktuellen Chats für
  `<at>…</at>`-Mentions. Der Roster-Provider wird **pro Turn** vom Channel
  verdrahtet (nur Teams / Telegram-Gruppen mit Admin-Rechten führen einen).
- **Gating (der Kern von #1108):** Die Tool-Instanz wird einmalig gebaut und
  ist kanal-unabhängig — daher wird das Tool **nicht** an der Instanz, sondern
  am Live-Provider gegatet. `Orchestrator.turnHasChatRoster()` prüft
  `turnContext.current()?.chatParticipants` und wird an **beiden** Advertise-
  Stellen konsultiert: `buildToolsList()` (Tool-Specs) und der
  `buildSystemPrompt`-Aufruf (`hasChatParticipants`-Roster). Ein Kanal ohne
  Roster zeigt das Tool nirgends. Vorher wurde es auf jedem Kanal angeboten und
  gab bei Fehltreffern einen englischen `Error:`-String zurück, den der Privacy
  Shield (#1097) internierte und das Modell als Roster rendern ließ.
- **Miss-Kontrakt:** Jeder "kein Roster"-Zweig des Handlers liefert ein
  strukturiertes, deutsches Nicht-Fehler-Ergebnis der Form
  `{ participants: [], reason, note }` — nie einen `Error:`-String. Die drei
  `reason`-Codes sind exportierte Konstanten: `no_roster_on_this_channel`
  (kein Provider), `roster_empty` (Provider vorhanden, leer — der
  Telegram-Admin-Only-Fall) und `roster_fetch_failed` (Provider warf; der rohe
  Fehler wird geloggt, aber **nicht** ins kanal-sichtbare Ergebnis gehängt).
- **Verwandt:** das generische Readiness-Gate (#474, Unterabschnitt unten)
  gilt für Plugin-Tools mit `agentId`; `get_chat_participants` ist
  kernel-intern und wird stattdessen am Turn-Roster gegatet.

### `find_free_slots` + `book_meeting` — M365-Kalender-Tools (#1214)

- **Dateien:** `packages/harness-orchestrator/src/tools/findFreeSlotsTool.ts`
  (Slot-Suche via Microsoft Graph `findMeetingTimes` + Slot-Card) und
  `.../bookMeetingTool.ts` (Kalendereintrag auf einen zuvor gefundenen Slot).
  Beide hängen an `hasCalendar` in `buildSystemPrompt`.
- **Arbeitsteilung Prompt ↔ Tool-Beschreibung (der Kern von #1214):** Der
  `calendarBlock` im System-Prompt ist bewusst **eine** Zeile und trägt nur,
  was keine Tool-Beschreibung tragen kann: (a) das Routing — Termin-, Slot-
  und Verfügbarkeitsanfragen gehen an diese Tools, auch wenn der User sie wie
  eine Nachricht formuliert ("schicke X drei Vorschläge"); (b) den
  Cross-Tool-Hop — Namen erst über einen Personen-/HR-Fach-Agenten zu Emails
  auflösen; (c) die 1-Satz-Zusammenfassung der Slots im Antworttext; (d) den
  `consent_required` / `sso_unavailable`-Hinweis, dessen OAuthCard das System
  anhängt. **Alles andere — Host-Logik (`hostEmail` nur bei Suche im Auftrag
  Dritter), `durationMinutes` 15–480, `windowDays` 1–14 Default 5, „bereits
  gebuchte Termine ansehen ist nicht implementiert" — steht ausschließlich in
  der Tool-Beschreibung und wird im Prompt nicht dupliziert.**
- **Warum:** Der alte Block schrieb „egal wie die Formulierung lautet — RUFE
  `find_free_slots`" plus Pflicht-Schritte mit „Default 30 min wenn User keine
  Dauer nennt". Die Tool-Beschreibung sagt das Gegenteil (`durationMinutes`
  ist Pflichtfeld; „keine konkreten Teilnehmer oder Dauer → zuerst klären"),
  und die Host-Logik stand doppelt. Ein Widerspruch zwischen Prompt und
  Tool-Kontrakt ist durch keinen weiteren Prompt-Text zu reparieren, und
  „egal wie — RUFE X"-Booster stammen aus einer Modell-Generation, die
  *unter*getriggert hat; die aktuellen Modelle übertriggern damit.
- **Regel für künftige Änderungen:** Parameter-Defaults und Grenzwerte gehören
  in die Tool-Beschreibung, nicht in den System-Prompt. Nur echte
  Cross-Tool-Orchestrierung (wie der HR-Agent-Hop) gehört in den Prompt.

### Turn-Owner-Guard für den Subscription-CLI-Pfad (`routineTurnOwnerGuard`, #1016)

Neue Kernel-Service-Registrierung neben `installedPluginConfigReader` und
`installedPluginToolsReadyReader`: `serviceRegistry.provide('routineTurnOwnerGuard',
createRoutineTurnOwnerGuard())` in `middleware/src/index.ts`. Der
Orchestrator-Plugin **deklariert** sie in seinem Manifest unter
`optional_requires: ["routineTurnOwnerGuard@1"]` und löst sie per
`ctx.services.getOptional` auf; `buildOrchestratorForAgent` reicht sie als
`turnOwnerGuard` in `CliChatAgent` weiter.

Warum nicht als Default im Orchestrator-Package: der Guard liest
`routineTurnContext`, und der Store liegt in der App-Schicht. Deshalb Service
statt Konstante.

**Die Deklaration ist Pflicht, nicht Dokumentation.** `getOptional` ist genauso
deklarations-gated wie `get`: `assertServiceGranted` wirft
`ServiceNotDeclaredError` für jeden Namen, der in keinem der drei Blöcke steht.
Der Unterschied zwischen den beiden Verben ist der angekündigte Vertrag, nicht
das Lookup. Der Aufruf liegt oben in `activate()`, also
scheitert ohne Deklaration die Aktivierung bei **jedem** Boot, `chatAgent@1`
wird nie publiziert, und jeder Channel mit `requires: ["chatAgent@^1"]`
überspringt seine Aktivierung. `optional_requires` (nicht `requires`), weil ein
Host ohne diesen Service weiter booten muss. Die Legacy-Allowlist ist
ausdrücklich nicht der Weg: ihr Docblock erklärt sie zum geschlossenen,
datierten Satz, in dem jede neue Zeile eine Regression ist.

Was er tut: Kanal-Adapter setzen den Routine-Kontext mit `enterWith` — ohne
Scope-Exit. Ein Async-Chain, der einen neuen Turn beginnt, ohne
`captureRoutineTurn` erneut zu rufen, trägt noch die `(tenant, userId)` des
vorherigen Turns. Seit #993 überquert dieser Kontext die Prozessgrenze zur CLI,
also hieße Staleness dort **als vorheriger Principal handeln**. Der Guard läuft
im wiederhergestellten Kontext direkt vor dem Dispatch und vergleicht dessen
`userId` mit der des laufenden Turns; beide schreibt derselbe Adapter aus
derselben Quelle. Kein Kontext ⇒ Durchlass (`manage_routine` verweigert dort
schon selbst), Kontext ohne belegbaren Turn-Owner ⇒ Verweigerung, Mismatch ⇒
Verweigerung. Nur der CLI-Pfad, der In-Process-Pfad ist unberührt. Hosts ohne
diesen Service verhalten sich wie vor #1016.

### CLI-Binary-Auflösung für alle Spawn-Sites (`cliBinaryResolver`, #1085)

Zweite Kernel-Service-Registrierung nach demselben Muster:
`serviceRegistry.provide('cliBinaryResolver', (bin) => resolveCliBin(bin))` in
`middleware/src/index.ts`, deklariert im Orchestrator-Manifest unter
`optional_requires: ["cliBinaryResolver@1"]`, aufgelöst per
`ctx.services.getOptional`, weitergereicht von `buildOrchestratorForAgent` als
`resolveCliBinary` in `CliChatAgent`. Die Deklarationspflicht und die
Legacy-Allowlist-Regel aus dem Abschnitt oben gelten unverändert;
`test/cliBinaryResolverGrant.test.ts` pinnt Konstante, Literal und Manifest
gegeneinander.

Warum nicht als Default im Orchestrator-Package: `resolveCliBin` liest
`CLI_TOOLS_DIR` / `PLATFORM_DATA_DIR` und das Verzeichnis, in das der
"Install now"-Button der Admin-UI installiert — App-Schicht, die dieses Package
nicht importieren darf. Genau deshalb existierte vorher ein zweites
`const DEFAULT_CLI_BINARY = 'claude'`, und der Turn spawnte das Binary aus
`PATH`, während Version-Badge und Install-Button das aus dem Install-Verzeichnis
beschrieben. Die Folge war kein Fehler, sondern eine unsichtbar degradierte
Grenze: die Versions-Probe lief gegen das falsche Binary, `--restricted` fiel
weg (`supportsRestrictedFlag`, ≥ 2.1.248), und die UI meldete trotzdem "logged
in and ready".

Zwei Regeln, die beim Erweitern zählen:

- **Pro Turn auflösen, nie einmal beim Bauen.** `resolveCliBin` prüft das
  Dateisystem beim Aufruf — ein beim Konstruieren aufgelöster String verpasst
  genau die Installation, die der Operator gerade angestoßen hat. Deshalb ist
  der Dep eine Funktion (`() => string`), kein `string`.
- **Jede Spawn-Site einzeln.** `createCliSubAgent` baut seine eigenen
  `CliChatAgentDeps` und erbt nichts vom Chat-Agent, also bekommen
  `ask_<slug>`-Sub-Agents, Agent-Builder und Preview-Chat die Regel explizit
  gereicht (kernel-seitig über `resolveClaudeCliBin()` aus
  `src/platform/cliBinary.ts`, im Package über `SubAgentToolDeps`). Ein Test in
  `cliBinaryResolverGrant.test.ts` scannt die Call-Sites und schlägt fehl, wenn
  eine neue es vergisst.

Verwandt: `cliInstallService` leert nach erfolgreicher Installation **beide**
Caches — den Detector-Snapshot (`__resetCliBackendCache`) und die
Versions-Probe des Spawn-Gates (`clearCliVersionCache`). Bei einem In-Place-
Update ändert sich der Binary-Pfad nicht, also bliebe der Cache-Key sonst
gleich und der Turn liefe bis zu fünf Minuten weiter gegen die alte Version.

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
unabhängig nach, da sie ohne Orchestrator-Instanz läuft. Auf dieser Bridge gibt
es zusätzlich ein Gate auf der Spawn-Seite: `CliChatAgent` startet die CLI mit
`--tools ""`, `--disallowedTools`, `--permission-mode dontAsk`,
`--setting-sources ""` und `--system-prompt`, damit die eingebauten CLI-Tools
(Bash, Edit, Write, …) und die `~/.claude`-Hooks des Host-Users nie erreichbar
sind (#991/#992; Details in `docs/security-architecture.md` § 3a).

Seit #1007 liegt dieses Gate in **einem** Modul,
`packages/harness-orchestrator/src/cliSpawnGate.ts`
(`buildCliToolGateArgv`, `buildCompletionCliArgv`, `buildGatedCliEnv`,
`CLI_BUILTIN_TOOL_DENYLIST`), und wird von **beiden** Spawn-Stellen benutzt:
`cliChatAgent.ts` (Shape 3) und `platform/claudeCliAdapter.ts` (Shape 2,
Single-Shot-Completions für Session-Summary, Fact-Extraction, Classifier,
Verifier-Judge). Letztere hatte das Gate nicht und war die exponiertere von
beiden, weil ihre Prompts aus Nutzertext und Uploads zusammengesetzt werden.
Wer eine neue Spawn-Stelle baut, importiert dieses Modul und kopiert die Flags
nicht. Dazu kommen ein leeres `cwd` (die CLI-eigene `CLAUDE.md`-Discovery ist
hartkodiert und nur über `--bare` abschaltbar, was aber OAuth nicht mehr liest)
und eine Env-**Allowlist** statt der alten Scrub-Liste, die `NODE_OPTIONS`
durchgelassen hat.

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

Mit aktivem Answer-Verifier sitzt `VerifierService` vor dem Orchestrator
(`User → VerifierService.chatStream/chat → Orchestrator`): in `shadow` prüft er
nur und hängt das Urteil an, in `enforce` ist er ein Auslieferungs-Gate — der
Stream hält jeden Inhalt bis zum Urteil (der Canvas-Composer sein Skeleton
ebenso), eine nicht bestätigte Antwort wird durch eine Notiz ersetzt (§11,
Kontrakt-Erweiterung Verifier-Gate). Agenten auf dem Abo-CLI-Runtime und
Routinen laufen ohne diesen Wrapper.

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
   Ausnahme Answer-Verifier in `enforce` (Basis-Agent mit
   `holdsContentUntilVerdict`): dann wartet das Skeleton auf das Urteil und
   geht nur mit einem freigegebenen Turn raus (`src/verdictHold.ts`, §11
   Verifier-Gate).
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
  schließt Live-Sockets). `attach(server)` hängt sich an
  `server.on('upgrade')`. Die Registry bleibt der **einzige** `upgrade`-Listener
  des Prozesses, delegiert aber seit Epic #746 W1-1 über eine **Routen-Tabelle**
  (Pfad → Route) mit zwei Arten; unbekannter Pfad → `404` + `destroy`:
  - **Channel-Routen** (`register`, für Plugins nur via
    `CoreApi.registerWebSocket`): Session-Cookie + Whitelist-Auth, Active-Gate
    (`503`), `ChannelSocket`-Wrapper, gemeinsamer `ws.Server` mit
    `maxPayload = CHANNEL_WS_MAX_PAYLOAD_BYTES` (**32 MiB**, vorher ws-Default
    100 MiB). Herleitung: größter gültiger Canvas-Frame `canvas_list_put` =
    50 × 262_144 Zeichen ≈ 12,5 MiB ASCII; der Desktop-Client kappt vor dem
    Senden nicht, daher ~2,5× Reserve gegenüber diesem ASCII-Worst-Case. Das
    Limit zählt UTF-16-Code-Units, nicht Bytes: eine maximale Liste aus reinem
    3-Byte-UTF-8-Text (~37,5 MiB) läge über dem Cap. Frame über dem Cap →
    Close `1009`.
  - **Kernel-Routen** (`registerKernel(path, { authenticate, maxPayload, handler })`,
    **nur Kernel-Code**, nicht auf `CoreApi`): eigener
    `WebSocketAuthenticator<T>` (läuft **vor** dem `101`; `ok:false` → rohes
    `401`/`403`; Exception, Nicht-Ergebnis oder verpasste Deadline
    `authTimeoutMs` (Default 10 s) → `503` fail-closed, `console.error` mit
    Stack — ein Key-Store-Ausfall liest sich so nicht als „Credential
    abgelehnt"), **Pflicht**-`maxPayload` (positiver Integer ≤ `2^31 − 1`, weil
    `ws` `maxPayload | 0` speichert und 2^31+ still „unbegrenzt" hieße;
    eigener `ws.Server` pro Route), Handler bekommt den rohen `ws`-Socket
    (Ping/Pong, Binär-Frames, Backpressure) + Principal. Unabhängig vom
    Channel-Lifecycle: `deactivateChannel` schließt keine Kernel-Sockets.
    Erster Consumer: `/api/v1/satellites/ws` (W1-2).
  - Pfad-Kollision Kernel↔Channel (beide Richtungen) und doppelte
    Kernel-Registrierung werfen.
  - Jeder akzeptierte Socket hat einen `'error'`-Listener: `ws` emittiert
    `'error'` bei Protokollverletzungen (inkl. `maxPayload`-Überschreitung);
    ohne Listener war das eine uncaught exception, die nur `processGuards`
    abfing.
- **Auth — vor dem Upgrade, nicht danach.** Der `upgrade`-Request trägt das
  Session-Cookie (`omadia_session`) in `req.headers.cookie`. Die Registry parst
  es selbst (beim rohen `upgrade` läuft **kein** `cookie-parser` davor; ein
  kaputtes `%`-Escape ist ein normales `401`) und ruft seit W1-1
  `evaluateSessionToken` aus `requireAuth.ts` — **derselbe Code-Pfad wie
  `requireAuth`**, keine Handkopie mehr, die driften könnte.
  Fehlt/ungültig → rohes `401` + `socket.destroy()` **vor** dem `101`; für einen
  unauthentifizierten Peer wird kein WebSocket allokiert. Nur authentifizierte
  Upgrades werden zu `ChannelSocket`s; die verifizierten `ChannelSessionClaims`
  (`subject`/`email`/`displayName`/`provider`/`omadiaUserId?`/`expiresAt`) gehen
  an den Handler — **nie das Token**: das bleibt in der Registry, und das
  Session-Cookie wird aus `socket.request.headers.cookie` entfernt (andere
  Cookies bleiben). Zusätzlich der **gleiche Entra-Whitelist-Gate** wie `requireAuth`:
  eine OIDC-(`entra`)-Session mit nicht (mehr) whitelisteter E-Mail → `403`
  (Auth-Parität zu den HTTP-Routes; der `EmailWhitelist` wird mitinjiziert).
  (Hinweis: `CoreApi.resolveIdentity` ist channel-natives User-Mapping,
  **nicht** Session-Auth — daher die Session-Evaluation von `requireAuth`.)
  Nach der asynchronen Cookie-Prüfung wird das Active-Flag **erneut** geprüft:
  ein `deactivateChannel` im Auth-Fenster führt zu `503` statt zu einem Socket,
  der an `deactivateChannel` vorbeigerutscht ist.
- **Lebensdauer nach dem Upgrade** (`src/channels/channelSessionLifetime.ts`,
  `ChannelSessionTracker`): ein Channel-Socket lebt nicht länger als die
  Sitzung, die ihn geöffnet hat.
  - Am `exp` des Tokens → Close **4401** `session expired`. Ein Token ohne
    `exp` oder eines, das zwischen Upgrade-Prüfung und Handshake abläuft, wird
    mit 4401 geschlossen, **bevor** der Handler läuft; ein Frame nach `exp`
    wird verworfen, eingehend wie ausgehend (`socket.send` des Handlers), auch
    wenn der Timer spät dran ist — `exp` ist Wanduhrzeit, die Wanduhr
    entscheidet.
  - Widerruf auf dieser Replica: `SessionRevocation.onRevoked` (Logout,
    Passwort-Reset, Deaktivieren, Löschen, siehe „Serverseitiger
    Sitzungs-Widerruf“ in §3) schließt die Sockets des Users sofort mit **4403**
    `session revoked`. `WebSocketRegistry.closeSessions(match)` ist derselbe
    Hebel für andere Kernel-Pfade. Ein `announce`, das während der
    Upgrade-Prüfung eintrifft, findet noch keinen Socket: die Registry merkt
    sich davor den Widerrufszähler (`ChannelSessionTracker.mark()`), und
    `accept` schließt mit 4403, **bevor** der Handler läuft
    (`RevocationLog` in `src/channels/channelSessionCheck.ts`). Das Log hält
    die letzten 256 Ankündigungen (`RECENT_REVOCATIONS_KEPT`); kamen während
    einer Upgrade-Prüfung mehr, lässt sich ein Widerruf dieses Users nicht
    ausschließen → Close **1013** `session unverified`, ebenfalls **bevor**
    der Handler läuft, und der Reconnect des Clients wird frisch geprüft.
    Nicht „erst beim ersten Frame prüfen“: Arbeit beim Verbindungsaufbau und
    Pushes des Handlers brauchen keinen Frame.
  - Widerruf auf anderen Replicas — **der nächste Frame**: `announce` ist
    prozesslokal, deshalb wird jeder eingehende Frame einzeln geprüft. Er
    erreicht den Handler nur auf einem Urteil, dessen Prüfung höchstens
    `WS_SESSION_FRAME_RECHECK_MS` (Env, Default 5 s, 0 = jeder Frame) vor
    seiner Ankunft begann; die Upgrade-Prüfung zählt mit. Ist das Urteil
    älter, wartet der Frame (und jeder dahinter, in Reihenfolge), bis
    `evaluateSessionToken` (derselbe Pfad wie HTTP) erneut gelaufen ist; der
    Socket liest so lange nicht weiter (`ws.pause()`, TCP-Backpressure statt
    wachsendem Puffer). Widerrufen → 4403 `session revoked`, Entra-Whitelist
    entzogen → 4403 `session forbidden`, Token nicht mehr gültig → 4401; die
    wartenden Frames verfallen. Prüfbeginn und Frame-Ankunft misst der
    Tracker mit einer monotonen Uhr (`performance.now`, injizierbar als
    `monotonicNow`): ein Zurückstellen der Wanduhr (NTP, VM-Resume) kann ein
    Urteil nicht über die Grenze hinaus strecken.
  - Leerlauf: ein Sweep alle `WS_SESSION_RECHECK_MS` (60 s) prüft jeden
    offenen Socket genauso. Das begrenzt, was ein Socket ohne eigene Frames
    noch bekommt (Notification-Pushes).
  - Kein Urteil, kein Frame: `auth.unavailable` (DB-Ausfall), ein Wurf und
    eine verpasste Deadline (`WS_SESSION_CHECK_TIMEOUT_MS`, 10 s) sind kein
    Urteil — der Socket bleibt offen (begrenzt durch `exp`; Pings beantwortet
    er wieder, sobald der Check aufgegeben hat), aber die wartenden Frames
    erreichen `onMessage` nicht, sondern `onRefusedMessage` (das
    WS-Gegenstück zu HTTP 503). Ein Ausfall beendet auch die Gnadenfrist des
    Urteils davor, der nächste Frame prüft neu; eine Ablehnung, die erst nach
    der Deadline kommt, schließt trotzdem. Sweep und Frames teilen sich einen
    Check pro Socket.
  - Ab dem Close erreicht kein Frame mehr den Handler, seine Sends werden
    verworfen, und sein `onClose` feuert sofort (nicht erst nach dem
    Close-Handshake des Peers).
  - Ein `/renew` verlängert das Cookie, **nicht** den offenen Socket; der
    Client verbindet sich mit dem aktuellen Cookie neu. Renewal bewegt die
    Session-Version nicht, der Socket bleibt also bis zum `exp` seines Tokens
    offen.
  - Kernel-Routen bekommen nichts davon: ihr Principal ist für die Registry
    opak, eine Kernel-Route muss Ablauf und Widerruf ihres Credentials selbst
    durchsetzen.
- **Wiring** (`index.ts`, per `grep -n WebSocketRegistry src/index.ts` finden —
  Zeilennummern driften): `new WebSocketRegistry({ signingKey:
  sessionSigningKey, whitelist: emailWhitelist, sessions: sessionRevocation })`
  vor `createCoreApi({ … webSockets })`, zusätzlich an die `DefaultChannelRegistry`
  gereicht (Lifecycle-Spiegel zu `routes`), und
  `webSocketRegistry.attach(server)` nach `const server = app.listen(PORT, '::')`
  — dasselbe `http.Server`, der Dual-Stack-`::`-Bind serviert WS mit. Über
  `sessions` (derselbe `SessionRevocationGuard` wie `requireAuth`) kommen sowohl
  der Upgrade-Check als auch `onRevoked`, die Frame-Prüfung und der Sweep.
  `channelFrameRecheckMs` kommt aus `config.WS_SESSION_FRAME_RECHECK_MS`;
  `channelMaxPayloadBytes`, `channelSessionRecheckMs` und
  `channelSessionCheckTimeoutMs` bleiben in Prod ungesetzt, also greifen
  32 MiB, 60 s bzw. 10 s; nur Tests setzen kleinere Werte. Der
  Channel-Authenticator selbst (`authenticateChannelSession`, Cookie-Parsing,
  Entfernen des Session-Cookies aus den Handler-Headern) liegt in
  `src/channels/channelSessionAuth.ts`.
- **Dependency:** `ws` + `@types/ws` nur im Kernel, nicht im SDK.

Test: `test/webSocketRegistry.test.ts` fährt einen echten `http.Server` + echten
`ws`-Client (authentifizierter Upgrade → Claims + Echo-Frame; ohne Cookie →
`401`; unbekannter Pfad → `404`; deaktivierter Channel → `503`; seit W1-1
zusätzlich: Kernel-Route ignoriert Cookies und nutzt ihren Authenticator,
`401`/`403` ohne `101`, `maxPayload` pro Route mit `1009` ohne
uncaught exception, Kernel↔Channel-Pfadkollision wirft, `deactivateChannel`
lässt Kernel-Sockets offen, 32-MiB-Default; Statuscodes werden exakt geprüft,
nicht per `|unexpected server response`). `test/webSocketRegistryHardening.test.ts`
deckt `503` bei Exception/Deadline/Nicht-Ergebnis (auch ein spätes `ok` nach
der Deadline öffnet nichts), die rohen Status-Line-Bytes bei CR/LF im
`message`, die Grenzen für `maxPayload`/`authTimeoutMs`/`channelMaxPayloadBytes`/`channelSessionRecheckMs`,
das kaputte Cookie-Escape und das Deaktivieren im Auth-Fenster ab. Die
Lebensdauer prüfen `test/webSocketRegistrySession.test.ts` (echte Sockets:
4401 am `exp`, Token ohne `exp` bzw. im Upgrade abgelaufen, Claims ohne Token,
`closeSessions`, Widerruf per `announce` und per Sweep, Whitelist-Entzug,
Ausfall hält Frames zurück, schließt aber nicht, keine Timer/Re-Checks nach
Close oder Deaktivierung), `test/webSocketRegistryFrameGate.test.ts` (echte
Sockets: Widerruf auf einer anderen Replica stoppt den nächsten Frame samt
den dahinter wartenden, `announce` während der Upgrade-Prüfung schließt vor
dem Handler, mehr Ankündigungen als gehalten → 1013 vor dem Handler und der
Reconnect klappt, fehlgeschlagener bzw. hängender Lookup hält Frames zurück
und der Socket beantwortet weiter Pings, Grenze 0 prüft jeden Frame),
`test/channelSessionTracker.test.ts` (Mock-Timer: exakt am `exp`, später
Timer für ein- und ausgehende Frames, setTimeout-Obergrenze, Verdict-Mapping),
`test/channelSessionFrameGate.test.ts` (Mock-Timer: Frame-Grenze und
Default, Reihenfolge, Backpressure, Ausfall und Deadline, späte Ablehnung,
Upgrade-Fenster samt Überlauf, zurückgestellte Wanduhr), `test/uiChannelSessionRefusal.test.ts` (was der Canvas mit
einem zurückgehaltenen Frame macht), `test/uiChannelSessionGate.test.ts`
(Canvas an einer echten Registry: ein Turn nach einem Widerruf anderswo
startet nie, im Ausfall gibt es `turn_error` und der Socket bleibt) und
`test/auth/liveSocketRevocation.test.ts` (echte Auth-/Admin-Router:
`/renew` lässt den Socket offen, Logout und Deaktivieren schließen ihn).
Gemeinsame Fixtures: `test/_helpers/wsRegistryKit.ts`. Damit ist der
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
     Das Ack trägt `sessionExpiresAt` (Epoch-Sekunden, aus
     `session.expiresAt`), wann der Kernel den Socket mit 4401 schließt —
     additiv und optional, also ohne Protokoll-Versionssprung.
     **Client-Vertrag:** vor diesem Zeitpunkt den User warnen (Verlängern
     bleibt ein expliziter Klick, wie im `SessionWatcher`), bei 4401 mit dem
     aktuellen Cookie neu verbinden (ein 401 auf diesem Upgrade heißt neu
     anmelden), bei 4403 aufhören. `@omadia/canvas-core` 0.2.0 setzt das um:
     `CanvasSocket` meldet bei 4401 `unauthenticated`, bei 4403 `forbidden`,
     beides ohne Backoff-Schleife; der Host verlängert bzw. meldet neu an und
     ruft `connect()`. Bis dahin öffnet nichts anderes einen Socket:
     `switchCanvas()` merkt sich nur die Canvas, die das nächste `connect()`
     fortsetzt (ein Reopen mit dem beendeten Cookie scheitert schon vor dem
     Upgrade und sähe für den Client wie ein Netzabbruch aus, also wieder
     Backoff). `cookie` darf eine Funktion sein, die bei jedem Connect
     das aktuelle Cookie liefert. Der Stub-Server (`tools/stubServer.ts`) kann
     `sessionExpiresAt` senden und mit `closeSockets(4401 | 4403, …)` beide
     Closes simulieren. Kann der Kernel die Sitzung gerade nicht prüfen
     (DB-Ausfall, siehe PR-11-Abschnitt), läuft ein zurückgehaltener Frame
     nicht: ein `turn`/`canvas_refresh` bekommt `turn_error` `session check
     unavailable, try again`, ein `turn_abort` stoppt den laufenden Turn
     trotzdem, und auf ein zurückgehaltenes `handshake_select` folgt statt
     des Acks ein Close **1013** — der Client verbindet im normalen Backoff
     neu, durch eine frische Upgrade-Prüfung.
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
     Schließt der Socket (auch weil der Kernel die Sitzung beendet), bricht
     `onClose` den laufenden Turn ab (der Orchestrator-Generator wird per
     `return()` abgewickelt), und in der Kette wartende Turns starten nicht
     mehr.
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
`metadata`, malformed `action` → `turn_error`; `sessionExpiresAt` im Ack nur mit
`session.expiresAt`; Close bricht den laufenden Turn ab und startet keinen
wartenden). Real-Socket-Pfad ist durch PR-11s
`webSocketRegistry.test.ts` abgedeckt; die Client-Seite des Lebensdauer-Vertrags
durch `packages/canvas-core/test/canvasSocketSession.test.ts` und
`canvasSocket.test.ts`. **Damit kann der Agent live UI über den
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
- `GET /api/v1/datasets` — paginierte Liste der eigenen Datasets
  (`limit`/`offset` via zod, 400 bei ungültiger Query; Response
  `{ items, totalMatched }` — `totalMatched` fehlt nur, wenn die
  Graph-Implementierung das optionale `countDatasets` noch nicht kennt).
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

**Link-Keys + Cross-File-Dedup** (`datasetLinkKey.ts`): der Import maskiert
irreversibel und dateiabhängig, und der C0-Detektor erkennt keine Namen — zwei
Uploads derselben Personen hatten also kein gemeinsames Identitätsmerkmal mehr.
Deshalb bekommt jede `string`-Spalte eine Schlüsselspalte `__k_<Spalte>` =
`HMAC-SHA256(secret, ownerOmadiaUserId ‖ "\n" ‖ normalize(raw))`, 16 Hex-Zeichen
mit garantierter Ziffer, damit der v4-Shape-Classifier sie über die S5-`id`-Regel
als `safe-cleartext` freigibt. Der Rohwert verlässt `buildDatasetFromTable` nie.
Secret: `DATASET_LINK_KEY_SECRET`, sonst HKDF aus `VAULT_KEY`; fehlt beides,
gibt es keine Key-Spalten und der `[dataset-imported]`-Block sagt das. Header im
`__k_`-Namensraum werden beim Import abgewiesen; `query_rows`-`filters` auf
`__k_*` sind server-seitig gesperrt (Oracle-Schutz). Die Privacy-Shield-Verben
`v4_union` (mit `renameRight`) und `v4_distinct` (`by`, `keep`) vereinen zwei
`query_rows`-Seiten oder Dateien und kollabieren auf den Link-Key; Prompt-Regel
d) im `privacyV4Block` trägt das Rezept. `POST /api/v1/datasets` liefert je
Tabelle `linkKeys.columns`.

**PII-Zellen verschlüsselt at rest** (`datasetCellCrypto.ts`): geflaggte
Zellen werden nicht mehr irreversibel maskiert, sondern als `enc1:…`
(AES-256-GCM, Schlüssel = HKDF aus demselben Dataset-Secret, AAD = Owner +
Spalte) gespeichert. `query_dataset` entschlüsselt **nur**, wenn der Turn ein
`privacyHandle` trägt (⇒ Ergebnis wird interniert, Modell bekommt Digest,
Render/Excel liefern echte Werte); ohne Guard wird auf dem Lesepfad neu
maskiert (ein Pseudonym-Map pro Seite). Owner-Rows-Route entschlüsselt.
Schema-`sample` bleibt der Surrogat. Ohne Secret: altes irreversibles Masking,
Fakt im `[dataset-imported]`-Block sagt es. Secret-Rotation macht Alt-Zellen
unlesbar (`[verschlüsselt — Schlüssel nicht verfügbar]`). Der v4-Shape-Classifier
läuft seitdem mit den **Identitäts**-Typen des C0-Baseline (E-Mail, IBAN,
Telefon, Adresse, ID-Nummer — nicht `date`/`amount`) als `detector`-Booster
(Telefonnummern-Spalte wäre sonst ein safe `id`-Handle; Datums-/Betragsspalten
bleiben filterbar). `privacyScan.encryptedAtRest` je Tabelle. Grenzen: die
`query_rows`-DSL (`eq`/`contains`/`group_by`) arbeitet auf verschlüsselten
Spalten über Ciphertext (jede Zelle unterschiedlich, frischer IV) — Filtern
nach E-Mail funktioniert dort nicht; dafür sind die `__k_*`-Link-Keys da.
Schlägt das Internieren einer `query_dataset`-Seite fehl, hält der
Orchestrator die Zeilen **zurück**, weil sie Klartext tragen. Seit #1267 gilt
das für jedes Tool an jeder Naht (`internFailedNotice`, Abschnitt
„Unterhalb des Ledgers“); `query_dataset` behält seinen eigenen Text.

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

**`dataset_id`-Validierung (#1093):** `datasets.id` ist eine `uuid`-Spalte,
also wirft Postgres `22P02` (`invalid input syntax for type uuid`), **bevor**
das `owner_omadia_user_id`-Prädikat desselben Statements ausgewertet wird —
kein Caller kann das als "not found" abfangen, die ACL maskiert es nicht. Das
Modell liefert genau solche ids: der Privacy-Shield-Digest übergibt eine
`ds_<uuid>` (turn-scoped In-Memory-Dataset, **anderer** Id-Raum als die
hochgeladenen Datasets), und Digest wie System-Prompt fordern das Modell
ausdrücklich auf, eine `datasetId` an andere Tools weiterzureichen
(`create_xlsx` nimmt genau diese). Drei Dataset-Schichten seitdem, dazu eine
generische:

1. `queryDatasetTool.ts` normalisiert `dataset_id`, bevor der Graph überhaupt
   gerufen wird — `normalizeDatasetUuid` (`plugin-api/src/datasetId.ts`, von
   Tool **und** Neon-Schicht benutzt, damit beide denselben Id-Raum sehen)
   akzeptiert jede Schreibweise, die Postgres selbst für `uuid` annimmt
   (Großbuchstaben, Klammern, fehlende Bindestriche) und liefert die
   kanonische Form. `ds_`-Präfix ⇒ eigene Fehlermeldung
   (`Error: privacy_shield_dataset_id — …`), die den richtigen Id-Raum nennt
   (`v4_*`-Verben bzw. `create_xlsx`) — ohne sie schickt das Modell dieselbe
   id in der nächsten Iteration erneut. Jede andere Nicht-uuid ⇒
   `{"error":"not_found_or_not_owned"}`, also ununterscheidbar von einem
   fremden Dataset. Zusätzlich hat `get_schema` jetzt — wie `query_rows`
   schon immer — ein `try/catch`; seit dem Review gilt das auch für
   `list_datasets`, damit **jeder** Zweig des Tools der `Error:`-Konvention
   folgt statt zu werfen.
2. `NeonKnowledgeGraph.loadDatasetRow`/`deleteDataset` geben für eine
   Nicht-uuid `null`/`false` zurück, statt zu werfen (Prüfung **vor** der
   Query, nicht `id::text = $2` — Letzteres verlöre den PK-Index).
3. `src/routes/datasets.ts` mappt `22P02` auf **404 `dataset.not_found`**
   statt auf 500 mit der rohen Postgres-Meldung im Body — aber nur in den
   drei `/:id`-Handlern (`mapErrorToHttp(err, { byId: true })`). Auf den
   Collection-Routen gibt es keine Pfad-Id, dort bleibt ein `22P02` ein
   echter 5xx.

4. **Generisch, unabhängig vom Dataset-Pfad (gelandet mit #1095; #1093 hatte
   denselben Catch unabhängig gebaut und verlässt sich jetzt darauf):** `prepareStreamSlot`
   (`orchestrator.ts`) fängt jetzt pro Slot ab. Der Streaming-Dispatch rennt
   die Slot-Promises mit `Promise.race` — eine einzige Rejection riss vorher
   den Race, verließ `chatStreamInner` und beendete den Turn (Client sah ein
   terminales `error`-Event; hatte vorher ein anderes Tool committed, kam
   stattdessen das Notfall-`done` aus #506 mit `runTrace.status:"success"`
   und einem englischen Nicht-Antwort-Text). Der nicht-streamende Pfad
   (`Promise.allSettled`) degradierte dieselbe Rejection schon immer zu einem
   `is_error`-Tool-Result. Beide Pfade formatieren jetzt identisch
   (`Error: <message>`), aus dessen Präfix `is_error` abgeleitet wird. Ein
   Tool, das wirft statt einen `Error:`-String zurückzugeben, bleibt ein Bug
   in diesem Tool — aber es kann den Turn nicht mehr töten.

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
- **Request-Contract (issue #1109):** der Body wird strikt validiert. Das
  Zod-Schema ist `.strict()` — unbekannte Felder (`stream`, `userId`, `locale`,
  ein `conversationID`-Casing-Typo) werden **nicht** stillschweigend gestrippt,
  sondern mit `400 invalid_request` abgelehnt; die Response trägt ein
  Top-Level-`message`, das die abgelehnten Feldnamen nennt. Nur `message` +
  `conversationId` sind akzeptiert. Das hält den Weg offen, später ein echtes
  `stream`/`locale`-Feld zu ergänzen, ohne bereits-ignorierte Caller zu brechen.
  Zusätzlich: ein Request ohne `Content-Type: application/json` wird vom
  globalen `express.json` nie geparst (`req.body` bliebe `undefined`); der Router
  fängt das **vor** dem Schema-Parse mit `415 unsupported_media_type` ab und
  nennt den erforderlichen Content-Type — statt der irreführenden
  "expected object, received undefined"-Meldung. Beide Ausgänge auditieren als
  `invalid_request`.

Tests: `test/channelApi/` — u.a. eine echte Orchestrator- + echte
Privacy-Guard-Integration (`chatRouterPrivacyIntegration.test.ts`, spiegelt
`test/orchestrator/promptMaskPipeline.test.ts`s "realer Turn, gefakter LLM"-
Muster), Auth/Rate-Limit/Revoke/Audit-Wiring (`chatRouter.test.ts`), Key-CRUD
+ die reale `ctx.operatorAuth`-Verifikation inkl. Fail-closed-Pfad
(`adminKeysRouter.test.ts`), und die `publicPaths`-Exemption
(`publicPathsExemption.test.ts`).

#### Agent-Bindung pro API-Key (issue #1106)

Bis #1106 landete **jeder** API-Turn beim Fallback-Orchestrator: der Channel
setzte keinen `channelKey`, also fiel `coreApi.ts` auf `turn.conversationId`
zurück — und das ist der pro-Conversation-`internalConversationId`-Hash, für
jede Conversation anders. Ein Operator konnte den Public-API-Channel weder in
`/operator/channels` sehen noch binden. **Direction A** (aus dem Issue) macht
den API-Key zur Bindungs-Einheit:

- **Router setzt einen stabilen, nie caller-kontrollierten `channelKey`**
  (`chatRouter.ts`): `IncomingTurn.channelKey = key:<keyId>`. Getrennt vom
  `conversationId` — der bleibt der Hash (der Memory-Scope, absichtlich pro
  Thread verschieden). So löst der Dispatcher (`orchestratorDispatcher.ts`,
  US7-Pfad) die Bindung über `(channelType, channelKey)` auf: zwei Turns
  desselben Keys mit unterschiedlichen `conversationId` treffen **dieselbe**
  Bindung, behalten aber **getrennte** Memory-Scopes.
- **Format single-sourced** in `channelKey.ts` (`channelKeyOf(keyId)`,
  `CHANNEL_KEY_PREFIX`): derselbe String ist `channelKey`, `userRef.id` und der
  im Directory gelistete Key — identisch in Logs, `channel_bindings`-Zeile und
  Dashboard.
- **`ChannelKeyDirectory`-Beitrag** (`apiChannelDirectory.ts`): listet eine
  Zeile pro **aktivem** (nicht widerrufenem) Key, `key:<uuid>` + Label
  (Fallback `API key <id8>`). Der Channel holt die Kernel-Registry über
  `ctx.services.getOptional('channelDirectoryRegistry')` (Manifest:
  `optional_requires: ["channelDirectoryRegistry@1"]` — der Kernel stellt sie
  bereit, also **kein** hartes `requires`; fehlt sie, aktiviert der Channel
  trotzdem, nur die Dashboard-Liste entfällt) und meldet sie beim Aktivieren
  an, `close()` meldet sie symmetrisch wieder ab.
- **`channelType`-Konsistenz:** das Directory annonciert `channelType =
  ctx.agentId` (`@omadia/channel-api`), Routing leitet den Typ via
  `deriveChannelType(channelId)` ab — für diese id (kein Punkt, schon
  lowercase) derselbe String, also matcht eine gebundene Zeile echte Turns.
  Fragil, falls je ein `channel_type:` ins Manifest käme; das
  Binding-Routing-Integrationstest pinnt die Gleichheit.
- **Direction B** (per-Request-`agent`-Feld + Allowlist) ist bewusst ein
  Folge-Issue, hier nicht enthalten.

Tests: `apiChannelDirectory.test.ts` (aktiv/widerrufen/Label-Fallback),
`chatRouter.test.ts` (#1106-Block: stabiler `channelKey`, getrennte Scopes),
`apiChannelBindingRouting.test.ts` (echter Router→CoreApi→Dispatcher-Pfad:
`bound` bei Bindung, `fallback` ohne — die vom Issue vorgeschlagenen
Regressionstests 2–4), `plugin.test.ts` (Directory register/unregister +
Degradieren ohne Registry).

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

### Subscription-CLI-Login + Provider-Hand-off (`/api/v1/admin/cli-backends`, OM-73/OM-79)

`src/routes/adminCliBackends.ts` treibt `claude auth login` aus der Web-UI
(`src/platform/cliAuthService.ts`). Auth: required.

| Route | Zweck |
|---|---|
| `GET  /` | Erkannte CLIs (installiert / angemeldet), `?refresh=1` bustet den Cache |
| `POST /:id/login/start` | Spawnt `claude auth login --claudeai`; Antwort `{ sessionId, verificationUrl, codeEntry, status }` |
| `GET  /:id/login/status` | Poll-Ziel: `{ status: idle\|pending\|authorized\|error, account?, error? }` — `invalid` ist seit #1084 nur noch das Ergebnis eines `login/code`-Versuchs, kein Session-Status |
| `POST /:id/login/code` | Schreibt den eingefügten Code auf stdin — wann immer die CLI auf einen Code wartet, auch als Fallback aus dem Polling-Modus; ist die Session schon `authorized`/`error` (Callback fertig, Prozess gescheitert), meldet es genau das statt „läuft nicht mehr" |
| `POST /:id/login/cancel` | Verwirft die aktive Login-Session |
| `POST /:id/logout` | `claude auth logout` + Cache-Bust |

**Zwei CLI-Generationen, ein Flow (#1084).** Die im Image gebündelte CLI
(2.1.187) druckt `Opening browser to sign in…` und `If the browser didn't open,
visit: …` (URL mit `code=true` und platform.claude.com-Callback) und wartet dann
ausschließlich an `Paste code here if prompted >` auf stdin. Neuere CLIs
(≥ 2.1.246) können den Login per localhost-Callback abschließen und sich mit
Exit 0 beenden, drucken denselben Paste-Prompt aber als Fallback mit. Die
Browser-Zeilen kommen also in beiden Generationen vor und tragen kein Signal:
**der Paste-Prompt entscheidet allein.** `startCliLogin` wartet bis zu
`CODE_PROMPT_PROBE_MS` auf den Prompt (bricht nicht bei der ersten
Browser-Zeile ab, der Prompt kann in einem späteren stdout-Chunk kommen) und
liefert `codeEntry = true`, sobald er da ist — auch für 2.1.259. Nur ohne Prompt
kommt `codeEntry: false`; dann zeigt die UI den Polling-Modus, **immer mit einem
sichtbaren Fallback-Code-Feld**. Die UI pollt `login/status` in beiden Modi, ein
per Callback abgeschlossener Login löst also auch im Code-Modus auf. Endet der
Poll terminal (Timeout, `idle`, `expired`, `error`), zeigt die UI „Erneut
versuchen" statt eines toten Code-Felds. Ein falscher Code liefert dem Aufrufer
`invalid`, lässt die Session aber `pending` — sonst verweigert
`markAuthorized` den korrekten zweiten Versuch und der Post-Login-Hook feuert
nie. Der Exit-Handler liest den Exit-Code: 0 → Detection bestätigt →
`authorized`; ≠ 0 → `error` mit Output-Tail.

**Post-Login-Hook (OM-79).** `cliAuthService.setCliLoginAuthorizedHook(fn)`
feuert genau einmal pro Session auf dem Übergang pending → authorized
(`markAuthorized`, egal ob Exit-Handler oder Code-Submit zuerst kommt).
`src/index.ts` hängt dort `autoAssignSubscriptionCli` aus
`src/platform/providerAssignment.ts` ein: jedes installierte LLM-Plugin, das
noch auf dem Plattform-Default (`llm_provider` unset oder `anthropic`) ohne
Credential steht, wird auf `claude-cli` umgestellt und reaktiviert. Eine
explizite Wahl (`openai`, OAuth, lokaler keyless Server) wird nie überschrieben.
`applyProviderAssignment` ist dieselbe Funktion, die `POST /admin/providers/assignment`
benutzt (Fail-closed-Regeln: tool-loser Provider vs. tool-treibendes Plugin,
Modell/Provider-Mismatch, Routing-Disable bei Nicht-Anthropic).

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

### Privacy Shield: Deny-Lists, Miss-Queue, idnum, Eval-Gate (#760)

Operator-Deny-List: Setup-Felder `custom_terms` (Literale, ';'/Zeilen-getrennt)
+ `custom_patterns` (Regex, eine pro Zeile) am Privacy-Plugin; Vetting beim
Config-Wechsel (Syntax + Escalating-Probe-Zeitbudget gegen katastrophales
Backtracking), abgelehnte Patterns loggen `customPatternRejected` laut.
Detector-Id `custom-terms`, Span-Typ `custom`, gleiche Fail-Closed-Maschinerie.
Miss-Report-Queue: **`POST/GET /api/v1/operator/privacy/miss-reports`** (+
`/:id/resolve`), Tabelle `privacy_miss_reports` (Migration `0040`), Intake auf
der PrivacyReceiptCard, Review-UI `/operator/privacy-reports`. `idnum` ist
seit #760 gated (DE/ES/IT/UK/FR-Patterns in C0; NL BSN bewusst ungepattern —
9 nackte Ziffern). CI-Gate: `promptDetectorEval.ts --check` gegen
`validation/ci-baseline.json` (per-Locale-Floors, leerer Lauf = rot). Tests:
`test/privacyCustomTermsAndIdnum.test.ts`, `test/privacyMissReports.test.ts`.

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

### Conductor-Workflow-Delete (PR #836)

Neu: **`DELETE /api/v1/operator/conductors/:slug`** — löscht einen manuellen
Workflow mit den zwei Removal-Shapes des #330-Reapers: **hard** (physischer
DELETE, wenn kein Run irgendeine Version referenziert; Versions/Drafts/
Schedules kaskadieren) oder **soft** (`status='disabled'` + `reaped_at`-Stempel;
Run-Historie bleibt als Audit-Trace). Aktive Runs ⇒ 409
`conductor.has_active_runs` (erst per #759-Route canceln); `eph-`-Namespace ⇒
400 (Ephemeral-Lifecycle). Response `{deleted, mode: 'hard'|'soft'}`.
Resurrection-Guards: `list()` filtert `reaped_at IS NULL` (Library **und**
Event-Router), `removeLogical` disabled Workflow + Cron-Schedules atomar (eine
CTE), `setStatus` und der Publish-Upsert verweigern reaped Rows (Publish auf
gelöschten Slug ⇒ 409 `conductor.slug_exists`), `GET /:slug` ⇒ 404, FK-Race
23503 im Hard-Pfad fällt auf soft zurück. Store-Methoden: `hasActiveRuns`,
`removeLogical`, `hardDeleteUnreferenced` (workflowStore.ts, Spiegel von
ephemeralStore). Web-UI: Delete-Button + ConfirmDialog auf `/conductor`,
`deleteConductorWorkflow` in `api.ts`, i18n `conductor.delete*` en+de.
Tests: `test/conductorWorkflowDelete.test.ts`.

### Turn-Receipts (#757) — persistierte Per-Turn-Privacy-Receipts

Ein Turn persistiert seinen PII-freien `PrivacyReceipt` synchron nach
`turn_receipts` (Migration `0039`, Postgres-Backend only) — aber **nur, wenn
der Privacy Shield in diesem Turn aktiv war**: `finalizeTurn()` in
`harness-plugin-privacy-guard/src/service.ts` liefert nur dann einen Receipt,
wenn der Turn ein Dataset interniert, einen Bypass oder die strukturierte
Ausgabe eines angebundenen Tools protokolliert, den Prompt maskiert
(Letzteres nur bei mindestens einem erkannten PII-Span), einen Tool-Fehler
behandelt hat (`toolErrors`: Exception-Text zurückgehalten, `Error:`-Text
redigiert oder zurückgehalten, MCP-Connect-Prompt durchgereicht — siehe §11
„Tool-Fehler an den Dispatch-Nähten“) oder der Antwort-Verifier unter seiner
Privacy-Sicht Modellanfragen gestellt hat (`verifierEgress`, siehe unten); der
Orchestrator persistiert nur `if (receipt)`. Ein Turn ohne Shield-Aktivität
(z. B. reine Antwort ohne Tool-Aufrufe, deren Prompt nichts zu maskieren enthielt;
`mask_user_prompt` ist per Default ohnehin aus) schreibt weder eine Zeile
noch eine Log-Zeile. UI-Copy und README sagen das seit #1081 so. Ein
Null-Aktivitäts-Receipt pro Turn wurde bewusst verworfen: er würde die
Hash-Kette (#758), die signierten Checkpoints und das Retention-Volumen
verändern und braucht eine eigene Produktentscheidung. Der
Orchestrator löst den Store late-bound über den Service
`turnReceiptStore` auf (Kernel provided in `index.ts`, gleiches Muster wie
`privacyRedact`); ohne Service bleiben Receipts ephemer. Fehlschläge werden
gezählt (`persistFailures` in `src/receipts/store.ts`) und greppbar geloggt
(`turn-receipt persist failed`), scheitern aber nie den Turn. Read-API:
auth-gated **`GET /api/v1/operator/receipts`** (Liste, Composite-Keyset-Cursor
`(created_at, id)`) und **`GET /api/v1/operator/receipts/:turnId`**; UI unter
`/operator/receipts`. Retention: `RECEIPT_RETENTION_DAYS` (Default 90),
Reaper mit Eager-Boot-Tick, Cutoff auf der DB-Uhr. Tests:
`test/turnReceipts.test.ts`, `test/orchestrator/turnReceiptPersistence.test.ts`.

#### Verifier-gewrappte Turns finalisieren erst nach dem Verifier

Läuft ein Turn über `VerifierService` (Bundle `verifier@1` publiziert) und ist
der Privacy Shield aktiv, finalisiert der Turn **nicht selbst**: Der Wrapper
setzt vor jedem `runTurn`/`chatStream` `markPrivacyFinalizeHeld(input)`
(One-Shot, gekeyt auf das Input-Objekt des Aufrufers), der Turn liefert sein
Ergebnis ohne `privacyReceipt` und übergibt eine
`PrivacyEgressContinuation` (`harness-orchestrator/src/privacyEgress.ts`),
die der Wrapper mit `takePrivacyEgress(input)` abholt. Alle drei
Finalize-Stellen übergeben (gepuffert, Streaming-`done`, Streaming-Direct-Line).
Über `continuation.verifierPrivacy` laufen Extractor- und Judge-Requests unter
der Surrogat-Map des Turns; danach ruft der Wrapper `finalize()` **genau
einmal** pro Lauf (`EgressLedger` in `verifierPrivacyGate.ts` für `chat()`,
`StreamPasses` im Stream; auch bei Fehlern, abgebrochenen Wiedereintritten
und Client-Abbruch) — erst dann entsteht der Receipt des Laufs. Jeder Lauf
(erster Lauf, Resample, Retry) wird über seine eigene Sicht verifiziert. Kann
die Anfrage wieder betreten werden (Request-Ledger, §3 „Replay-Ledger“),
gehen die Receipts aller Läufe in die **eine** `turn_receipts`-Zeile der
Anfrage, nach dem Urteil geschrieben (`requestReceipts.ts`, die
Verifier-Requests der Läufe summiert); sonst schreibt der Lauf die Zeile
selbst.
Das Modell-Attribut wird bei der Übergabe gesichert (die 512er-FIFO
`turnAttribution` könnte es sonst verdrängen). Der Receipt trägt die
Verifier-Requests getrennt in `verifierEgress` (Anzahl + Span-Typen); ein Turn,
dessen einzige Shield-Aktivität der Verifier war, bekommt dadurch ebenfalls
eine Zeile. Beim Streaming hält der Wrapper `done` zurück, bis der innere
Stream gedrained ist und der Verifier fertig ist, und sendet es dann mit
`privacyReceipt` + `receiptId`, gefolgt vom `verifier`-Event. Ein Turn, der
wirft, oder ein abgebrochener Stream verwirft seinen Privacy-State jetzt
sofort (vorher blieb er bis zum Neustart im Speicher). Sicherheitsseite:
`docs/security-architecture.md` §6e. Die Wire-Sicht zeichnet der Turn selbst
auf (`TurnContextValue.wireView`): den Prompt so, wie ihn das Modell bekam —
eine MCP-Input-Card-Antwort also nur als Label, nie als Envelope mit den
eingegebenen Werten — und die Antwort vor dem Restore. Der Extractor schickt
genau das und maskiert es nicht erneut (`admitWireView` bucht den Request nur);
`VerifierService` gibt der Pipeline auch als `userMessage` nie den Envelope
(`modelFacingUserMessage`). Claims aus der Wire-Sicht stellt
`harness-verifier/src/claimRestore.ts` serverseitig wieder her (Beträge/Daten
aus Platzhaltern werden aus dem echten Literal neu gelesen); ein Claim, der
sich nicht auf die gezeigte Antwort zurückführen lässt, erreicht keinen
Checker und ist die Abdeckungslücke `claims_not_restored` — die Antwort ist
dann nie `approved`. Der Judge bekommt
keine Node-IDs: Jede Evidenz heißt im Request `ev-1`, `ev-2`, … (pro Request
vergeben, die zitierte Kennung wird serverseitig auf das Snippet
zurückgeführt), und eine Node-ID oder ein String-Schlüssel (`id=…`) im
Evidenztext wird wie ein Anzeigename ersetzt. Eine zweite
Antwort mit ungelösten Platzhaltern (`countUnresolvedSurrogates`) ersetzt die
erste nie — weder ein Retry (er wird dann gar nicht beurteilt) noch ein
blockiertes Re-Sample nach einer Borderline-Antwort. Ungelöst heißt: wörtlich, in anderer
Groß-/Kleinschreibung, mit umgruppierten Ziffern oder — bei Datum und Betrag —
als anderes Literal desselben Werts (`harness-plugin-privacy-guard/src/valueLiterals.ts`:
ISO, Punkt/Slash, ohne führende Null, zweistelliges Jahr, ausgeschriebener
Monat in sechs Locales, Tausendergruppen, „k“/„Tsd.“/„T€“/„Mio.“); denn Restore
ersetzt nur den exakten Platzhalter-String. Ein Datums- oder Betragsliteral
ohne lesbaren Wert passt auf jeden Platzhalter seiner Art (fail closed).
Tests:
`test/orchestratorPrivacyEgress.test.ts` (Übergabe),
`test/verifierPrivacyEgressEndToEnd.test.ts` (Verifier um den echten
Orchestrator, auch ein als ISO umgeschriebener Datums-Platzhalter in Retry und
Re-Sample), `test/privacyValueLiterals.test.ts` (Wert-Grammatik),
`test/verifierEvidenceHandles.test.ts` (Judge-Kennungen),
`test/verifierServicePrivacyEgress.test.ts` /
`test/verifierServiceStreamPrivacyEgress.test.ts` (Wrapper, Harness in
`test/_helpers/`).

#### API-Turn-Attribution + Korrelations-Id (#1107)

Turns über `POST /api/public/v1/chat` trugen `channel = NULL` und der Caller
bekam keine Id, die auf seine Receipt-Zeile zeigt. Zwei Nähte gefixt:
- **`channel`-Label:** Der Public-API-Channel authentifiziert den Caller ALS
  seinen Key (`userRef = { kind:'custom', id:'key:<uuid>' }`, #438). Da Canvas
  denselben `custom`-Kind nutzt, diskriminiert `orchestratorDispatcher.toChannelKind`
  jetzt am `key:`-Präfix und liefert die neue `ChannelKind` `'api'`
  (`@omadia/plugin-api`, 1.14.0). `'api'` ist damit auch gültiges Ziel für
  `ai_disclosure_level_overrides` und erscheint unter `/health`
  `disclosure.channels` (in `AI_DISCLOSURE_CHANNEL_KINDS` **und**
  `DISPATCHED_CHANNEL_KINDS`, sonst parst der Override, greift aber nie).
- **Korrelations-Id:** Das `done`-Event trägt jetzt `receiptId` == der
  Receipt-Store-Key (`turn_receipts.turn_id`, das per-Turn-`randomUUID`) — NICHT
  die KG-Turn-Node-Id (`turnId`, `turn:<scope>:<time>`). Nur gesetzt, wenn ein
  Receipt geschrieben wurde (Privacy-Shield-Aktivität). Löst über das
  bestehende **`GET /api/v1/operator/receipts/:turnId`** auf. Dokumentiert im
  Public-API-README ("Correlating a turn with its privacy receipt").

### Receipt-Hash-Kette + signierte Checkpoints (#758)

`turn_receipts` ist seit Migration `0041` hash-verkettet: `entry_hash =
sha256(stream ‖ seq ‖ prev_hash ‖ canonical(payload))`, Appends serialisiert
über `audit_stream_heads` (FOR UPDATE — eine lineare Kette, keine Forks);
Replay ⇒ kompletter Rollback. UPDATE per Trigger verboten, DELETE bleibt für
Retention erlaubt (Lücken sind detektierbar). Ed25519-Checkpoints
(`src/receipts/checkpoints.ts`): Key NUR in Env (`AUDIT_SIGNING_KEY`,
Keygen `scripts/generate-audit-signing-key.mjs`), Intervall
`AUDIT_CHECKPOINT_INTERVAL_MINUTES` (60), externer Anker `AUDIT_ANCHOR_PATH`
(JSONL). Public Key: **`GET /api/v1/operator/provenance/public-key`**.
Verify-Grundstein `verifyChainSegment` in `src/receipts/chain.ts` (Tamper-
Tests in `test/receiptHashChain.test.ts`); die Operator-Verify-Fläche ist
#761. Zeitanker: Checkpoint-Kadenz, nicht pro Zeile (`created_at` ist
außerhalb des Hashes — bewusst, begründet in `src/receipts/chain.ts` +
`receiptChainPayload` in `store.ts`). ⚠️ #761-Pflicht: Retention-Lücken
gegen die Checkpoint-Zeitachse prüfen (Backdating-Laundering-Kanal, s.
security-architecture §7b).

### Provenance-Verifikations-Fläche (#761)

**`GET /api/v1/operator/provenance/verify`** (Chain-Walk + Checkpoint-
Signaturen + Retention-Prefix inkl. `premature_deletion`-Regel aus #758) und
**`GET /api/v1/operator/provenance/export`** (signierter JSONL-Export,
Format `omadia-audit-export-v1`). Offline-Verifier:
`scripts/verify-audit-export.mjs` — zero-dep, dupliziert Kanonisierung/Hash
BEWUSST unabhängig von `chain.ts` (Änderung dort = `hash_version`-Bump +
Nachzug hier). UI: Chain-Status-Karte auf `/operator/receipts`. Doku +
Tamper-Demo: `docs/provenance-verification.md`. Tests:
`test/provenanceVerify.test.ts` (inkl. Offline-Verifier via spawnSync).

### Conductor Ephemeral/JIT-Workflows (#330 Workstream A)

Agent-generierte, run-scoped Workflows: `conductor_workflows.origin`
(`manual` | `ephemeral`, Migration `0009_ephemeral_workflows.sql` — plus
`expires_at`, `created_by_agent`, `reaped_at`). Ephemere Workflows entstehen
NUR über den Kernel-Service **`conductorEphemeralRuns`**
(`createEphemeralRun({ agentId, patternId, slots, payload, ttlMs })`,
provided in `src/index.ts` neben `conductorAwaitResolver`; deny-by-default —
kein `pluginServiceGrants`-Eintrag, den liefert erst das Facilitator-Plugin).
Der Graph kommt aus dem kuratierten **Pattern-Katalog**
`src/conductor/patterns/` (`patternCatalog.ts`, Patterns = TemplateManifests,
Slot-Fill über die bestehende Template-Maschinerie — Agents können keine
freien Graphen einreichen; erstes Pattern: `facilitation`). Create+Start in
einem Call: `createOrPublish({ origin:'ephemeral', expectNew, enable })` →
`startRun({ triggerKind:'agent' })` (erste Call-Site dieses TriggerKinds).

Namespace: Slug-Präfix **`eph-`** ist reserviert — `POST /`,
Template-Instantiate, `POST /:slug/status` und `POST /:slug/runs` lehnen es
mit `conductor.reserved_slug_prefix` ab (Status/Runs: der Reaper owned den
Lifecycle, sonst Zombie-Risiko). `workflowStore.list()` filtert auf
`origin='manual'` — Library-UI UND EventRouter sehen ephemere Workflows nie
(run-scoped, nicht event-triggerbar).

Lifecycle („discard the scaffold, never the minutes"): bei terminalem
Run-State (Hook in `notifyRunEnded`) oder TTL-Ablauf
(`ephemeralReaper.ts`, scheduleWorker-Muster) wird die Definition disabled +
`reaped_at` gestempelt; abgelaufene aktive Runs bekommen den #759
Cancel-Request; physisches DELETE nur für referenzlose Definitionen
(`hardDeleteUnreferenced`, NOT-EXISTS-Guard; FK conductor_runs →
versions blockt ohnehin). Run-Historie + Version-Graph bleiben als
Audit-Trace. Guardrails env-tunable (`CONDUCTOR_EPHEMERAL_*`, §10): Pflicht-TTL
mit Clamp (Default 24h, Max 7d), max. 3 concurrent Runs + 10 Creates/h pro
Agent. Tests: `test/conductorEphemeral*.test.ts`,
`test/conductorPatternCatalog.test.ts`. Achtung: das Schema-CI-Gate re-applied
`src/conductor/migrations` noch NICHT (Verzeichnis steht in ci.yml unter
"still uncovered") — 0009 ist nach 0008-Muster idempotent geschrieben, aber
CI-unbewiesen.

### Group-Conversation-Primitives im Channel-SDK (#330 Workstream B1)

Strikt additive SDK-Erweiterung (Teams 0.12.7 / Telegram 0.2.0 laufen
unverändert): `IncomingTurn.conversationType` (`'direct'|'group'`, absent =
unknown → wie direct behandelt, Helper `isGroupConversation`),
`ConversationRoster` (+`partial`-Lower-Bound-Semantik wie
`roleHolderSource.ts`), typisierte `ConversationMembershipEvent`s
(`bot_added` inkl. `addedBy` — der Facilitator-Handshake-Trigger,
`members_added`/`members_removed`) und `TargetedSendProvider` (liefert immer
nur an EINEN bereits aufgelösten User).

Drei neue **optionale** `CoreApi`-Methoden nach dem
`registerWebSocket`-Feature-Detect-Muster: `registerRosterProvider`,
`registerTargetedSendProvider`, `emitConversationEvent` — nur definiert, wenn
der Kernel die jeweilige Registry verdrahtet hat
(`src/channels/{rosterRegistry,targetedSendRegistry,conversationEventHub}.ts`);
`channelRegistry.deactivate` räumt die Beiträge des Channels ab.

**Principal-Auflösung ist Kernel-Sache** (`targetedDeliveryService.ts`,
Service `targetedSend`, deny-by-default): `user:<id>` → 1 Delivery;
`role:<key>` → late-bound Fan-out an ALLE aktuellen Holder (Notification, eine
Delivery pro Holder, KEIN Quorum — anders als Decision-Awaits). Leere Rolle →
`role_has_no_holders`, Partial-Liste → `role_resolution_partial` (Deliveries
an bekannte Holder laufen trotzdem), unreachable Holder →
per-Holder-Diagnostic; nie silent drop, nie Throw. Ohne Postgres degradieren
role-Sends zu `role_resolution_unavailable`, user-Sends funktionieren.
Rollen-Auflösung nutzt eine zweite `buildRoleHolderRegistry`-Instanz über
`conductorWiring.roleStore` (TODO #330: Conductor exponiert seine Registry),
Conversation-Refs kommen aus `conductorWiring.channelBindingStore.getMany`.

`@omadia/plugin-api` **1.7.0**: `TARGETED_SEND_SERVICE_NAME` + Shapes
(plugin-api-eigen, da Dependency-Richtung sdk→plugin-api) — Workstream C
(Facilitator) konsumiert das. Tests: `test/conversationRoster.test.ts`,
`test/conversationEventHub.test.ts`, `test/targetedDelivery.test.ts`,
`test/coreApiOptionalCapabilities.test.ts`.

### Zero-Touch-Facilitator-Setup (#330 C2a)

Drei neue deny-by-default Kernel-Services (Manifest-`optional_requires` ist
das Gate, kein Katalogeintrag):

- **`agentProvisioning`** (`src/platform/agentSetupService.ts`):
  `ensureAgent({slug, name, description, pluginId, personaSkill?})` —
  idempotent; Persona via `skills`-Upsert + `agent_persona_skills`-Link
  (Wave 8 — Agents haben KEINE instructions-Spalte); attached nur das
  aufrufende Plugin; `fallback`-Slug verboten; bestehende Agenten werden nie
  mutiert. `configStore`/`orchestratorRegistry` werden **lazy pro Call**
  aufgelöst (das Orchestrator-Plugin published sie erst bei seiner eigenen
  Aktivierung).
- **`conversationBindings`**: `bind()` nur für Conversations, für die der
  Kernel selbst ein Gruppen-`bot_added` beobachtet hat
  (`src/platform/observedConversationInvites.ts` — subscribed DIREKT am
  ConversationEventHub, vor jedem Plugin; Key channelType::conversationId,
  TTL 24h). Der Index **überlebt Restarts** (#330 follow-up): Write-through in
  `observed_conversation_invites` (Migration `0048`, Core-Serie;
  `src/platform/observedInvitePersistence.ts`) — Map bleibt der Hot Path,
  Writes fire-and-forget (log-only), Boot-Hydration TTL-gefiltert, auf
  MAX_ENTRIES gecappt, Key aus den Tabellen-SPALTEN (JSONB≠Spalten ⇒ Row wird
  verworfen), try/catch um `hydrate()` (fehlende Tabelle ⇒ altes
  Re-Invite-Verhalten, nie Boot-Abbruch). Live-Events vor der Hydration
  gewinnen. Achtung: zwei Instanzen auf EINER DATABASE_URL teilen sich den
  Index (Annahme: eine Deployment == eine DB).
  Fremd-gebundene Conversations: Refusal via `channel_bindings`-PK.
  `unbind()` ist gleich hart geguarded: nur eigene Ephemeral-Attachment-Rows
  — Operator-Bindings sind von dieser Fläche aus unerreichbar, und ein
  vorbestehendes Operator-Binding wird NIE in den Ephemeral-Lifecycle
  adoptiert. bind/unbind laufen als `channel.binding_change` ins admin_audit.
  `attachWorkflow()` (guarded: nur eigene pending-Row) koppelt das Binding an
  den Facilitation-Run.
- **Restart-Rehydration (#330 field report):** `listOwnAttachments({agentSlug})`
  liefert die eigenen, nicht abgelaufenen Attachment-Rows inkl. `activeRunId`
  (neuester running/waiting Run des Workflows, via `resolveActiveRun` in
  `src/index.ts`). Der Facilitator baut daraus nach einem Deploy seinen
  In-Memory-State wieder auf — ohne das lehnte er nach jedem Fly-Restart alle
  progress/nudge-Calls ab ("kein aktives Facilitation-Ziel").
- **`conductorRoleAssignments`** (`src/conductor/scopedRoleAssignments.ts`):
  Rollen-Writes hart auf Präfix `facilitation-` beschränkt; jede
  Holder-Mutation läuft durch den #759-Audit-Sink
  (`conductor.role_holders_change`, actor = Plugin bzw. Reaper).

**Ephemere Kopplung:** Migration `0010_ephemeral_attachments.sql` +
`ephemeralAttachmentsStore.ts`. Beide Reap-Pfade (Terminal-Hook in
`wireConductor.reapIfEphemeral` + `ephemeralReaper.onReaped`) rufen EINEN
gemeinsamen, in `src/index.ts` VOR wireConductor konstruierten
Cleanup-Pfad (`disposeEphemeralAttachment`): Binding entfernen,
Rollen-Holder schließen (auditiert), erst DANN Row löschen. Retry-Wahrheit:
schlägt das Cleanup fehl (oder läuft der Reaper-Boot-Tick, bevor
configStore/orchestratorRegistry published sind), bleibt die Row stehen und
der **Attachment-Sweep** räumt sie nach Ablauf ab — expired `pending`
(Invite ohne Facilitation) UND expired `attached` (verpasstes
Reap-Cleanup). Tests: `test/agentSetupService.test.ts`,
`test/observedConversationInvites.test.ts`,
`test/conductorScopedRoleAssignments.test.ts`,
`test/conductorEphemeralAttachments.test.ts`.
### Transcription-Capability + Recording-Ingestion (#584 WS T+I)

Speech-to-Text ist eine Core-Capability nach ADR-0003: Registry-Key
`'transcription'` (bare), Manifest-Form `'transcription@1'` — Twin-Konstanten
in `packages/plugin-api/src/transcription.ts` (sessionBriefing-Konvention).
Interface provider-neutral: `transcribeFile` (Batch) + `transcribeStream`
(Realtime, `AsyncIterable<TranscriptDelta>`), Hint-Carrier
(`languageHints`/`keywordHints`/`context`) für die #584-Hint-Synergie.
Guardrails als Decorator `withTranscriptionGuardrails` (per-Call-Cap,
per-Agent-Minuten-Quota In-Memory, Metering; Attribution via
`turnContext.currentAgentSlug()` zur Call-Zeit, VOR dem ersten yield
gecaptured — ALS überlebt Generator-yields nicht).

Erster Provider: `packages/transcription-adapter-openai/` (Plugin, provides
`transcription@1`, Vault-Key; `gpt-transcribe` Batch ungated,
`gpt-live-transcribe` hinter `TRANSCRIPTION_REALTIME_EXPERIMENTAL`).
Provider-Switch mit verifiziertem Rollback:
`/api/v1/admin/transcription-provider` (`src/routes/adminTranscriptionProvider.ts`,
schlankes Spiegelbild der Embedding-Route ohne Corpus/Gate) + web-ui-Panel
`/admin/transcription-provider` (Consent-Surface: „Roh-Audio verlässt die
Installation", i18n en+de).

Workstream I: Native-Tool `transcribe_recording`
(`packages/harness-orchestrator/src/tools/transcribeRecordingTool.ts`,
Registrierung in `plugin.ts` mit late-bound Service-Resolve). Ingestiert
Aufnahmen in dieselbe Artefakt-Substanz wie Live-Chat: ein `SessionLogEntry`
pro Utterance (additive Felder `speaker?`/`time?`; `TurnIngest.speaker` in
beiden KG-Backends), Markdown-Transkript + KG-Turns + Briefing. Transkript
gilt als untrusted Input und läuft als Tool-Result durch die bestehenden
Privacy-Choke-Points. Tests: `test/transcribeRecordingTool.test.ts`,
`test/sessionLoggerSpeaker.test.ts`, `test/adminTranscriptionProviderRoute.test.ts`,
`packages/plugin-api/test/transcriptionGuardrails.test.ts`, Adapter-Suite in
`packages/transcription-adapter-openai/test/`.

### Facilitation-Admin-Lens (#330 Runde 4)

Ephemere Workflows sind bewusst aus der Library gefiltert — laufende
Facilitations waren dadurch im Admin unsichtbar (Feldbefund: zwei Instanzen
im selben Meeting, nicht stoppbar). Neue Operator-Routen (beide hinter
requireAuth unter `/api/v1/operator/conductors`, VOR den `/:slug`-Routen
deklariert):

- **`GET /facilitations`** — Overview aller nicht gereapten ephemeren
  Workflows aus rein durablem State: Conversation (Attachment-Row), Goal/DoD
  + Assess-Runden (`ctx.stepAttempts.moderate`) + letztes Verdict
  (`ctx.steps.moderate.data` — accumulate() persistiert pro Step-Id;
  `ctx.stepResult` existiert nur transient als Guard-Argument, NIE im
  durablen Context), Initiator-Role-Holder, Teilnehmer via
  Roster-Registry (best-effort, 30s-TTL-Cache — jeder Roster-Read öffnet
  einen proaktiven Channel-Turn). Store-Fehler beim Zusammenbau ⇒ Row-Flag
  `incomplete: true` + Log (unter-reporten ja, erfinden nie).
- **`POST /facilitations/:workflowId/terminate`** — cancelt aktive Runs
  (#759-Semantik) und disposed das Scaffold über DENSELBEN Cleanup-Pfad wie
  der Reaper (`disposeEphemeralWorkflow` in `src/conductor/index.ts`;
  Binding + Rolle gehen mit). Schlägt EIN Cancel fehl, wird die Disposal
  ÜBERSPRUNGEN (502 `conductor.facilitation_cancel_failed`) — reaped_at auf
  einem lebenden Run würde ihn aus genau dieser Lens verstecken. Non-ephemeral
  ⇒ 404. Jede erfolgreiche Terminierung landet als
  `conductor.facilitation_terminate` im admin_audit (actor-uuid/email nach
  #775-Regel getrennt).

Web-UI: Panel „Laufende Facilitations" auf der Conductor-Seite
(`web-ui/app/conductor/_components/FacilitationsPanel.tsx`), Stop & remove
hinter ConfirmDialog. Modul: `src/conductor/facilitationAdmin.ts`, Tests:
`test/conductorFacilitationAdmin.test.ts`.

**Zwischenstand-Tabelle (Pattern v3):** Das Moderate-Verdict trägt zusätzlich
`items[]` — pro nummeriertem DoD-Punkt `{point, label, status:
done|partial|open, note}`. Der Kernel validiert die Model-Ausgabe defensiv
(`verdictItems()` in `facilitationAdmin.ts`: Nicht-Objekte fliegen raus,
falsch getypte Felder werden genullt) und reicht sie als
`run.lastVerdict.items` durch (Strings auf 300 Zeichen gekappt, `point` nur
als positive Ganzzahl); das Details-Modal (`FacilitationDetailsModal.tsx`)
rendert daraus die Tabelle #/Punkt/Status/Stand. Die Labels sind eine
Model-Paraphrase — der autoritative DoD-Text bleibt daneben stehen. Läufe,
die vor Pattern v3 gestartet sind, liefern `items: null` → nur DoD-Liste.

### Timer-Steps + DoD-Loops + conversationSend (#330 C3)

Neuer Step-Kind **`timer`** (`conductor-core` types/schema/validate;
Executor parkt via Await-Maschinerie mit `principal_kind='timer'`, Migration
`0011`): Deadline-Poll → `expireAwait` → On-Expiry-Fallback — derselbe
Mechanismus wie Human-Deadlines. Guarded Cycles durch einen Timer sind
validate-grün (unguarded bleibt Fehler); Loop-Budget deterministisch über
`ctx.stepAttempts[stepId]` (Executor bumpt bei jedem Step-Entry; Guard z.B.
`lt ctx.stepAttempts.moderate 24`) plus Ephemeral-TTL plus MAX_STEPS.
Agent-Steps liefern strukturierte Verdicts: letzter ```json-Fence der
Antwort → `stepResult.data` (`extractFencedJson` in realStepEffects,
tolerant + size-capped). Pattern `facilitation` ist **v2** (Assess-Tick
PT1H, max 24 Runden, DoD-met → confirm, exhausted → abort-report).
`conductorEphemeralRuns.poke(runId)` feuert den offenen Timer-Await sofort.
Neuer Service **`conversationSend`** (deny-by-default; SDK-Seam
`registerConversationSendProvider`, Kernel `src/channels/
conversationSend{Registry,Service}.ts`, plugin-api 1.8.0) — Gruppen-Nudges,
Gegenstück zu targetedSend. Tests: `test/conductorTimerStep.test.ts`,
`test/conversationSendService.test.ts`.

### Runtime-Readiness-Cause + Embedding-Status (Beta-Runde 4, #1000 / #1003)

Zwei kleine API-Ergänzungen, damit Dashboard und Readiness-Banner dieselbe
Wahrheit lesen (OM-74/75/78/84):

- **`cause` auf dem `multi_orchestrator_unavailable`-503 von
  `GET /api/v1/operator/agents`.** Werte: `no_llm_access` (kein Key, kein
  OAuth, kein CLI-Login bei irgendeinem Provider), `no_assignment` (ein Zugang
  existiert, aber der Provider, dem der Orchestrator per `llm_provider`
  zugeordnet ist, hat keinen), `unknown` (Zugang und Zuordnung passen; Runtime
  aus anderem Grund down, z. B. DATABASE_URL, Boot). Berechnung in
  `src/platform/pluginLlmReadiness.ts` (`computeRuntimeReadinessCause` pur,
  `resolveRuntimeReadinessCause` mit denselben Credential-Verdicts wie die
  Providers-Admin, ohne Netz-Probe; `memoizeRuntimeReadinessCause` teilt ein
  Verdict 8 s zwischen parallelen Aufrufern). Router-Dep `getReadinessCause`
  in `routes/operatorAgents.ts` ist optional; ohne sie bleibt das 503-Payload
  unverändert, ein Reject degradiert zu `unknown`. Wiring-Pin in
  `test/operatorAgentsRouter.test.ts`.
- **`GET /api/v1/admin/embedding-provider/status`** (auth wie der Rest des
  Routers): `{ capabilityPublished, activeProviderId, activeModel,
  installedProviderIds }` aus der Registry allein. Das bestehende `GET /`
  zählt den Korpus pro Vektorspalte und ist für eine Karte, die bei jedem
  Dashboard-Load rendert, zu teuer. Konsument: `web-ui/app/page.tsx`
  (Health-Karte „Gedächtnis / Embeddings“, Onboarding-Hinweis). Tests:
  `test/runtimeReadinessCause.test.ts`, `test/adminEmbeddingProviderRoute.test.ts`.

### Gedächtnis-Funktionen auf dem Abo-Weg (Beta-Runde 5, OM-102)

Faktenextraktion, Themenerkennung und der Scratch-Promotion-Reaper hingen am
Config-Key `anthropic_api_key` von `@omadia/orchestrator-extras` statt am
LLM-Provider, der dem Orchestrator zugewiesen ist. Auf einer reinen
Abo-Installation (`llm_provider: claude-cli`, kein Anthropic-Key) blieben alle
drei aus, und das Dashboard sprach nur über Embeddings — meldete also „OK“,
während die halbe Gedächtnis-Pipeline still lag.

**Provider-Kandidatenkette** (`packages/harness-orchestrator-extras/src/llmProviderResolution.ts`,
verdrahtet in dessen `plugin.ts`). Kandidaten in Absichts-Reihenfolge, der
erste, der sich bauen lässt, gewinnt:

1. explizites `llm_provider` auf **diesem** Plugin — der Operator fragt direkt;
2. `anthropic`, **aber nur** wenn der Key im eigenen Vault-Scope liegt
   (`ownScopeAnthropic`). Ohne diese Stufe würde eine Installation, die einen
   Key bezahlt, stillschweigend auf das persönliche Abo-Kontingent migrieren —
   eine Kosten-/Quota-Änderung, die ein Bugfix nicht nebenbei machen darf;
3. die Zuordnung des **Orchestrators**, gelesen über den Kernel-Service
   `installedPluginConfigReader`. Dieses Plugin aktiviert **vor** dem
   Orchestrator (der `contextRetriever@^1` + `factExtractor@^1` `requires:`),
   deshalb ist der Config-Reader der einzige Weg — ein Service des
   Orchestrators wäre zur Aktivierungszeit noch nicht da. Das ist die Stufe,
   die den Abo-Fall repariert;
4. `anthropic` als historischer Default.

Credential-Quellen je Kandidat, in dieser Reihenfolge: eigener Vault-Scope,
dann der Kernel-Pool `llmProviderPool` (liest den Orchestrator-Scope, teilt
dessen Circuit-Breaker). Der `llmProviderCatalog` wird durchgereicht — ohne ihn
löst `claude-cli` auf das Default-Wire-Format `openai-compatible` auf und
scheitert an der fehlenden `baseURL`; Wire-Format und `requiresApiKey: false`
stehen nur im Katalog-Descriptor. Eine werfende Quelle wird geloggt und
übersprungen, nicht durchgereicht. Modell-Refs laufen durch
`coerceModelToProvider` (Default still, ein explizit gesetztes
`fact_extractor_model` laut). Alle drei Aufrufer nutzen ein reines
`complete()` ohne `tools` und bleiben damit im Rahmen des Shape-2-Adapters,
der nur Completions und forced single-tool structured output kann.

**Capability + Manifest.** Das Plugin published zusätzlich
`memoryFeatureStatus@1` (Service-Key `memoryFeatureStatus`, Kontrakt in
`src/memoryFeatureStatus.ts`) und deklariert
`optional_requires: ["llmProviderCatalog@1", "llmProviderPool@1",
"installedPluginConfigReader@1"]`. `optional_requires` ist der dokumentierte
Retirement-Pfad des Service-Grant-Gates (`src/platform/pluginServiceGrants.ts`)
— es gewährt `get`/`getOptional`, ohne eine Aktivierungskante zu erzeugen, was
hier zwingend ist: der Orchestrator muss downstream bleiben. Alle drei Services
stellt der Kernel beim Boot bereit, vor jeder Plugin-Aktivierung, deshalb ist
das eager `getOptional` in `activate()` zulässig.

**Neuzuweisung des Orchestrator-Providers (#1076).** Die Kette wird bewusst
**einmal je `activate()`** aufgelöst. Ändert sich das `llm_provider` des
Orchestrators, baut die Zuweisungsseite extras neu — die Lehre aus #989: eine
capability-relevante Änderung ist ein Rebuild, kein Update. Die Kante steht als
Daten im Kernel: `inheritsProviderFrom: '@omadia/orchestrator'` am extras-Eintrag
von `LLM_PLUGINS` (`src/platform/pluginLlmReadiness.ts`), gespiegelt durch die
exportierte Konstante `INHERITS_PROVIDER_FROM_PLUGIN_ID` im extras-Paket (ein
Drift-Test hält beide gleich). `reactivateAfterProviderWrite`
(`src/platform/providerDependents.ts`) baut bei einer **effektiven**
Provider-Änderung (vorher `?? 'anthropic'` gegen nachher; unset → explizit
`anthropic` zählt nicht) zuerst jedes installierte abhängige Plugin neu, dann das
Plugin selbst. Die Reihenfolge ist tragend: der Orchestrator greift
`factExtractor`, `contextRetriever` und `sessionBriefing` von extras eager in
seinem eigenen `activate()` ab, und ein Teardown von extras kaskadiert nicht
(`toolPluginRuntime.deactivate` ruft nur `disposeBySource`). Extras erst danach
neu zu bauen, ließe die Chat-Turn-Faktenextraktion auf der alten Instanz. Scheitert
ein abhängiges Plugin, wird der Orchestrator trotzdem neu gebaut und danach eine
`ProviderDependentRebuildError` (mit `dependentId`, `primaryApplied` und
dem `last_activation_error` im Text) geworfen. `primaryApplied` ist nur `true`,
wenn der Orchestrator selbst wieder hochkam; lässt auch sein eigener Rebuild
ihn `errored` zurück (dieselbe Registry-Prüfung wie bei den Abhängigen), ist es
`false`, und der Text behauptet nicht, dass er läuft. Sonst steht „runs on its
new provider“ nur bei einer effektiven Änderung, ansonsten „rebuilt on its
unchanged provider“. Die Routen antworten mit eigenem Code,
`providers.dependent_rebuild_failed` bzw. `runtime.dependent_rebuild_failed`
(beide PATCH-Routen), und legen `dependentId` + `primaryApplied` mit auf den
Envelope; beide Codes haben en/de-Copy im ErrorHelp-Katalog. Die Config ist in
beiden Fällen persistiert, deshalb übernimmt das `ProvidersPanel` bei diesem
Code den neuen Provider in die Zeile, statt das kontrollierte Select auf den
alten zurückspringen zu lassen, und zeigt einen „Erneut versuchen“-Button, der
dieselbe Zuordnung noch einmal schickt; ein erneutes Auswählen der schon
gewählten Option löst kein Change-Event aus. `autoAssignSubscriptionCli` zählt
ein Plugin mit `primaryApplied: true` als `assigned`. Kommt kein abhängiges
Plugin zu Fall, liefert `reactivateAfterProviderWrite` das `primaryFailure`
des Plugins selbst zurück; `applyProviderAssignment` antwortet dann mit
`providers.rebuild_failed` (`primaryApplied: false`) statt `ok`, weil die
Providers-Antwort keinen Status trägt (die Runtime-PATCH-Routen liefern den
Status im `updated`-Objekt und bleiben unverändert). Das `ProvidersPanel`
behandelt den Code wie `dependent_rebuild_failed` (Zeile übernimmt den neuen
Provider, Retry) und zeigt dessen Copy auch für ein
`dependent_rebuild_failed` mit `primaryApplied: false`. „Gescheitert“ heißt: `reactivate` wirft **oder**
hinterlässt das Plugin als `errored` in der Registry. Letzteres ist der
Produktionsfall, denn `installService.reactivate` wirft bei einem
Aktivierungsfehler nie, sondern ruft `markActivationFailed`, setzt `errored` und
kehrt zurück; ein erfolgreicher Rebuild hebt `errored` über
`clearActivationError` wieder auf. Ein erneutes Speichern **desselben**
Providers (der Retry-Button nach der Fehlermeldung) ist keine effektive
Änderung, baut aber jedes abhängige Plugin neu, das noch `errored` ist
(`providerWritten` im Helper, gesetzt, sobald der Write `llm_provider` enthält);
sonst hätte der Retry nur den Orchestrator neu gebaut und `ok` gemeldet, während
extras weiter ausfällt. Alle Schreibpfade für
`llm_provider` laufen durch den Helper: `POST /api/v1/admin/providers/assignment`
bzw. `applyProviderAssignment`, `PATCH /api/v1/admin/runtime/installed/:id/config`
und der Config-Zweig von `PATCH …/secrets` (`applySetupValues`). Der
Abo-Hand-off `autoAssignSubscriptionCli` bearbeitet Plugins mit Abhängigen
**zuletzt** (heute nur der Orchestrator; Reihenfolge damit Verifier, extras,
Orchestrator), damit der letzte Rebuild extras
mit dessen finaler Konfiguration einfängt; `LLM_PLUGINS` selbst bleibt
unsortiert, weil es auch die UI-Liste ordnet.

Der Orchestrator deklariert `llmProviderCatalog@1` und
`installedPluginConfigReader@1` seit #1076 ebenfalls unter `optional_requires`
und liest beide per `getOptional`; die beiden Zeilen sind aus seinem Eintrag in
`BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20` entfernt (19 → 17 Namen).

**`memoryFeatures` auf `GET /api/v1/admin/embedding-provider/status`.** Neben
den vier bestehenden Feldern:

```
memoryFeatures: {
  factExtractor: 'active' | 'disabled',
  topicDetector: 'active' | 'disabled',
  scratchReaper: 'active' | 'disabled',
  providerId?: string,                       // aufgelöster Provider
  reasons?: { <feature>: <reason-code> },    // nur für disabled-Features
  detail?: string                            // englische Diagnose, sekundär
}
```

Reason-Codes (geschlossenes Enum): `no_llm_provider`, `no_embedding_provider`,
`no_graph_pool`, `disabled_by_config`, `plugin_inactive`. Geschlossen, weil die
UI je Code eine Übersetzung führt — Backend-Englisch darf nie der primäre
deutsche Satz werden (`web-ui/CLAUDE.md`); Freitext reist ausschließlich in
`detail`. Die Ursache steht **pro Feature**, weil die drei aus verschiedenen
Gründen ausfallen: ein In-Memory-Graph legt nur den Reaper still, ein fehlender
Embedding-Anbieter nur die Themenerkennung. Publiziert das Plugin nichts,
antwortet die Route mit dreimal `plugin_inactive`.

Auf der Dashboard-Karte färbt **nur** `no_llm_provider` den Status auf WARN —
ein bewusst abgeschalteter Reaper (`disabled_by_config`) oder ein
In-Memory-Graph (`no_graph_pool`) sind normale Zustände; sie als Warnung zu
rendern hätte OM-84s falsches OK nur gegen ein ebenso nutzloses falsches WARN
getauscht. Tests: `test/orchestratorExtrasProviderResolution.test.ts`,
`test/adminEmbeddingProviderRoute.test.ts`, `web-ui/app/__tests__/page.test.tsx`.

### Provider-Pool-Invalidierung bei Credential-Änderung (#1080)

Der Kernel-`llmProviderPool` memoisiert pro Provider-Id, auch ein negatives
„kein Key". Deshalb hängt er an einem kernel-internen Write-Observer der
konkreten Vaults (`FileSecretVault.onWrite` / `InMemorySecretVault.onWrite`,
Typen in `src/secrets/vaultWriteEvents.ts`, bewusst **nicht** auf dem
`SecretVault`-Interface). Der Listener
(`src/platform/providerPoolInvalidation.ts`) reagiert nur auf den Scope
`@omadia/orchestrator`:

- `provider:<id>/api_key` und das Legacy-`anthropic_api_key` →
  `invalidate(id)` + `health.markHealthy(id)`, denn ein neuer Key ist ein
  neues Credential und erbt keinen Breaker-Cooldown.
- `provider:<id>/oauth_access_token` → nur `invalidate(id)`, weil die
  stündliche Rotation dasselbe Credential ist.
- `verified_at` und die übrigen OAuth-Leaves werden ignoriert.
- `purge` → `invalidateAll()` plus alle Breaker zurück.

Der Listener läuft, bevor der Write-Promise settled, also vor jedem
Reactivate, egal über welchen Pfad geschrieben wurde. Zusätzlich invalidieren
`registerProviderFromPlugin`/`unregisterProviderFromPlugin` die Id, weil der
Descriptor `keyless`/`oauth`/`baseURL`/Wire-Format bestimmt. Der Pool wird
dafür vor der Provider-Plugin-Boot-Schleife erzeugt.

Der geteilte `anthropicClient`/`llm` läuft über
`src/platform/sharedAnthropicClientRefresher.ts` (serialisiert, getriggert von
`reactivateAgent` **und** einem Vault-Listener). Ein entfernter Vault-Key fällt
auf `ANTHROPIC_API_KEY` zurück, sonst auf einen unauthentifizierten
`''`-Client. Auf Installationen, deren Vault-Key beim ersten Boot aus
`ANTHROPIC_API_KEY` geseedet wurde (`src/plugins/bootstrap.ts`), ist das
derselbe Key: Host-Consumer (Plan-Runner-Gate, Teams, Builder) nutzen ihn nach
dem Löschen weiter, nur der Orchestrator verweigert. Bereits gebaute
dynamische Sub-Agenten behalten ihren Provider bis zum nächsten Rebuild — siehe
§13 „Dynamische Sub-Agenten übernehmen Key-Änderungen erst nach Rebuild".

### Embedding-Provider-Reaktivierung (Beta-Runde 5, OM-97/98/99)

**`POST /api/v1/admin/embedding-provider/reactivate`** (Auth wie der Rest des
Routers, kein Body). Beendet drei Sackgassen, die zusammen die Normalform einer
Subscription-Installation sind: der keylose Adapter aktivierte vor dem
Weights-Download und publizierte nichts; die Vektorspalten sind 768 breit und
**leer**, während das Modell 384d liefert, und der einzige Pfad, der eine
Spaltenbreite ändern durfte, war ein operator-bestätigter Provider-**Switch** —
den #1053 unmöglich macht, weil es nach dem Boot keinen zweiten Provider mehr
gibt, zu dem man wechseln könnte.

Ablauf: aktiven Provider `deactivate` → `activate` (dabei liest der Adapter die
Weights neu), dann Gate-Re-Evaluierung mit `allowEmptyColumnMigration: true`
und `allowDestructiveMigration: false`. **Diese Route zerstört nie etwas.**

| Code | HTTP | Wann |
|---|---|---|
| `embeddingProvider.corpus_not_empty` | 409 | Die Vektorspalten halten noch Embeddings. `details: { vectorsToDiscard, columnDimensions }`. Verweist auf `/switch` mit `confirmDiscardVectors` — den Pfad, der die Verwerfen-Bestätigung trägt. |
| `embeddingProvider.no_active_provider` | 409 | Kein `embeddingClient@1`-Provider aktiv — es gibt nichts zu reaktivieren. |
| `embeddingProvider.switch_in_progress` | 409 | `switchInFlight` — `/switch` und `/reactivate` teilen sich dieselbe Serialisierung. |
| `embeddingProvider.reactivate_failed` | 500 | `activate` warf nach erfolgreichem `deactivate`. Ein **zweiter** `activate`-Versuch läuft automatisch (analog zu `restorePrevious` im `/switch`-Pfad); `details.capabilityPublished` sagt, ob er den Provider zurückgeholt hat. Das Gate lief in keinem Fall — `details.gateReevaluated: false`. |
| `embeddingProvider.gate_reevaluation_failed` | 500 | Provider ist wieder live, aber die Gate-Re-Evaluierung warf. Der Graph läuft unter dem **vorherigen** Verdikt weiter. `details: { pluginId, capabilityPublished, gateReevaluated: false }`. |

Erfolgs-Response (200): `{ ok: true, reactivated, capabilityPublished,
gateReevaluated, gateWarning?, dedupThreshold }` plus das komplette
`GET /`-Snapshot. `dedupThreshold` ist `null`, solange nichts publiziert wird,
sonst `{ applied, value, previous, reason }` — der Adapter-eigene
`process_dedup_threshold` wird nur in die *Abwesenheit* eines Werts
geschrieben, nie über eine Operator-Entscheidung, und greift erst beim nächsten
Start des Knowledge-Graph-Plugins.

Zwei Ergänzungen im `GET /`-Snapshot: `capabilityGap`
(`no-active-provider` | `missing-credentials` | `missing-weights` |
`not-published`) sagt **warum** kein Client publiziert ist, statt jedem
Adapter „API-Key fehlt“ zu unterstellen; `widthCollision`
(`{ providerDimensions, columnDimensions, columnsEmpty }`) trennt die
Breitenkollision von der Capability-Lücke — sie verhindert die *Writes*, nicht
die Publikation. `columnsEmpty: null` heißt „nicht feststellbar“ und die UI
bietet den Rebuild dann **nicht** an.

Emptiness wird zweimal geprüft: hier für eine schnelle, spezifische Absage, und
noch einmal **innerhalb** des Advisory-Locks von `migrateVectorColumns`
(`requireEmpty`) — die Vorab-Prüfung liegt vor dem Lock, ein Backfill-Tick im
Fenster dazwischen würde sonst still verworfen. Ein nicht ermittelbarer Count
gilt an beiden Stellen als „nicht leer“ (fail closed).

Tests: `test/adminEmbeddingProviderReactivate.test.ts` (Route inkl.
Fehlerpfade), `test/embeddingColumnMigrationGuard.test.ts` (Gate-Hälfte:
Permission, Master-Switch `auto_migrate_vector_columns`, `requireEmpty`),
`web-ui/app/admin/embedding-provider/__tests__/page.test.tsx` (UI).

### Run-Trace- und Capture-Filter-Zähler: `GET /api/admin/run-trace` (#684 / #1082)

Die Run-Trace-Outcomes (#684) und die Zahl der vom Capture-Filter als
tail-only geschriebenen Turns sind Zähler, nicht nur Log-Zeilen. Das
Orchestrator-Plugin baut **eine** `RunTraceOutcomeStats`-Instanz, reicht sie
an jeden `SessionLogger` weiter (jeder Agent, Registry-Rebuilds,
`transcribe_recording`) und publiziert sie als Service `runTraceStats`
(`RUN_TRACE_STATS_SERVICE`). Der Admin-Router löst sie pro Request über die
Service-Registry auf.

- **Auth:** `Authorization: Bearer <ADMIN_TOKEN>`, wie
  `/api/admin/security/screening`. Der Router wird nur gemountet, wenn
  `ADMIN_TOKEN` gesetzt ist; ohne Token gibt es die Route nicht, mit falschem
  Token `401`.
- **Antwort (200):** `{ outcomes, droppedTotal, captureTailOnlyTurns }`.
  `outcomes` hat die fünf Zähler `recorded`, `no-graph-sink`,
  `transcript-failed`, `turn-ingest-failed`, `run-ingest-failed`;
  `droppedTotal` summiert alle außer `recorded`. `captureTailOnlyTurns` zählt
  Turns, keine Traces, und fließt bewusst **nicht** in `droppedTotal` ein: der
  Trace eines gefilterten Turns ist `recorded`.
- **`503 { error: 'run_trace_stats_unavailable' }`**, solange kein
  Orchestrator aktiv ist (kein LLM-Zugang, fehlende Kernel-Services,
  deaktiviert).
- **In-Memory, prozessweit:** kein Persistenz-Store. Die Zähler starten bei
  einem Neustart und bei jeder Reaktivierung des Orchestrator-Plugins (z. B.
  Provider-Wechsel) wieder bei null. Nicht auf `/health`, das keine
  Traffic-Zahlen trägt.

Tests: `test/adminRunTraceRoute.test.ts` (Route mit echtem Capture-Decorator
und `SessionLogger`), `test/runTraceStatsServicePublish.test.ts` (echtes
`activate()` gegen eine `ServiceRegistry`: publizierte Instanz = die des
Agent-Loggers, 503 vor Aktivierung und nach Deaktivierung),
`test/buildOrchestrator.test.ts` (jeder gebaute Agent teilt
`deps.runTraceStats`).

### Session-Verlängerung „Ich bin noch da“ (`POST /api/v1/auth/renew`, #965)

Die Admin-UI-Sitzung ist ein zustandsloses HS512-JWT mit 4h-Fenster
(`SESSION_WINDOW_S` in `auth/sessionCookie.ts`). Bisher war nach 4h
zwingend ein neuer Login fällig; die Warnkarte im `SessionWatcher` bot nur
„Jetzt neu anmelden“. Jetzt verlängert ein Klick auf „Ich bin noch da“ die
Sitzung ohne Navigation.

- **Claim `auth_time`** (`auth/sessionJwt.ts`): Zeitpunkt der
  *ursprünglichen* Anmeldung, überlebt jedes Re-Minting (anders als `iat`).
  `signSession` stempelt ihn beim Login; `verifySession` fällt bei alten
  Tokens ohne den Claim auf `iat` zurück.
- **Route** (`routes/authRenew.ts`, gemountet im Auth-Router). Reihenfolge,
  jeder Schritt fail-closed:
  1. `evaluateSessionToken` wie `requireAuth` (Cookie gültig, Whitelist,
     serverseitiger Widerruf): 401 `auth.missing` / `auth.invalid` /
     `auth.revoked`, 403 `auth.not_whitelisted`, 503 `auth.unavailable`
     (Widerrufs-Lookup fehlgeschlagen). Eine abgelaufene oder widerrufene
     Sitzung ist nicht verlängerbar, nur ersetzbar.
  2. Absolute Obergrenze: `now >= auth_time + cap` bzw. `exp` liegt schon auf
     der Grenze → 401 `auth.renew_expired`.
  3. Provider noch aktiv, `users`-Zeile vorhanden und `active`, und sie deckt
     die Sitzung noch (gleiche Zeile `uid`, gleiche `session_version` `sv`)
     → sonst 401 `auth.renew_denied`. Gilt für lokale und Entra-Zeilen.
  4. OIDC: `OidcProvider.revalidateSession` (Entra: Refresh-Token einlösen,
     `oid`/E-Mail/Whitelist prüfen, rotierten Token speichern). `denied` →
     401 `auth.renew_denied`, `unavailable` (Netz, 5xx, 429) → 502
     `auth.renew_idp_unavailable`. Ein OIDC-Provider ohne die Methode wird
     abgelehnt.
  5. Audit-Zeile `auth.session_renew` (`actor.id` = users-UUID, #775),
     **vor** dem Cookie: scheitert der Audit-Write, gibt es 500 und kein
     neues Cookie.
  6. Gleiche Claims neu signiert (`auth_time`, `sv`, `sid` werden
     übernommen; `uid` ist die Zeile, die Schritt 3 geprüft hat — dieselbe
     `id`, bei einem Alt-Token ohne `uid` erstmals gesetzt),
     `exp = min(now + 4h, auth_time + cap)`.
     Antwort `{ expires_at, server_now, renewable_until }`.
- Ohne `renewal`-Deps im `AuthDeps` (Test-Harnesses) antwortet `/renew` mit
  503 `auth.renew_unavailable`.
- **`GET /me`** liefert zusätzlich `renewable_until` (`auth_time + cap`,
  `null` ohne Renewal). Die UI zeigt damit im letzten Fenster vor der Grenze
  direkt „Neu anmelden“ statt eines Klicks, der sicher abgelehnt wird.
- **`POST /logout`** beendet die Sitzung serverseitig (siehe unten): ist das
  vorgelegte Cookie noch gültig, zählt es `users.session_version` hoch und
  beendet damit **alle** Sitzungen dieses Users auf allen Geräten; bei
  Entra-Sitzungen wird zusätzlich der Refresh-Token vergessen
  (`RefreshStore.forget`). Ein schon widerrufenes Cookie ändert serverseitig
  nichts (die Route ist öffentlich), es bekommt nur sein Cookie gelöscht.
- **UI** (`web-ui/app/_components/SessionWatcher.tsx`, `renewSession()` in
  `_lib/api.ts`): Erfolg setzt die Phase von `warning` zurück auf `normal`
  und plant die Timer neu. Ein Heartbeat, der vor der Verlängerung losging,
  darf die Ablaufzeit nicht wieder verkürzen (höchstes gesehenes `exp`
  gewinnt). Abgelehnt → „Neu anmelden“, Fehler → „Erneut versuchen“. Das
  Ablauf-Overlay verlangt weiterhin einen echten Login.

Obergrenze: `AUTH_SESSION_MAX_LIFETIME_HOURS` (§10). Sicherheitsbegründung
und Restrisiken: `docs/security-architecture.md` → „Session renewal“.

Tests: `test/auth/renewRoute.test.ts`, `test/auth/entraProviderRevalidate.test.ts`,
`test/auth/sessionJwt.test.ts`, `web-ui/app/_components/__tests__/SessionWatcher.test.tsx`.

#### Serverseitiger Sitzungs-Widerruf (`users.session_version`)

Ohne Serverzustand konnte nichts eine Sitzung vorzeitig beenden: Abmelden
löschte nur das Browser-Cookie, ein Admin-Passwort-Reset nur den Hash, und eine
Kopie des Cookies lief bis `exp` weiter (und ließ sich bis zur Obergrenze
verlängern). Jetzt gibt es einen Marker pro User.

- **Migration** `src/auth/migrations/0003_users_session_version.sql`:
  `users.session_version INTEGER NOT NULL DEFAULT 0`, additiv und idempotent.
- **Claims** (`auth/sessionJwt.ts`): `sv` (Version der Zeile beim Minten),
  `uid` (`users.id`, bindet das Token an genau diese Zeile) und `sid`
  (Zufalls-ID pro Anmeldung, wird noch nicht geprüft). Alte Tokens ohne `sv`
  gelten als Version 0 — so startet jede bestehende Zeile, das Upgrade meldet
  also niemanden ab. Ohne `uid` bindet ihre Anmeldezeit (`auth_time`, ganze
  Sekunden) sie an die Zeile: eine später angelegte Zeile (gelöscht und neu
  angelegt) trägt sie nicht, obwohl sie wieder bei Version 0 startet. Die
  erste Verlängerung setzt die `uid` der geprüften Zeile.
- **Prüfung** in `evaluateSessionToken` über `SessionRevocationGuard`
  (`auth/sessionRevocation.ts`, in `index.ts` einmal gebaut und nach
  `new UserStore(graphPool)` per `attach` verdrahtet): Zeile weg, `disabled`,
  andere `id` oder andere Version → 401 `auth.revoked`. Lookup fehlgeschlagen
  → 503 `auth.unavailable` (Ausfall, kein Urteil über das Cookie). Gilt für
  `requireAuth`, `ctx.operatorAuth` (`false`), das Channel-WebSocket-Upgrade
  (roh 401 bzw. 503), `POST /renew` und `GET /me` (60-s-Heartbeat des
  `SessionWatcher`). Kein Cache: ein Point-Read pro Request.
- **Wer hochzählt**: `POST /logout` (nur mit noch gültigem Cookie),
  Admin-Passwort-Reset und Deaktivieren (`UserStore.update(id, {…,
  revokeSessions: true })`, im selben UPDATE wie Hash bzw. Status). Löschen
  braucht keinen Bump — ohne Zeile keine Sitzung, und eine neu angelegte
  Zeile hat eine neue `id` (und für Alt-Tokens ohne `uid` ein jüngeres
  `created_at` als deren Anmeldung). Das eigene Passwort zurückzusetzen meldet
  auch einen selbst ab.
- **Login-Pfade** stempeln `sv`/`uid` aus der geprüften Zeile: Passwort-Login
  aus demselben Read wie die Hash-Prüfung (`PasswordAuthSuccess.account`),
  OIDC-Callback aus der upserteten Zeile (für eine deaktivierte Zeile wird
  keine Sitzung mehr gemintet), `/setup` aus der neu angelegten.
- **Offene Verbindungen**: Channel-WebSockets schließt die Registry über
  denselben Guard (`WebSocketRegistryDeps.sessions`): `onRevoked` sofort auf
  dieser Replica (4403), auf allen anderen vor dem nächsten Frame, sobald
  dessen letzte Prüfung älter als `WS_SESSION_FRAME_RECHECK_MS` (5 s) ist,
  bzw. im 60-s-Sweep, solange der Socket schweigt, und am `exp` des Tokens
  mit 4401 — Details im Abschnitt „Canvas WebSocket-Transport (Omadia UI,
  PR-11)“. Der Builder-SSE-Stream bleibt nach einem Widerruf noch offen —
  siehe §13.

Tests: `test/auth/sessionRevocation.test.ts`,
`test/auth/logoutRevokesSession.test.ts`,
`test/auth/userStoreSessionVersion.test.ts` (+ `.pg.test.ts`),
`test/auth/adminUsersRoute.test.ts`, `test/webSocketRegistry.test.ts`.

### Ersteinrichtung `POST /api/v1/auth/setup`: atomar und mit Setup-Token

Der Wizard legt den ersten Admin an und liegt unter dem öffentlichen
`/api/v1/auth/*`-Präfix, weil es noch keinen Operator gibt. Die Route steckt seit
dieser Änderung in `routes/authSetup.ts` (wie `/renew` in `authRenew.ts`) und prüft in
dieser Reihenfolge:

1. **Setup-Token** (`auth/setupToken.ts`), vor allem anderen: Body-Feld
   `setup_token`, konstant-zeitlicher Vergleich. Fehlt es oder ist es falsch, gibt es
   403 `auth.setup_token_invalid`. Ein Aufrufer ohne Token bringt den Server damit
   weder zum Body-Validieren noch zu argon2 noch zum Tabellen-Lock. Einen Header gibt
   es nicht.
2. **`resolveSetupState`**, dasselbe Prädikat, das `GET /providers` als
   `setup_required` meldet, in dieser Reihenfolge: 410
   `auth.setup_no_local_provider`, 410 `auth.setup_locked` (es gibt Nutzer, egal was
   der Boot entschieden hat, also wie bisher), 410 `auth.setup_disabled` (Tabelle
   jetzt leer, beim Boot aber nicht; ein Neustart öffnet den Wizard wieder).
3. Body-Validierung und optionaler Anthropic-Key-Ping (OB-61, unverändert), dann
   argon2 **außerhalb** des Locks, in einem Slot der globalen argon2-Kapazität des
   Anmelde-Limiters (`acquireSlot()`; keiner frei → 503 `auth.busy` mit
   `Retry-After`, siehe „Passwort-Anmeldung mit Rate-Limit“).
4. **`UserStore.createFirstAdmin`**: eine Transaktion mit `SET LOCAL lock_timeout =
   '2000ms'`, `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, `COUNT(*)` unter dem
   Lock, INSERT, Audit-Zeile `auth.first_admin_create`, Löschen des gespeicherten
   Setup-Tokens, COMMIT. `not_empty` wird zu 410 `auth.setup_locked`, ein Lock-Timeout
   (55P03) zu 409 `auth.setup_in_progress`. Der Lock wartet auch auf Writer außerhalb
   dieses Pfads (OIDC-Erstanmeldung, Admin-UI-Create). Plain-SELECTs blockiert er nicht.
5. Session-Cookie, das Geräte-Cookie des Anmelde-Limiters (an die eben geschriebene
   Zeile und ihren Hash gebunden), `markLoginNow`, Antwort wie bisher.

Woher das Token kommt (Boot-Wiring `initSetupToken` in `index.ts`):

- `ADMIN_SETUP_TOKEN` gesetzt → dieses Token, es wird nie geloggt.
- Kein Setup auf diesem Boot → kein Token, ein altes gespeichertes wird gelöscht.
- Desktop-Kernel (`OMADIA_DESKTOP_EMBEDDED=true` **und** Loopback-`HOST`) → kein Token.
  Eine Hälfte allein reicht nicht.
- Sonst generiert, set-if-absent in `platform_settings` (`auth.setup_token`)
  gespeichert, also auf allen Replicas und über Neustarts gleich, und einmal pro Start
  geloggt: `[auth] bootstrap: /setup wizard unlocked — setup token: …`.

`GET /providers` liefert zusätzlich `setup_token_required`. Die Setup-Seite der Web-UI
fragt das Token nur dann ab und zeigt für 403, 409 und beide 410-Codes eigene Texte.
Der Env-Seed (`ADMIN_BOOTSTRAP_*`, `auth/bootstrap.ts`) läuft ebenfalls über
`createFirstAdmin`. Verliert eine Replica das Rennen, loggt sie einen Skip statt an
23505 zu sterben. Den ungenutzten Präfix `/api/v1/setup` gibt es in
`auth/publicPaths.ts` nicht mehr; in `CORE_RESERVED_ROOTS` bleibt er, damit kein
Plugin ihn beanspruchen kann.

Sicherheitsbegründung und Restrisiken: `docs/security-architecture.md` §10l.
Konfiguration: §10 „Ersteinrichtung“.

Tests: `test/auth/setupRoute.test.ts`, `test/auth/setupToken.test.ts`,
`test/auth/userStoreFirstAdmin.test.ts`, `test/auth/bootstrap.test.ts`, gegen echtes
Postgres `test/auth/userStoreFirstAdmin.pg.test.ts` und
`test/auth/setupRouteConcurrency.pg.test.ts`; UI
`web-ui/app/setup/__tests__/page.test.tsx`; Desktop
`desktop/test/supervisorKernelEnv.test.mts`.

### Passwort-Anmeldung mit Rate-Limit (`POST /api/v1/auth/login/:providerId`)

Der Handler steckt seit dieser Änderung in `routes/authLogin.ts` (wie `/renew` und
`/setup`), der Limiter in `auth/loginRateLimiter.ts`. Reihenfolge, das Billigste zuerst:

1. Unbekannter oder Nicht-Passwort-Provider → 404 `auth.unknown_provider`, ohne Budget
   und ohne argon2.
2. **Limiter** mit drei Schichten, nacheinander. Welche greifen, hängt von der Art des
   Client-Keys ab (`LoginClientKind`): `device` (gültiges Geräte-Cookie für das Konto),
   `address` (eine Adresse, für die ein vertrauenswürdiger Proxy bürgt: `xff:<n>`,
   `header:<name>`) oder `shared` (der TCP-Peer, in jeder ausgelieferten Topologie ein
   Proxy, hinter dem alle Browser stehen).
   - **Client** (nur `address`): Leaky Bucket über Fehlversuche, Burst 100, danach einer
     pro 6 s. Voll → 429 `auth.rate_limited`, Retry-After höchstens 15 s. Ein
     `shared`-Key fällt heraus: Ein einzelner Absender würde ihn füllen und dann jeden
     6-s-Schritt selbst nehmen, und alle Browser hinter dem web-ui-Proxy bekämen 429.
     Ein `device`-Key sieht nur sein eigenes Konto, dort ist die Paar-Schicht strenger.
   - **Konto × Client** (Paar, alle Arten): 5 freie Fehlversuche, dann Wartezeit
     1 s × 2^(Fehlversuche − 5) ab dem letzten, gedeckelt auf 2 min → 429. Ein Erfolg
     löscht das Paar, 30 min nach dem letzten Fehlversuch wird es vergessen. Das Konto
     ist die eingegebene Adresse, mindestens so grob gefaltet wie die Users-Tabelle
     vergleicht (`loginAccountKey` in `auth/loginAccount.ts`): Postgres' `LOWER()`
     macht aus einem großen İ (U+0130) ein schlichtes i und aus jedem Σ ein σ, JS'
     `toLowerCase()` dagegen i plus Kombinationspunkt bzw. am Wortende ς. Der Schlüssel
     zerlegt deshalb per NFKD, wirft kombinierende Zeichen weg, schreibt klein und faltet
     ı zu i und ς zu σ; keine Schreibweise einer Adresse bekommt ein zweites Budget.
     `LocalPasswordProvider` meldet nur ein Konto an, dessen gespeicherte Adresse auf
     denselben Schlüssel faltet.
   - **Global**: höchstens `AUTH_LOGIN_MAX_INFLIGHT` argon2-Läufe gleichzeitig und ein
     Leaky Bucket, der 300 zugelassene Versuche pro Minute abfließen lässt → 503
     `auth.busy`. Ohne Geräte-Cookie gibt es höchstens alle Slots bis auf einen und den
     Bucket bis 240; den letzten Slot und die letzten 60 kann nur `device` nehmen.
     Verbraucht nur, was die ersten beiden Schichten zugelassen haben.

   Jede Ablehnung trägt `Retry-After` und `retry_after_s`, setzt kein Cookie und ruft
   `verify` nicht auf. Gezählt wird bei der Zulassung: Ein laufender Versuch zählt bis
   zum Ergebnis als Fehlversuch, parallele Anfragen überholen das Budget also nicht.
3. `provider.verify` (argon2) im zugelassenen Versuch. Alles außer Erfolg ist ein
   Fehlversuch, auch ein Throw. Der globale Slot wird im `finally` frei.
4. Erfolg: Session-Cookie plus ein frisches **Geräte-Cookie** `omadia_login_device`
   (`auth/loginDeviceCookie.ts`, `auth/loginDevices.ts`): `v3.<id>.<exp>.<ep>.<tag>`,
   einmal pro Anmeldung, für das Konto, das der Provider **verifiziert** hat (dessen
   gespeicherte Adresse, nie die eingegebene). `ep` ist ein Fingerabdruck der
   Konto-Epoche, gegen die die Anmeldung geprüft hat (SHA-256 über die Users-Zeilen-id
   und den Passwort-Hash, mit dem der Provider verglichen hat:
   `AuthSuccess.credentialEpoch`; beim Setup-Wizard die gerade geschriebene Zeile), nie
   einer danach gelesenen: Landet ein Reset, während eine Anmeldung mit dem alten
   Passwort noch geprüft wird, ist deren Cookie von Anfang an veraltet, statt an das neue
   Passwort gebunden zu sein, das sie nie bewiesen hat. `tag` ist ein HMAC über den
   Geräte-Schlüssel des Kontos (`loginDeviceAccountKey`: gespeicherte Adresse, nur
   ASCII-Buchstaben klein), id, Ablauf und `ep`; die Schlüssel für Tag und Fingerabdruck
   sind aus dem Session-Signing-Key abgeleitet, je einer pro Zweck. Der Geräte-Schlüssel
   ist bewusst **nicht** der gefaltete Konto-Schlüssel des Limiters: Der wirft Schreibweisen
   verschiedener Konten zusammen, und das Cookie eines Kontos zählte dann für das
   andere. Ein Jahr gültig, HttpOnly/SameSite=Lax/Path=/. Bekannter Browser ist eine
   Anfrage, deren Adresse den Geräte-Schlüssel des Cookies hat und deren Users-Lookup
   über diesen Schlüssel auf der Zeile landet, für die es ausgestellt wurde, unter deren
   aktueller Epoche; nur ASCII-Kleinschreibung hält diesen Lookup dort, wo der Lookup der
   eingegebenen Adresse landet. Dann ist der Client-Key `device:<id>` statt der Adresse.
   Alle bekannten Browser eines Kontos teilen sich **ein** Paar: Weitere Geräte-ids
   bringen weder weiteres Budget noch einen weiteren Anteil an der Reserve. Hinter dem
   web-ui-Proxy teilen sich sonst alle Browser eine Adresse, und die Fehlversuche eines
   Angreifers würden den Operator mit bremsen. Passwort-Reset, Deaktivieren und Löschen
   machen frühere Cookies wertlos (neuer Hash bzw. keine Epoche); `routes/adminUsers.ts`
   ruft dafür (und beim Anlegen) `loginDevices.forget` mit dem Geräte-Schlüssel, damit
   der 10-s-Cache der Epoche sofort neu liest. Nachgeschlagen wird die Epoche nur für
   ein Cookie, dessen Tag stimmt, und pro Geräte-Schlüssel nur einmal gleichzeitig. Nur
   eine Passwort-Anmeldung (und der Setup-Wizard) stellt das Cookie aus; eine Session
   allein nicht, `GET /me` und `/renew` setzen keins.

Der Client-Key kommt aus `AUTH_LOGIN_CLIENT_ADDRESS` (`auth/clientAddress.ts`): `socket`
(Default), `xff:<n>` (n-ter `X-Forwarded-For`-Eintrag von **rechts**) oder
`header:<name>`, nie `req.ip`. `clientAddressFor` liefert `{ key, shared }`: der
Socket-Peer (Default oder Rückfall) ist `shared`. Der Wert muss eine IP sein, sonst gilt
der Socket-Peer. IPv6 zählt pro Präfix, `AUTH_LOGIN_IPV6_PREFIX` Bit lang (Default 64).

Bleibt offen: Wer sich einen Key teilt, teilt dessen Paare. Ein Absender, der alle
2 Minuten auf ein Konto falsch rät, hält das Paar für jeden Browser ohne Geräte-Cookie
auf demselben Key zu, etwa für die erste Anmeldung auf einem neuen Gerät. Vor argon2
lässt sich der Browser nicht vom Absender unterscheiden (§10m „What stays open“).
Ebenso teilen sich die bekannten Browser eines Kontos ihr Paar: Wer ein aktuelles
Geräte-Cookie hält (dazu braucht es eine Anmeldung mit dem Passwort), kann sie warten
lassen, bekommt aber nur ein Budget pro Konto. Reaktivieren ohne Passwort-Reset lässt
frühere Cookies wieder gelten; ihre Inhaber gewinnen dadurch nichts, sie haben sich alle
mit genau diesem unveränderten Passwort angemeldet. Konten, deren Adressen auf denselben
Schlüssel falten (Akzente, Kompatibilitätsformen, Kombinationspunkt), teilen sich alle
Paare, auch das der bekannten Browser.

Weitere Stellen: `/setup` holt sich für seinen argon2-Hash einen globalen Slot
(`acquireSlot()`, sonst 503 `auth.busy`) und setzt nach Erfolg ebenfalls das
Geräte-Cookie. Admin-Passwort-Reset und Reaktivierung (`PATCH status: 'active'`) in
`routes/adminUsers.ts` rufen `clearAccount` mit dem gefalteten Konto-Schlüssel (alle
Schreibweisen); Anlegen, Reset, jede Statusänderung und Löschen rufen
`loginDevices.forget` mit dem Geräte-Schlüssel. `LocalPasswordProvider` lehnt Passwörter
über 1024 Zeichen vor dem Users-Lookup ab. Die erste Ablehnung pro (Schicht, Client)
und Minute schreibt eine Logzeile und eine Audit-Zeile `auth.login_rate_limited`, beide
ohne das Konto. Boot-Wiring: `createLoginGuard` in `index.ts`, ein Limiter und ein
Geräte-Cookie-Register (`devices`) pro Prozess, dieselben für Auth-Router und
Admin-Users-Router. Ein Auth-Router ohne `loginLimiter`-Dep baut sich beides selbst mit
Defaults. Die Login-Seite zeigt für beide Codes „bitte N Sekunden warten“
(`login.tooManyAttempts`).

Sicherheitsbegründung und Restrisiken (u. a. in-memory pro Prozess, Replicas
multiplizieren die Grenzen): `docs/security-architecture.md` §10m. Konfiguration: §10
„Anmelde-Rate-Limit“.

Tests: `test/auth/loginRateLimiter.test.ts`, `test/auth/loginRateLimiterFairness.test.ts`,
`test/auth/clientAddress.test.ts`, `test/auth/loginRoute.test.ts`,
`test/auth/loginLockoutDos.test.ts`, `test/auth/loginDevices.test.ts`,
`test/auth/loginDeviceRevocation.test.ts`, `test/auth/loginAccount.test.ts`,
`test/auth/loginAccountAliases.test.ts` (Harness in `test/auth/loginHarness.ts`, mit
dem echten Admin-Users-Router und einer Users-Tabelle, die wie Postgres' `LOWER()`
vergleicht), `test/auth/adminUsersRoute.test.ts`, `test/auth/localPasswordProvider.test.ts`;
Postgres `test/auth/loginAccountFold.pg.test.ts`; UI
`web-ui/app/login/__tests__/page.test.tsx`.

### Replay-Ledger: ein Verifier-Wiedereintritt führt keinen Write aus

`VerifierService` betritt in `enforce` einen Turn erneut — Borderline-Resample
(`chat()`), Correction-Retry (`chat()` und Stream, nicht bei Canvas-Turns).
Früher war jeder Wiedereintritt ein kompletter neuer Turn, der alle Tools des
Modells wieder ausführte; ein Write lief so zwei- bis dreimal pro Nachricht.
Jetzt erzeugt ein Wiedereintritt nur die Antwort neu:

- **Bindung.** `bindRequestLedger` (`verifierReentry.ts`) legt vor dem ersten
  Lauf einen `ToolReplayLedger` (`toolReplayLedger.ts`) an und bindet ihn per
  `Orchestrator.bindToolReplayLedger(input, ledger)` an das Input-Objekt
  (WeakMap, wie `markScreeningReentry`; Rückgabe ist die Freigabe am Ende der
  Anfrage). Trägt der Input schon einen anderen Ledger, wirft die Bindung
  (zwei Anfragen auf einem Input-Objekt spielten sonst gegenseitig ihre
  Ergebnisse ab); ein Resample bindet den eigenen Ledger erneut.
  `runTurnCore`/`chatStream` lesen ihn in der **ersten** Zeile, vor
  dem Umbinden von `input`, und legen ihn als `turnContext.toolReplayLedger`
  ab. Ohne Bindung bekommt jeder Turn einen turn-lokalen Ledger ohne
  Ergebnisse (nur für die Wiederholungssperre unten).
- **Nähte.** `dispatchToolDeadlined` (Orchestrator), `LocalSubAgent.dispatch`
  (`subagent:<name>`) und `ToolDispatchService.invoke` (`dispatch`, CLI-Sub-
  Agent über den Loopback-Snapshot) fragen `decide()` vor dem Handler: im
  ersten Lauf `execute` + `record()` (Rohergebnis nach der Deadline-Firewall
  oder die geworfene Exception), im Wiedereintritt `replay` über Cursor pro
  (Naht, Tool, kanonischer Input), die `beginReentry()` zurücksetzt — Resample
  und Retry spielen also beide Lauf 1 ab. Fehlt ein Call: nur Kernel-Lese-
  Tools (`replayClassOf`: KG-Abfrage, `query_dataset`, `read_attachment`,
  `find_free_slots`, Roster, Memory-`view`) laufen frisch, alles andere wird
  mit `replayMissNotice` verweigert und setzt `abortedTool`. Was ein Tool im
  ersten Lauf über seinen Attachment-Sink abgab (Diagramm, Office-Datei),
  hält der Ledger fest (`drainAttachments` → `recordAttachments`) und gibt es
  für im Wiedereintritt abgespielte Tools einmal pro Lauf zurück — bei einem
  Replay bleibt der Sink ja leer.
- **Abbruch.** Post-Batch-Check in beiden Tool-Loops und im `LocalSubAgent`,
  dazu der autoritative Check am Ende von `runTurnCore` bzw. am Terminal-Event
  im Stream (fängt Direct-Line und gefaltete Sub-Agent-Antworten).
  `ToolReplayAbortError` → Resample behält die erste Antwort, Retry hält sie
  mit `failed` zurück. Wirft ein Wiedereintritt aus anderem Grund, loggt
  `reentryFailureLine` nur Run-ID, Fehlerklasse und `reentry_turn_failed`,
  nie die Fehlermeldung. MCP-Input-Card-Antworten und aufgezeichnete
  MRTR-Sentinels/Connect-Prompts sind nicht abspielbar → Abbruch.
- **Sub-Agent unter Privacy Shield.** Hat ein Domain-Tool-Dispatch Datasets
  gebrückt oder ein Bypass-Tool genutzt, wird der Sub-Agent im
  Wiedereintritt neu ausgeführt (`rerun`), seine inneren Calls werden
  abgespielt und im neuen Scope neu interniert; sonst wird das Ergebnis samt
  Sub-Agent-Events (Trace, Postconditions) abgespielt.
- **Eine Anfrage, ein Datensatz — der gelieferte.** Ein Wiedereintritt feuert
  keine Per-Call-Hooks (`onBeforeTurn`, `onAfterToolCall`), ingestiert kein
  MCP-Ergebnis erneut in den KG und bucht keinen Bypass erneut. Der Trace
  markiert abgespielte Calls mit `replayed` (plugin-api 1.21.0).
  Commit-on-Delivery (`requestTurnRecord.ts`): Solange ein Request-Ledger
  gebunden ist (`defersTurnRecord`), schreibt **kein** Lauf — auch nicht der
  erste — Session-Log/Fact-Extraction/Auto-Promotion oder feuert
  `onAfterTurn`; jeder Lauf bietet seine Zeile an (`TurnRecordWriter`,
  `turnRecordWriter.ts`: `recordRow` / `offerRow` →
  `ledger.turnRecord.offer(pass, …)`) und notiert seine Antwort
  (`Orchestrator.afterTurn` → `noteAnswer`). Der Verifier committet nach dem
  Urteil den gelieferten Lauf (bei Zurückhalten den, über den das Endurteil
  ging): `asRequestResult` / `finishRequestDone` →
  `turnRecord.commit(pass)`; `prepareReentry` liefert die Pass-Nummer. Die
  Zeile trägt die Entities aller Läufe, wird im Turn-Scope ihres Laufs
  geschrieben (`AsyncLocalStorage.snapshot()`, wegen Usage-Attribution),
  danach `onAfterTurn` im Hook-Kontext des ersten Laufs (der Plan-Runner
  hängt dort); `onVerifierBlocked` wartet auf den Commit
  (`afterRequestRecord`), damit er wie vorher nach `onAfterTurn` kommt.
  `done.turnId` nennt die committete Zeile. Ohne Lieferung committet das
  `finally` den ersten Lauf. Die Receipts aller Läufe sammelt
  `ledger.receipts` (`requestReceipts.ts`); geliefert wird das gemergte
  Receipt, und genau **eine** `turn_receipts`-Zeile wird nach dem letzten
  Lauf geschrieben (`receiptId` im Stream). Ein Lauf, der wirft oder dessen
  Stream vor `done` endet (`error`, Client weg — auch schon im Vorlauf, an
  den `onBeforeTurn`-Annotationen nach einem MCP-Input-Card-Replay),
  übergibt nichts; der Orchestrator schließt ihn selbst
  (`closeUndeliveredPass`, samt Auth-Kontext) und behält sein Receipt — in
  der Zeile der Anfrage oder ohne Request-Ledger als eigene Zeile. Vorher
  wurde es verworfen. Jeder Lauf mit Receipt bietet an, die Zeile zu
  besitzen; sie gehört dem frühesten (`BoundPass`: Pass-Nummer bei
  Laufbeginn, nicht Finalisierungs-Reihenfolge) — dem ersten Lauf, sobald er
  ein Receipt hat, sonst dem frühesten Wiedereintritt mit einem. Eine
  Anfrage, deren einziges Receipt von einem abgebrochenen, geworfenen oder
  verlassenen Wiedereintritt stammt, bekommt so trotzdem ihre Zeile.
- **Abgekoppelte Arbeit.** Der Runner eines langlaufenden Tasks
  (`<tool>_start`, `tasks/longRunningTool.ts`) startet unter
  `runDetachedFromRequestLedger` mit eigenem turn-lokalem Ledger: er läuft
  nach dem Turn weiter, auch während eines Wiedereintritts, und darf weder
  gegen den Replay-Modus der Anfrage laufen (Miss → Task `failed`,
  Wiedereintritt abgebrochen) noch deren Rohergebnisse am Leben halten.
- **Wiederholungssperre.** Unabhängig vom Verifier verweigert jede Naht die
  identische Wiederholung eines Write-Calls, dessen Ausgang unbekannt ist
  (geworfen oder Withheld-Notiz), für die ganze Anfrage — damit auch in den
  Eltern-Loops und beim CLI-Sub-Agent (offener Punkt aus der
  Tool-Fehler-Politik, §13).
- **Uploads einmal pro Anfrage.** `ingestAttachments` läuft vor dem Modell und
  außerhalb des Tool-Dispatch; ein CSV/XLSX wird dabei per
  `importTabularDataset` → `KnowledgeGraph.ingestDataset` als **neues**
  Dataset angelegt (kein Dedupe). Beide Pfade rufen deshalb
  `ingestAttachmentsForPass` → `ledger.ingestAttachmentsOnce`: Lauf 1
  ingestiert und hält das Ergebnis (Text/`[dataset-imported]`-Blöcke **vor**
  dem Masking, Bild-Blöcke), jeder Wiedereintritt bekommt genau das zurück
  und maskiert es über seine eigene Prompt-Map — gleiche `dataset_id` wie in
  den abgespielten Tool-Ergebnissen. Findet ein Wiedereintritt nichts,
  bricht er vor dem Modellaufruf ab (`REENTRY_ABANDONED.attachmentsNotRecorded`).
  Single-Flight: ein Lauf, der fragt, während der erste Import noch läuft,
  wartet auf diesen Import, statt einen zweiten zu starten.
- **Correction-Hint = Wire-Inhalt.** `wireExtraSystemHint` maskiert den
  `extraSystemHint` des Aufrufers über die Prompt-Map des Laufs wie die
  User-Nachricht (gleiche Surrogate, Spans im Receipt → `maskedPromptSpans`
  im gemergten Request-Receipt); der Fresh-Check-Text des Kernels bleibt
  unmaskiert. `PromptMaskBlockedError` in einem Wiedereintritt bricht ihn ab
  (`REENTRY_ABANDONED.promptMaskBlocked`) statt die Privacy-Fehlerantwort zu
  liefern; der erste Lauf behält sein Verhalten. Hinter einem Shield schickt
  der Verifier einen Hint, den die Maskierung des widersprochenen Laufs
  verändern würde, gar nicht (`privacySafeCorrection` → Retry zurückgehalten,
  Badge `failed`); ein Hint, der durchgeht, wird genau einmal maskiert, vom
  Retry-Lauf selbst. `buildCorrectionPrompt`
  (`@omadia/verifier`) nennt nur noch die Claims (Wortlaut der Antwort),
  Call-IDs und feste Anweisungen — kein `truth`, kein `detail`, keine
  Postcondition-Issues: die Evidenz holt der Verifier mit eigenem Zugriff
  (KG mandantenweit, Odoo-Reader des Plugins), nicht mit den Grants des Users.
  Abbruchgründe ohne Tool tragen Namen (`REENTRY_ABANDONED`,
  `describeAbandonment`, `reentryAbandonment.ts`), die Log-Zeilen nennen sie.
- **Unterhalb des Ledgers.** Solange ein Request-Ledger gebunden ist, läuft
  der Handler jeder Naht über `runHandlerAtMostOnce` (`toolReplayLedger.ts`,
  auch der MCP-Input-Card-Replay): das Signal `sendsEachCallOnce`
  (`toolIdempotency.ts`, eigener AsyncLocalStorage — übersteht die Re-Scopes
  von Skill-Bindung und `ctx.mcp`) lässt `McpManager.callTool` nur einen
  Versuch machen, also keinen Transport-Retry nach einem transienten Fehler,
  der „ausgeführt, Antwort verloren“ nicht von „nie ausgeführt“
  unterscheiden kann. Turns ohne Request-Ledger behalten den einen Retry
  (#542; offener Punkt in §13). Wirft `internToolResultV4`, geben alle Nähte
  (Orchestrator-Dispatch, `LocalSubAgent`, `ToolDispatchService`,
  MCP-Input-Card-Replay) die Notiz `internFailedNotice`
  (`privacyInternPolicy.ts`) statt des Rohergebnisses ans Modell, im ersten
  Lauf wie im Wiedereintritt; `query_dataset` behält seinen eigenen Text.

Schalter: `verifier_resample_on_borderline` (§10). Sicherheitsbegründung,
Grenzen und Reviewer-Regeln: `docs/security-architecture.md` §7c und §11.
Tests: `test/toolReplayLedger.test.ts`, `test/toolReplaySeams.test.ts`,
`test/verifierServiceWriteSafety.test.ts`, `test/verifierStreamRetry.test.ts`,
`test/verifierReentryRecords.test.ts`, `test/verifierDeliveredTurnRecord.test.ts`,
`test/requestTurnRecord.test.ts`,
`test/verifierSubAgentReplay.test.ts`, `test/verifierResampleKillSwitch.test.ts`,
`test/longRunningTaskReplayLedger.test.ts`,
`test/orchestrator/parentLoopThrownCallRepeat.test.ts`,
`test/verifierReentryAttachments.test.ts`,
`test/verifierCorrectionHintPrivacy.test.ts`,
`test/correctionPromptEvidence.test.ts`, `test/mcpWriteIdempotency.test.ts`,
`test/orchestrator/internFailureFailsClosed.test.ts`,
`test/orchestratorPrivacyEgress.test.ts`.

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
dass man ihn zwingt. `find_entity` (und das Sub-Agent-Tool `query_graph`)
bleiben bei `name_contains`, also einer Substring-Suche.

### Exakte Entity-Auflösung: `findEntities({ model, id })` (plugin-api 1.21.0)

`FindEntitiesOptions.id` adressiert genau einen Datensatz über seine Quell-ID
(`props.id`, Odoo-Record-ID oder Confluence-Page-ID). Beide Backends
vergleichen als String nach `trim()` (`7` ≡ `'7'`), eine fehlende oder leere
ID liefert `[]`, nie einen Nachbar-Datensatz; mit `nameContains` kombiniert
gelten beide Bedingungen. Die extras-Wrapper reichen `opts` unverändert durch.
`nameContains` bleibt Suche, keine Identität: `'7'` trifft 7, 17 und 70.

Der Verifier nutzt das an zwei Stellen: `GraphEvidenceFetcher` löst jedes
Entity-Handle mit ID (`odoo:hr.employee:7`, `hr.employee:7`) exakt auf und
prüft Modell/ID/System des Treffers nach; ein Claim mit so einem Handle
bekommt nur diese Datensätze (kein Modell-Sample, keine Namenssuche), fehlt
der Datensatz, bleibt der Claim `unverified`. `DeterministicChecker.checkGraph`
prüft `odooRecord.id` exakt; ein Miss ist dort ebenfalls `unverified` (der
Graph ist ein Teil-Spiegel, fehlend heißt nicht falsch). `EvidenceJudge`
stuft ein Verdikt, das einen anderen Datensatz eines gepinnten Modells zitiert,
auf `unverified` herab. Nur `OdooEntity`/`ConfluencePage` — Plugin-Namespaces
(`PluginEntity`) sind über `findEntities` nicht erreichbar. Begründung und
Grenzen: `docs/security-architecture.md` §7c.

### Structured Datasets — CSV Import (#430)

Separate Ablage neben dem eigentlichen Graph — bewusst KEINE Graph-Node-
Explosion pro Zeile (Node-Properties sind GIN-indexiert, siehe
`ingestEntities`-Doku). Relationale Sidecar-Tabellen `datasets` +
`dataset_rows` (Migration `packages/harness-knowledge-graph-neon/src/
migrations/0029_datasets.sql`); pro Dataset genau EIN `Dataset`-Graph-Node
(`PluginEntity`, `system='dataset'`) für Recall/Zitation.

- **Interface:** `KnowledgeGraph.{ingestDataset,listDatasets,getDataset,
  queryDatasetRows,deleteDataset}` plus das **optionale** `countDatasets`
  (`plugin-api/src/knowledgeGraph.ts`; `listDatasets` nimmt seit #532 auch
  `offset` — additiv, plugin-api 1.7.0), implementiert in
  `@omadia/knowledge-graph-neon` (echtes SQL) UND
  `@omadia/knowledge-graph-inmemory` (volle Parität, kein Stub). Die
  extras-Wrapper (captureFiltering/inconsistencyTriggering/mergeTriggering)
  reichen `countDatasets` nur durch, wenn der innere Graph es kann —
  keine fabrizierten Totals.
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

### Cross-Referenz: `get_chat_participants` (#1108) ist kein Skill

Ebenfalls ein natives Orchestrator-Tool ohne eigenen
`skills/<name>/SKILL.md`-Ordner. Volle Doku in §3
("`get_chat_participants` — per-Turn-Roster-Gating"): das Tool wird nur auf
Turns angeboten, die einen Roster-Provider führen, und liefert bei
Fehltreffern ein strukturiertes deutsches Ergebnis statt eines
`Error:`-Strings.

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

### Admin-UI-Sitzung (#965)

| Variable | Wirkung |
|---|---|
| `AUTH_SESSION_MAX_LIFETIME_HOURS` | Absolute Obergrenze einer Verlängerungskette in Stunden, gemessen ab der **ursprünglichen** Anmeldung (`auth_time`), nicht ab der letzten Verlängerung. Default `12`, erlaubt `4`–`168` (zod-validiert beim Boot). Jeder Login und jede „Ich bin noch da“-Verlängerung gibt ein 4h-Fenster, geklemmt auf diese Grenze; danach antwortet `POST /api/v1/auth/renew` mit 401 `auth.renew_expired` und die UI verlangt einen neuen Login. Werte unter 4 wären sinnlos, weil schon das Login-Fenster 4h lang ist. |

Die Obergrenze bindet nur Sitzungen, die niemand beendet: Abmelden,
Admin-Passwort-Reset, Deaktivieren und Löschen beenden alle Sitzungen des
Users sofort (`users.session_version`, §3 „Serverseitiger Sitzungs-Widerruf“)
— ohne eigene Env-Variable.

| Variable | Wirkung |
|---|---|
| `WS_SESSION_FRAME_RECHECK_MS` | Offene Channel-WebSockets (Canvas): ein Frame erreicht das Plugin nur, wenn die Prüfung der Sitzung höchstens so viele ms vor seiner Ankunft begann; sonst liest die Registry die `users`-Zeile erneut (ein Point-Read), während der Frame wartet. Bestimmt, wie schnell ein Widerruf auf einer anderen Replica einen aktiven Socket stoppt (ein schweigender Socket wird alle 60 s geprüft). Default `5000`, erlaubt `0`–`60000` (zod-validiert beim Boot, ein leerer Wert heißt Default); `0` prüft jeden Frame. Ist die Zeile nicht lesbar, werden Frames abgewiesen (Canvas: `turn_error`), der Socket bleibt offen. Siehe „Canvas WebSocket-Transport (Omadia UI, PR-11)“. |

### Ersteinrichtung

Siehe §3 „Ersteinrichtung `POST /api/v1/auth/setup`“ und `docs/security-architecture.md` §10l.

| Variable | Wirkung |
|---|---|
| `ADMIN_SETUP_TOKEN` | Setup-Token, das der Wizard im Body-Feld `setup_token` verlangt. 16 bis 512 Zeichen (sonst bricht der Boot mit Config-Fehler ab), ein leerer Wert gilt als nicht gesetzt (`optionalNonEmpty`). Nicht gesetzt: Die Middleware generiert beim Start ein Token, speichert es in `platform_settings` (gleich auf allen Replicas und über Neustarts, bis der erste Admin existiert) und loggt es einmal pro Start (`setup token: …`). Ein gesetzter Wert wird nie geloggt. Wer den Wert vor dem ersten Start kennen will (etwa für ein Deploy-Skript), setzt ihn selbst (`openssl rand -base64 24`). |
| `OMADIA_DESKTOP_EMBEDDED` | `true`/`false`, Default `false`. Setzt **nur** der Supervisor der Desktop-App. Zusammen mit einer Loopback-`HOST` braucht der Wizard kein Token. Allein wirkt der Schalter nicht, und `HOST=127.0.0.1` ohne ihn auch nicht (Reverse-Proxy auf demselben Host). Nicht auf Servern setzen. |
| `HOST` | Bind-Adresse des Kernels, Default `::`. Für die Setup-Token-Ausnahme zählt nur eine literale Loopback-Adresse (`127.0.0.0/8`, `::1`, `::ffff:127.x`), kein `localhost`. |
| `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_BOOTSTRAP_DISPLAY_NAME` | Deklarativer Seed statt Wizard: Ist die `users`-Tabelle beim Boot leer und sind E-Mail und Passwort (mindestens 8 Zeichen) gesetzt, legt der Boot diesen Admin über `createFirstAdmin` an. Der Wizard bleibt dann zu. Ungültige Werte loggen den Grund und fallen auf den Wizard zurück. |

### Anmelde-Rate-Limit

Siehe §3 „Passwort-Anmeldung mit Rate-Limit“ und `docs/security-architecture.md` §10m.
Die Schwellen der drei Schichten und die Reserve für Geräte-Cookies sind Konstanten in
`auth/loginRateLimiter.ts`, nur die drei Einsatz-Fakten sind konfigurierbar.

| Variable | Wirkung |
|---|---|
| `AUTH_LOGIN_CLIENT_ADDRESS` | Woher der Limiter die Client-Adresse nimmt. `socket` (Default): der TCP-Peer, nicht fälschbar, gilt als geteilter Key (keine Client-Bremse); hinter einem Proxy teilen sich alle Clients dessen Adresse, das Geräte-Cookie trennt wiederkehrende Operatoren. `xff:<n>` (1..8): der n-te `X-Forwarded-For`-Eintrag von **rechts**, n = Zahl der vertrauenswürdigen Proxies davor, die die Client-Adresse an den Header **anhängen**. Compose hinter Caddy oder Traefik (hängen standardmäßig an) oder nginx mit `$proxy_add_x_forwarded_for`: `xff:1`, sofern nichts an diesem Proxy vorbei zum web-ui kommt; einmal mit ausgedachtem `X-Forwarded-For` prüfen, die Logzeile `[auth] login refused` muss die echte Adresse zeigen. `header:<name>`: ein Header, den die Edge **setzt**, genau eine Adresse. **Fly.io: `header:Fly-Client-IP`** (setzt `fly/middleware.fly.toml`), nicht `xff:1`: Fly stellt laut Doku die eigene IP der App rechts in `X-Forwarded-For`, damit hätten alle Clients denselben Key. Hinter Cloudflare `header:CF-Connecting-IP`, nur wenn die App nicht an Cloudflare vorbei erreichbar ist. Nie der linke `X-Forwarded-For`-Eintrag, den schreibt der Client. Ohne vorgeschalteten Proxy im Compose-Stack beim Default bleiben: Der web-ui-Proxy reicht den Header des Browsers unverändert durch, Next.js füllt ihn nur, wenn er fehlt. Ungültiger Wert → Config-Fehler beim Boot, leerer Wert = Default. |
| `AUTH_LOGIN_IPV6_PREFIX` | Wie viele führende Bit einer IPv6-Adresse einen Client ausmachen. Default `64`, erlaubt `32`–`64`. Ein /56 enthält 256 /64, ein /48 65.536, bei 64 jedes ein eigener Client-Key mit eigenem Burst. 56 oder 48 fasst so eine Zuteilung zu einem Key zusammen, aber auch fremde Clients, die sich eine teilen (Mobilfunk, Hoster). |
| `AUTH_LOGIN_MAX_INFLIGHT` | Gleichzeitige argon2-Läufe (Anmeldung und Setup-Hash), danach 503 `auth.busy`; einer davon bleibt Browsern mit Geräte-Cookie vorbehalten (bei `1` keiner). Default `4`, erlaubt `1`–`16`. Jeder Lauf braucht 19 MiB und einen Thread des libuv-Pools (`UV_THREADPOOL_SIZE`, Default 4); mehr Slots als Pool-Threads stehen nur Schlange. 16 × 19 MiB ≈ 300 MiB. |

### Test-Schalter (nicht von der Middleware gelesen)

Vier Variablen steuern nur Testverhalten, stehen aber in `.env.example`, weil
AGENTS.md jede Env-Variable an einer Stelle dokumentiert haben will:

| Variable | Wirkung |
|---|---|
| `OMADIA_EXPECT_LOOPBACK=1` | Die Loopback-MCP-Tests **scheitern** statt sich selbst zu überspringen, wenn die Sandbox keinen 127.0.0.1-Listener erlaubt. Ohne das meldet ein Runner ohne Listener die ganze Datei grün, ohne etwas zu prüfen (#1017). CI setzt es. |
| `OMADIA_CLI_LIVE_PROBE=1` | Startet die Live-Probe: echte `claude`-CLI mit dem Produktions-argv, die einen Shell-Befehl ablehnen muss. Kostet Abo-Kontingent und braucht eine eingeloggte CLI, daher opt-in. |
| `OMADIA_CLI_NEGATIVE_CONTROL=1` | Ergänzt die Probe um die Gegenprobe mit dem argv von vor #991, das erwartungsgemäß ein Built-in-Tool erreicht. Lässt die CLI dabei bewusst einen Shell-Befehl auf dieser Maschine ausführen, deshalb ein eigener Schalter. |
| `OMADIA_EMBEDDED_PG_IT=require` | Wird nur vom Desktop-Test `desktop/test/embeddedDb.integration.test.mts` gelesen (läuft mit `npm test` in `desktop/`), nicht von der Desktop-App. Die Datei **scheitert** dann, statt sich zu überspringen, wenn `desktop/node_modules` keine `@embedded-postgres`-Engine für die Plattform enthält oder der Test als root läuft (initdb verweigert root), und statt ihre pgvector-Prüfungen wegzulassen, wenn in der Engine kein pgvector eingespielt ist. Ohne den Schalter meldet ein solcher Lauf die Datei grün, obwohl er weniger oder nichts geprüft hat. Nur der Wert `require` wirkt. Der Workflow `desktop-apps` setzt ihn unter macOS und Linux, nachdem er pgvector eingespielt hat; unter Windows läuft der Test dort nicht, weil die Runner als Administrator laufen und `postgres.exe` unter einem solchen Konto nicht startet. |

### Privacy-Shield-Klammer

Wird vom Dispatch-Hook des Orchestrators gelesen
(`resolveEffectivePrivacyMode()` in `@omadia/plugin-api`, `privacyMode.ts`),
nicht über `config.ts`. Seit 2026-10-01 auch in `.env.example` dokumentiert,
weil das README die Variable nennt.

| Variable | Wirkung |
|---|---|
| `OMADIA_PRIVACY_FORCE_GUARDED` | Genau `true` klemmt jedes Tool-Plugin auf `guarded`, egal was in seinem `_privacy_mode` steht (`bypass`/`per_tool` und der Privacy-Bypass eines MCP-Servers, `mcpPrivacyBypass.ts`, wirken dann für das Ergebnis, das das Modell bekommt, nicht). Jeder andere Wert ist wirkungslos. Nicht erfasst ist die MCP→Knowledge-Graph-Ingestion (Epic #459, `Orchestrator.dispatchTool`): Sie läuft vor dem Bypass-Resolver und liest das Server-Flag direkt (`isMcpServerPrivacyBypassed`, nicht `resolveEffectivePrivacyMode`), also speichert ein Server mit `kgIngest` und `privacyBypass` auch mit Klammer bis zu 8.000 Zeichen jedes Rohergebnisses als Memory; spätere Turns können sie in den Prompt-Kontext holen, die Memory-Jobs schicken sie an ihren Provider (offen, §13). Ändert nur die Moduswahl: die Ausnahmen aus `docs/security-architecture.md` §6f (intern-exempte Tools, Control-Flow, Prompt-Text samt vom Channel wiederholtem Verlauf, Modellaufrufe außerhalb des Privacy-Handles) bleiben. Schaltet kein Prompt-Masking ein (`mask_user_prompt` bleibt eine Einstellung des Privacy-Guard-Plugins, Default aus) und erreicht keine Agenten auf dem Abo-CLI-Provider (`claude-cli`), die ohne Shield laufen (`docs/security-architecture.md` §3a). |

### Abo-CLI-Turn-Budget (OM-104, Beta-Runde 5)

Wird vom `@omadia/orchestrator`-Package gelesen (`resolveCliSpawnTimeoutMs()` in
`cliChatAgent.ts`), nicht über `config.ts`, weil das Package die Middleware-Config
nicht importieren kann.

| Variable | Wirkung |
|---|---|
| `OMADIA_CLI_SPAWN_TIMEOUT_MS` | Wanduhr-Budget **eines** CLI-geführten Chat-Turns (Shape 3) in Millisekunden, Default `600000`. Vorher fest 120 s ohne Override, während ein einzelner Aufruf des eigenen `query_seo_analyst`-Sub-Agenten 69–75 s dauert — zwei davon waren garantiert über dem Limit. Das Leerlauf-Limit (60 s ohne Ausgabe) bleibt getrennt bestehen. Nicht-numerische oder nicht-positive Werte werden ignoriert. Priorität: explizite `spawnTimeoutMs`-Dependency > ENV > Default. |

### Sandbox-Container-Limits (#576 `execute`, #581 `publish`)

Gelesen vom `@omadia/sandbox`-Package (`resolveSandboxResourceLimits()` in
`resourceLimits.ts`), nicht über `config.ts`. Gelten für jeden Docker-Container,
in dem Agent-Code läuft (Sandbox des `execute`-Tools und per `publish`
veröffentlichte Apps), also nur, wenn `sandbox_execute_enabled` bzw.
`sandbox_publish_enabled` an ist. Reihenfolge je Wert wie bei OM-104:
Orchestrator-Setup-Feld > ENV > Default. Die Setup-Felder sind Plugin-Konfiguration
(`manifest.yaml` des Orchestrators), keine Env-Variablen.

| Variable | Setup-Feld | Default | Wirkung |
|---|---|---|---|
| `OMADIA_SANDBOX_MEMORY_MB` | `sandbox_memory_mb` | `512` | `docker run --memory` **und** `--memory-swap` mit demselben Wert, in MiB, ganze Zahl von 6 bis 1048576 (1 TiB): der Container kann nicht über die Grenze hinaus auslagern. |
| `OMADIA_SANDBOX_CPUS` | `sandbox_cpus` | `1` | `--cpus` von 0.01 bis 1024, Bruchteile erlaubt (`0.5`). |
| `OMADIA_SANDBOX_PIDS_LIMIT` | `sandbox_pids_limit` | `256` | `--pids-limit`, ganze Zahl von 1 bis 4194304, Prozesse und Threads je Container. |

Leer, `0`, negativ, nicht numerisch oder außerhalb des Bereichs zählt als nicht
gesetzt; ein „unbegrenzt“ gibt es bewusst nicht. Docker liest nicht nur `0` als
„kein Limit“, sondern startet auch manche positiven Werte still ohne Limit
(`--cpus 0.000001` oder `1e64`, `--memory` ab 2^43 MiB oder als `1e+21m` auf
arm64); die Bereiche (`SANDBOX_RESOURCE_LIMIT_BOUNDS` in `resourceLimits.ts`)
schließen genau diese Werte aus. Neue Werte gelten für neu erstellte Container;
eine bestehende persistente Sandbox bekommt sie beim nächsten Wiederanhängen per
`docker update` (Best-Effort, ein Fehler landet im Log, der Container läuft mit
seinen alten Limits weiter). Die wirksamen Werte stehen beim Boot in der
Log-Zeile `sandbox_execute_enabled=true` bzw. `sandbox_publish_enabled=true`.
Details: `docs/security-architecture.md` §3b.

### Web-UI: Frame-Freigabe (`UI_FRAME_ANCESTORS`)

Gelesen vom **web-ui**-Prozess, nicht von der Middleware:
`web-ui/proxy.ts` setzt die Operator-UI-Header pro Request aus
`web-ui/app/_lib/securityHeaders.ts`.

| Variable | Wirkung |
|---|---|
| `UI_FRAME_ANCESTORS` | CSP-`frame-ancestors`-Quellenliste für alle Operator-Seiten, z. B. `"'self' https://teams.microsoft.com"` (ganzen Wert in doppelte Anführungszeichen setzen). Ungesetzt: `frame-ancestors 'none'` plus `X-Frame-Options: DENY`. Gesetzt: ersetzt `'none'`, `X-Frame-Options` entfällt, weil es keine Freigabeliste kennt. Ungültige Werte (`;`, `,`, andere Schlüsselwörter, Steuerzeichen) werden mit Warnung im web-ui-Log ignoriert, der Default bleibt. `/p/*` und `/bot-api/*` behalten immer die Header der Middleware. Pro Request gelesen, wirkt also ohne Rebuild auf einem veröffentlichten Image. |

Details: `docs/security-architecture.md` §10h.

### Answer-Verifier (`VERIFIER_*`)

Die Variablen werden beim ersten Boot einmal in die Setup-Felder des Plugins
`@omadia/verifier` migriert (`bootstrap.ts`, `verifier_*`); danach gelten die
Setup-Felder, nicht mehr die Env.

| Variable / Setup-Feld | Wirkung |
|---|---|
| `VERIFIER_ENABLED` / `verifier_enabled` | `true` schaltet den Verifier-Wrapper ein. Default `false`. |
| `VERIFIER_MODE` / `verifier_mode` | `shadow` (Default): prüft und speichert nur, die Antwort geht unverändert raus. `enforce`: Auslieferungs-Gate auf Stream **und** `chat()` — eine Antwort geht nur bei `approved` oder `skipped` (`no_trigger`/`no_claims`) raus, sonst eine Notiz (`answerSource: 'verifier-blocked'`); im Stream kommt bis zum Urteil kein Antworttext (§11, Security §7c). Eine von Privacy Shield gerenderte Antwort — hinter dem Shield ebenso ein Lauf ohne Privacy-Sicht (Direct-Line-Relay) — geht nie an den Verifier und wird zurückgehalten (`privacy_shield`), außer an einem Turn mit Input-Karte: Die Karten-Ausnahme (`releasesWithoutVerification`) greift vorher und gibt ihn samt gerenderter Antwort ungeprüft frei; `shadow` speichert für sie kein Verdict. Gilt nicht für den Abo-CLI-Runtime und nicht für Routinen. |
| `VERIFIER_MODEL` / `verifier_model` | Modell für Claim-Extraktion und Evidence-Judge. |
| `VERIFIER_MAX_CLAIMS` / `verifier_max_claims` | Höchstzahl geprüfter Claims pro Antwort, Default `20`. |
| `VERIFIER_AMOUNT_TOLERANCE` / `verifier_amount_tolerance` | Relative Betragstoleranz, Default `0.01`. |
| `VERIFIER_MAX_RETRIES` / `verifier_max_retries` | Correction-Retry nach einem Widerspruch in `enforce`, auf `chat()` (`/api/chat`, Scheduler, Conductor) und im Stream (nicht bei Canvas-Turns); `0` schaltet ihn ab, und hinter dem Shield entfällt er, wenn die Maskierung den Correction-Hint verändern würde. Default `1`, max `2`. Der Retry führt keinen aufgezeichneten externen Call erneut aus, er spielt ihn aus dem Replay-Ledger zurück; nur ein Sub-Agent, der hinter dem Shield Daten interniert oder ein Bypass-Tool gelesen hat, läuft neu, seine eigenen Calls wieder aus dem Ledger (§3 und Security §7c). |
| `VERIFIER_RESAMPLE_ON_BORDERLINE` / `verifier_resample_on_borderline` | `false` schaltet in `enforce` die zweite Stichprobe für Grenzfall-Antworten ab (nur `chat()`); jeder andere Wert lässt sie an. Default `true`. Die Stichprobe führt, wie der Retry, keinen aufgezeichneten externen Call erneut aus. Wie alle `VERIFIER_*` nur beim ersten Boot übernommen. |

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
# Turn receipts (#757)
RECEIPT_RETENTION_DAYS=90           # bounded retention for turn_receipts
# Odoo
ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY
ODOO_PROXY_MAX_BYTES=500000
ODOO_INSECURE_TLS=false             # true nur lokal bei Private-CA
# Confluence
CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_BASE_URL
CONFLUENCE_SPACE_KEY=HOME
CONFLUENCE_PROXY_MAX_BYTES=200000
# Transcription (#584 — transcription@1 capability)
TRANSCRIPTION_REALTIME_EXPERIMENTAL=1   # opt-in: gpt-live-transcribe Realtime-Pfad
                                        # (transcribeStream); Batch (gpt-transcribe)
                                        # läuft ohne Gate, sobald der Adapter
                                        # @omadia/transcription-adapter-openai
                                        # installiert + mit API-Key versorgt ist
# Optional endpoints
ADMIN_TOKEN                         # mount /api/admin (mutating memory; read-only
                                    # counters: /security/screening #749, /run-trace #1082)
DEV_ENDPOINTS_ENABLED=false         # mount /api/dev/* (Session-gated seit #669; Dev-Scaffolding)
DEV_ENDPOINTS_LOOPBACK_ONLY=false   # optional: /api/dev nur über Loopback (#669)
# Teams
MICROSOFT_APP_ID, MICROSOFT_APP_PASSWORD, MICROSOFT_APP_TYPE=MultiTenant,
MICROSOFT_APP_TENANT_ID
# Dataset-Link-Keys (`__k_*`-Spalten beim CSV/XLSX-Import, siehe §3 Dataset-Routen).
# Optional: leer ⇒ HKDF aus VAULT_KEY (Rotation von VAULT_KEY re-keyt dann auch
# die Link-Keys); gesetzt (>= 16 Zeichen) entkoppelt beides. Fehlt beides: keine Keys.
DATASET_LINK_KEY_SECRET                    # openssl rand -hex 32
# Diagram rendering (alle 7 müssen gesetzt sein, sonst wird Feature deaktiviert)
KROKI_BASE_URL=http://localhost:8765       # Kroki-Gateway (lokal aus compose.yml)
DIAGRAM_URL_SECRET                         # openssl rand -hex 32 — pro Env frisch
DIAGRAM_PUBLIC_BASE_URL=http://localhost:3979  # Base-URL für signierte URLs
DIAGRAM_SIGNED_URL_TTL_SEC=900             # 15 min
DIAGRAM_MAX_SOURCE_BYTES=64000             # Quellcode-Cap
DIAGRAM_MAX_PNG_BYTES=900000               # <1 MB Teams-Limit
# Object-storage (Tigris auf Fly, MinIO lokal — auto-provisioniert via `fly storage create`)
BUCKET_NAME, AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# Lokaler Attachment-Store ohne S3 (platform/attachmentStore.ts). Greift nur, wenn
# die vier S3-Werte NICHT alle gesetzt sind; wird als `tigrisStore` veröffentlicht.
# Die Desktop-App setzt ihn, wenn der Wizard-Schalter „Anhänge“ an ist.
# GET /health → attachments.store: 's3' | 'filesystem' | 'none' (nie Pfad/Bucket).
ATTACHMENT_STORE_DIR=/data/attachments     # Objekte unter sha256(key), 0700/0600, kein Ablauf
# Conductor generic webhooks (issue #437) — Kill-Switch für POST /api/hooks/:endpointId
CONDUCTOR_WEBHOOKS_ENABLED=true
CONDUCTOR_WEBHOOK_MAX_DELIVERIES_PER_MINUTE=60   # Rate-Limit pro Endpoint (rolling minute)
# Conductor ephemeral/JIT workflows (#330 Workstream A) — Guardrails für createEphemeralRun
CONDUCTOR_EPHEMERAL_DEFAULT_TTL_MS=86400000      # 24h Default-TTL
CONDUCTOR_EPHEMERAL_MAX_TTL_MS=604800000         # 7d Obergrenze (Requests werden geclampt)
CONDUCTOR_EPHEMERAL_MAX_ACTIVE_PER_AGENT=3       # concurrent ephemeral Runs pro Agent
CONDUCTOR_EPHEMERAL_MAX_CREATES_PER_HOUR=10      # Create-Rate pro Agent
CONDUCTOR_EPHEMERAL_REAPER_INTERVAL_MS=60000     # Reaper-Poll
# Tenant-Scope (auch für Diagramm-Cache-Keys genutzt)
GRAPH_TENANT_ID=byte5
# Prompt-PII C1-Detector (GLiNER-Sidecar, #361) — optional
PRIVACY_C1_DETECTOR_URL=http://pii-detector:8812   # unset ⇒ nur C0-Regex-Baseline
# Offene Channel-WebSockets (Tabelle „Admin-UI-Sitzung“ oben)
WS_SESSION_FRAME_RECHECK_MS=5000    # 0..60000; 0 = jeder Frame wird geprüft
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

`@omadia/embedding-adapter-local` (keyloser Embedder) liest ebenfalls ohne zod:

```
OMADIA_EMBEDDING_MODEL_DIR=/data/embedding-models   # Modellgewichte (~129 MB)
```

**Auflösungsreihenfolge (OM-97), explizitester zuerst:** das `model_dir`-Setup-
Feld des Plugins → `OMADIA_EMBEDDING_MODEL_DIR` → `PLATFORM_DATA_DIR/embedding-models`
→ legacy `var/embedding-models`.

**Warum es diese Variable gibt.** Der alte Default `var/embedding-models` ist
*relativ* und löst gegen das Arbeitsverzeichnis der Middleware auf — in der
Desktop-App ist das `<app bundle>/Resources/omadia/middleware`, also **innerhalb
der signierten Anwendung**. Der Download von ~129 MB dorthin gelingt und
invalidiert dabei die Code-Signatur; Gatekeeper verweigert dann den nächsten
Start, und die einzige Rettung ist eine Neuinstallation. Gewichte sind mutabler
Per-User-State und gehören zum Rest davon (Vault, eingebettete DB,
Plugin-Uploads), nie in die read-only Anwendung. Die Desktop-Shell setzt die
Variable auf Electrons `userData`; Docker/Fly kommen über `PLATFORM_DATA_DIR`
auf das gemountete Datenvolume. Nur der Legacy-Zweig kann im Bundle landen, und
er ist in jedem paketierten Deployment unerreichbar, weil dort mindestens eine
der beiden anderen Variablen gesetzt ist.

Ein älterer Build, der schon ins Bundle geladen hat, wird beim nächsten
`activate()` einmalig übernommen (`adoptLegacyModelDir`, async — die
Fallback-Kopie darf den 10-s-Deckel des Activate nicht blockieren). `npm run
fetch-model` benutzt dieselbe Auflösung, statt sie nachzubauen.

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
er sieht rohe Kundendaten: Prompt-Text bei `mask_user_prompt=on` und,
unabhängig davon, Tool-Fehlertexte und jede Evidence-Judge-Anfrage des
Verifiers; niemals öffentlich exponieren) und setzt die URL.

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
  | { type: 'verifier'; summary: VerifierResultSummary } // nur mit aktivem Verifier, nach `done`
  | { type: 'error'; message: string }
```

Genau ein `done` oder `error` schließt den Turn; mit aktivem Verifier folgt auf
`done` noch genau ein `verifier`-Event (siehe unten). Header:
`Content-Type: application/x-ndjson; charset=utf-8`, `X-Accel-Buffering: no`
(nginx-buffer-off).

**Antwort-Verifier.** Ist `verifier@1` aktiv, folgt auf `done` noch genau ein
`{ type: 'verifier'; summary }` (Status/Badge der Prüfung, Werte siehe
unten). Läuft zusätzlich der Privacy Shield, hält der Wrapper
`done` zurück, bis der innere Stream gedrained und der Verifier fertig ist:
`done` trägt dann — sofern der Turn einen hat — den vollständigen Receipt
(`privacyReceipt` inkl. `verifierEgress`, `receiptId`), direkt danach kommt
`verifier`. Text-Deltas
laufen in `shadow` unverändert live, nur der Abschluss wartet (Heartbeats
laufen weiter); `enforce` hält ohnehin alles Inhaltliche bis zum Urteil
(Verifier-Gate, unten). Details: `docs/security-architecture.md` §6e.

**Verifier-Event (`verifier`).** `summary` ist ein `VerifierResultSummary`
(`@omadia/channel-sdk`). Die Werte sind an Evidenz gebunden:

- `status`: `approved` | `approved_with_disclaimer` | `blocked` — es wurden
  Claims geprüft; `skipped` — der Verifier lief, fand aber nichts Prüfbares;
  `unavailable` — der Verifier konnte nicht laufen (Extractor- oder
  Pipeline-Fehler). `approved` heißt: die Extraktion meldet keine Lücke (das
  Modell hat die ganze Antwort gesehen, seine Liste blieb unter dem
  Anfrage-Limit, alle `record_claims`-Calls wurden gelesen und jeder
  zurückgegebene Claim steht vollständig in der Antwort und ist kurz genug
  für einen Check), und jeder extrahierte Claim ist geprüft und `verified`,
  mindestens einer. Einen Claim, den das Modell unter
  dem Limit gar nicht auflistet, sieht keine Prüfung — `approved` heißt also
  „nichts bekannt Ungeprüftes“, nicht „die Antwort enthält sonst nichts“. Ein
  Claim, den kein Checker nimmt (Betrag, Datum, ID oder Summe mit
  Quelle weder Odoo noch Graph) oder der über dem Claim-Limit pro Antwort
  liegt (`VERIFIER_MAX_CLAIMS`, greift in der Pipeline), bleibt als
  `unverified` mit `cause: 'not_checked'` im Verdict — eine nur teilweise
  prüfbare Antwort ist damit `approved_with_disclaimer`, nie `approved`.
  Ebenso, was die Extraktion nicht erfasst hat: Der `ClaimExtractor` liest
  die ersten 6000 Zeichen der Antwort (`EXTRACTION_WINDOW_CHARS`) und bittet
  das Modell um höchstens `VERIFIER_MAX_CLAIMS + 1` Claims; Text jenseits des
  Fensters, eine bis zu diesem Limit gefüllte Liste (das Modell hat dann
  womöglich Claims ausgelassen) und Claims, die nicht in der Antwort stehen
  (`claims_not_in_answer`), meldet er in `ClaimExtraction.gaps`, und die
  Pipeline hält jede Lücke als `not_checked`-Eintrag (Claim-Typ
  `coverage_gap`) im Verdict. Der Verbatim-Guard vergleicht ohne Rücksicht
  auf Groß-/Kleinschreibung und lässt jede Whitespace-Folge auf jede andere
  passen (ein Zeilenumbruch, den das Modell als Leerzeichen schreibt, zählt
  als Zitat; der Claim trägt dann den Wortlaut der Antwort). Was dann noch
  nicht passt — eine Umschreibung oder ein aus einem anderen Satzteil
  hineingezogenes Subjekt — geht an keinen Checker, verschwindet aber nicht
  mehr spurlos, sondern ist die Lücke `claims_not_in_answer`. Der Guard
  vergleicht den ganzen Claim, nie ein gekürztes Präfix (früher wurde jeder
  Claim vor dem Abgleich auf 300 Zeichen gekürzt und nur sein Anfang
  geprüft). Ein Claim, der die Antwort zitiert, aber länger ist als
  `MAX_CLAIM_CHARS` (300 Zeichen; das Tool-Schema verlangt 1-200), wird
  nicht passend gekürzt, sondern ist die Lücke `claims_too_long`. Der
  Extractor liest jeden `record_claims`-Call einer Modellantwort, nicht nur
  den ersten.
  Fand die Extraktion im erfassten Teil nichts Prüfbares, ist das Verdict
  `skipped` mit `incomplete_coverage`. Der
  `ClaimExtractor` wirft, wenn der LLM-Call scheitert, die Antwort am
  Token-Limit abgeschnitten ist (`finishReason: 'max_tokens'`), sie keinen
  verwertbaren `record_claims`-Call trägt (keinen, oder einen ohne
  `claims`-Array) oder ein Eintrag das Schema verletzt, statt eine leere oder
  halbe Claim-Liste zu liefern: das landet in
  `unavailable` (`extractor_error`), nie in `skipped` (`no_claims`) oder
  `approved`.
- `badge`: braucht einen Check, der einen Claim entschieden hat
  (`hasVerificationEvidence`): `verified` nur, wenn jeder Claim bestätigt ist;
  `partial` bei mindestens einem bestätigten und einem offenen Claim;
  `corrected` nach einem Retry, dessen eigene Prüfung jeden Claim bestätigt
  hat — bestätigt sie nur einen Teil, ist das Badge `partial` wie beim ersten
  Durchlauf; `failed` bei einem Widerspruch. Ohne bestätigten Claim ist das
  Badge `unverified` — auch bei `status` `approved_with_disclaimer`, wenn die
  Quellen schwiegen — bzw. `unavailable`, wenn jede gelaufene Prüfung
  scheiterte (Re-Query oder Judge-Call fehlgeschlagen,
  `cause: 'check_failed'`) oder der Verifier nicht lief.
- `reason`: nur bei `skipped` (`no_trigger` | `no_claims` |
  `no_checkable_claims` | `incomplete_coverage`) und `unavailable`
  (`extractor_error` | `pipeline_error`). Geschlossener Code-Satz, nie eine
  Fehlermeldung — die bleibt in der Logzeile, wo der Fehler gefangen wird.
- `uncheckedCount`: Claims, auf denen keine Prüfung lief (`not_checked`); in
  `unverifiedCount` mitgezählt. Davon `uncoveredCount`: Einträge für nicht
  erfasste Teile der Antwort (`coverage_gap`) — die Antwort wurde nicht ganz
  geprüft. Bestätigte Claims sind `claimCount - contradictionCount -
  unverifiedCount`.

Die Pipeline ist injiziert (`verifier@1`). `VerifierService.safeVerify` bindet
ihr Verdict deshalb an seine Claims (`bindVerdictToClaims`, `@omadia/verifier`),
bevor Retry, Resample, Persistenz oder Stream darauf aufsetzen; `summarise`
bindet beim Bau des Stream-Summaries noch einmal. Ein Status wird nie höher
gemeldet, als die Claims tragen (`approved` mit unbestätigtem Claim →
`approved_with_disclaimer`, mit widersprochenem → `blocked`), und nie
angehoben. `approved` / `approved_with_disclaimer` / `blocked` ohne Claim, ein
unbekannter Status, Einträge, die keine Claim-Verdicts sind, und ein `reason`
außerhalb der geschlossenen Codes werden `unavailable` / `pipeline_error`; der
Rohwert steht nur in der Server-Logzeile (`[verifier/service] pipeline verdict
not taken as returned: …`). Die eingebaute Pipeline ist davon nicht betroffen.
`verifier_verdicts.unverified_count` zählt die Claims selbst, nicht den Status.

Das Event geht unverändert über `/api/chat/stream` und den Public-API-Key-Stream
(`chatRouter.ts`) raus. Ein Connector-Badge entsteht daraus nur über
`toSemanticAnswer` und nur, wenn die Zähler das Badge tragen
(`verifierSummaryHasEvidence`, `verified` und `corrected` nur bei lauter
bestätigten Claims) und zueinander passen: nichtnegative ganze Zahlen,
`uncoveredCount ≤ uncheckedCount ≤ unverifiedCount`,
`contradictionCount + unverifiedCount ≤ claimCount`; fehlende optionale
Zähler gelten als 0, fehlende Pflichtzähler nie. Der Web-Chip wendet dieselbe
Regel an (ein Summary mit widersprüchlichen Zählern bekommt einen neutralen
Chip); der Wire-Typ `SemanticAnswer.verifier` bleibt
`verified | partial | corrected | failed`, Turns ohne Evidenz ergeben dort
kein Badge. Der Web-Chat zeigt das Event als Footer-Chip (`VerifierBadge`,
Keys `chat.verifier.*`), grün nur für ein `verified` mit lauter bestätigten
Claims, `corrected` nur unter derselben Bedingung; der Tooltip nennt nicht
geprüfte Claims bzw. sagt, dass nicht die ganze Antwort geprüft wurde. Der
Borderline-Resample (#132) läuft nur, wenn ein Verdict Claims bestätigt und
ein geprüfter Claim offen bleibt — nicht bei `skipped` / `unavailable`, nicht
ohne bestätigten Claim und nicht, wenn nur `not_checked` (auch eine
Abdeckungslücke) offen ist. Der Omadia-UI-Channel verwirft das Event weiterhin
(`omadia-ui-channel/src/protocol.ts`). Zustands-Tabelle und Regeln:
`docs/security-architecture.md` §7c.

**Degradierter Turn (#1094).** Wirft ein Turn, *nachdem* mindestens ein
Tool-Call bereits committet hat, bleibt das terminale Event bewusst `done` —
ein `error` würde den committeten Seiteneffekt als gescheitert melden und den
nächsten Turn zum erneuten Aufruf verleiten (#506). Dieses `done` ist aber als
degradiert markiert und darf von keinem Consumer als Antwort gerendert werden:

- `degraded: true`, `committedTools: string[]` (deduplizierte Tool-**Namen** in
  Commit-Reihenfolge, **keine** Call-Anzahl) und `correlationId` — derselbe
  Token wie im `error`-Zweig (#641) und in der Logzeile
  `[orchestrator] turn failed (correlationId=…)`.
- `runTrace.status` ist `'error'`. `RunStatus` bleibt binär (`'success' |
  'error'`, doppelt deklariert in `@omadia/channel-sdk` und `@omadia/plugin-api`,
  persistiert am KG-Run-Node) — die Degradations-Nuance liegt am Event, nicht in
  einem dritten Status-Wert.
- **Persistiert** wird der sprachfreie Marker
  `<turn-incomplete tools="…" ref="…"></turn-incomplete>` (Konvention wie
  `<mcp-auth-required>`): Session-Log, KG-Turn-Node und damit der Kontext des
  Folge-Turns bleiben sprachneutral und tragen keinen fingierten Erfolg. Der
  System-Prompt erklärt den Marker (Block unter den Integritäts-Regeln), damit
  das Modell die genannten Tools als **ausgeführt** liest und sie nicht erneut
  aufruft (#506).
- **Ausgeliefert** wird stattdessen eine lokalisierte Notiz: `discloseDoneEvent`
  expandiert den Marker am Delivery-Boundary über
  `composeTurnIncompleteText(locale, tools, ref)` (`@omadia/channel-sdk`) —
  dieselbe Locale-Mechanik wie die KI-Kennzeichnung, Default `de`. Text-only-
  Channels (Teams, Telegram, Mail) rendern damit lesbaren Text statt eines
  Tags. Auch der Web-Chat zeigt diesen Text (also in der Operator-Locale, nicht
  der UI-Locale) und setzt aus den Event-Feldern nur eine UI-lokalisierte
  Warn-Überschrift darüber (`TurnIncompleteNotice`, `chat.turnIncomplete.*`).
  `web-ui/app/_lib/turnIncomplete.ts` parst den rohen Marker nur als Fallback;
  der serverseitige Chat-Mirror speichert die expandierte Notiz und verliert
  `degradedTurn` (zod-`MessageSchema`), ein Mirror-Restore zeigt also nur den
  Text ohne Warn-Überschrift.
- **Ausnahme Privacy Shield v4:** Hat `v4_render_answer` die Antwort schon
  serverseitig gerendert (`answerSource: 'privacy-render'`), bleibt diese
  Antwort stehen — die Notiz ersetzt sie nicht. `degraded`, `committedTools`
  und `correlationId` bleiben am Event.
- Ein degradierter Turn zählt **nicht** als „letzter Turn ok" im Operator-Health
  (`routes/chat.ts`), **nicht** als `ok` im Public-API-Key-Audit
  (`chatRouter.ts`), und der Verifier überspringt ihn im Stream ganz (kein
  `verifier`-Event, `VerifierService.chatStream`). Der nicht-streamende Pfad
  (`VerifierService.chat` → `runTurn`) sieht nie einen degradierten Turn: dort
  wirft der Turn weiter, bevor der Verifier läuft.

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

**Contract-Erweiterung — `answerSource` (#1105).** Wenn Privacy Shield v4 die
Antwort serverseitig rendert (`v4_render_answer`), tauscht der Orchestrator den
gerenderten Text kurz vor dem `done`-Event in `answer` — die zuvor als
`text_delta` gestreamten Modell-Tokens sind dann veraltet. Damit die beiden
dokumentierten Lesarten (Deltas konkatenieren vs. `done.answer`) nicht
widersprüchlich bleiben, trägt `done` (und für den gepufferten Pfad
`ChatTurnResult`/`SemanticAnswer`) ein optionales
`answerSource: 'model' | 'privacy-render'`. Gestempelt `'privacy-render'` an
**beiden** Swap-Stellen — Streaming (`chatStream`) und gepuffert
(`chatInContext`) — wenn `takeRenderedAnswerV4` einen Wert lieferte, sonst
weggelassen (bedeutet `'model'`). **`done.answer` ist autoritativ**; ein Client,
der die Antwort aus Deltas rekonstruiert, muss sie durch `done.answer` ersetzen,
sobald `answerSource` gesetzt und nicht `'model'` ist. Additiv/optional wie oben.
Dritter Wert seit dem Verifier-Gate: `'verifier-blocked'` (siehe unten).

**Kontrakt-Erweiterung — `answerIsError` (#1097).** Ein Server-Render kann auch
ein *Fehler* sein (das Modell hat den Shield gebeten, etwas zu rendern, das in
Wahrheit ein Tool-Fehler oder ein Auth-Prompt ist). Dann trägt `done` (bzw.
`ChatTurnResult`/`SemanticAnswer`) zusätzlich `answerIsError: true`, gesetzt aus
`PrivacyRenderedAnswer.isError`. Kanäle dürfen den Turn damit als Fehler
darstellen, statt den englischen Fehlertext als Ergebnis zu zeigen. Nur
zusammen mit `answerSource: 'privacy-render'` oder (immer) mit
`'verifier-blocked'`, nie `false`, additiv/optional.
Zweiter, unabhängiger Fix im selben Issue: ein Guarded-Tool, das einen prosaischen
`Error:`-String **zurückgibt** (die `Error:`-Konvention, aus der auch `is_error`
abgeleitet wird), wird an den Dispatch-Nähten nicht mehr als 1-Zeilen-Dataset
interniert, sondern als Text an das Modell gegeben — sonst sah das Modell den
Fehler nie und ein späteres Render materialisierte ihn als Daten. Nicht
interniert heißt seit dem Tool-Error-Fix nicht ungeprüft (siehe den Absatz
„Tool-Fehler an den Dispatch-Nähten“ unten).
#1105 schloss die beiden Nähte seiner Repros (`Orchestrator.dispatchTool`,
`ToolDispatchService.afterDispatch`), **#1097** die restlichen zwei:
`LocalSubAgent.dispatch` (Fehler eines Tools *innerhalb* eines Sub-Agents) und
`Orchestrator.guardReplayResult` (fehlgeschlagener MCP-Input-Replay — der
`McpManager` wirft nie, er liefert einen `Error: …`-String). Alle vier Guards
sitzen an derselben Stelle: nach Intern-Exemption-Allowlist und Operator-Bypass,
vor dem Internieren — und konsultieren **ein** Prädikat,
`isGuardedControlFlowResult` (`toolErrorRedaction.ts`).

Das Prädikat deckt zwei Träger ab, denn der `Error:`-Präfix allein war zu eng:
den **MCP-Auth-Prompt** (`🔒 The MCP server "…`, ggf. mit dem
`<mcp-auth-required>`-Block, aus dem die Chat-UI die Connect-Karte baut) liefert
`McpManager.handleFailure` statt eines rohen Fehlers, sobald ein Call
auth-förmig scheitert (Alltagsfall: abgelaufenes OAuth-Token auf einer
geparkten MCP-Input-Karte). Interniert ging die Connect-Karte verloren und das
Modell erzählte Erfolg über einem Digest. Erkannt wird der Prompt **per
Provenienz, nicht am Präfix**: jede Naht öffnet um genau einen Dispatch eine
`McpAuthPromptMint` (`mcp/mcpAuthPromptMint.ts`, eigener AsyncLocalStorage, weil
der Dispatcher ohne Turn läuft und Skill-Bindung wie `ctx.mcp` den Turn-Store
neu bauen), `handleFailure` trägt den zurückgegebenen Prompt dort ein, und nur
ein byte-gleiches Ergebnis zählt. Text, der bloß so anfängt (ein
Remote-Textblock, eine Datenzelle am Anfang eines Ergebnisses), ist Tool-Datum
und wird interniert. Das Prädikat prüft nie Teilstrings: ein Marker in einer
Datenzelle darf kein mehrzeiliges Ergebnis entmaskieren.
`isControlFlowToolResult` (`@omadia/plugin-api`) klassifiziert weiter nur am
Präfix; an den Nähten entscheidet es nichts mehr.

Ein **gerenderter Fehler** wird als solcher markiert —
`PrivacyRenderedAnswer.isError` (entschieden an der Quell-Zelle: ein Dataset
aus genau einer Control-Flow-Zelle), vom Orchestrator als
`answerIsError: true` auf beide Antwortpfade gelegt (siehe §11-Kontrakt). Der
**Shape-Classifier bleibt unverändert**: eine Ausnahme für 1×1-`Error:`-Skalare
wäre ein Klartext-Kanal, weil Verben abgeleitete Datasets neu klassifizieren
(`filter` + `select` verengen jede maskierte Spalte auf so einen Skalar).

**Tool-Fehler an den Dispatch-Nähten.** Weder eine geworfene Exception noch ein
zurückgegebener `Error:`-Text ist sanierter Text (ein ORM echot die Zeile, ein
Treiber die gebundenen Parameter, ein Remote-MCP-Server seinen Fehler-Body).
Deshalb laufen beide Träger an jeder Naht durch **einen** Helper,
`toolErrorRedaction.ts` (`@omadia/orchestrator`), und die Politik folgt der
Herkunft:
- **Geworfen** (`withholdThrownToolError`): das Modell bekommt nur die
  Withheld-Notice ``Error: tool `<name>` failed with <Klasse> (code <code>)
  [ref <ref>] …`` — Klassenname und bereinigter Code (`describeThrownError`,
  `@omadia/plugin-api`), nie die Message. `Orchestrator.dispatchTool` rejected
  dafür nie mehr (auch nicht bei `OMADIA_TOOL_DISPATCH_TIMEOUT_MS=0`); die
  Rejection-Zweige beider Loops sind nur noch Backstops mit derselben Notice.
  `ToolDispatchService.thrownResult` ersetzt das frühere `maskErrorText`
  (das die Message als Dataset internierte) durch dieselbe Notice
  (`origin: 'dispatcher'`), und `LocalSubAgent.dispatch` macht aus einem
  werfenden inneren Tool ein `is_error`-Tool-Result, statt den Sub-Agent
  abbrechen zu lassen. Der Aufruf kann vor der Exception schon gewirkt haben
  (Write committet, Antwort läuft in den Timeout): die Notice sagt dem
  Modell, dass der Ausgang unbekannt ist, und der Sub-Agent verweigert für den
  Rest des Laufs eine identische Wiederholung (gleiches Tool, gleicher
  kanonischer Input; `subAgentUnknownOutcome.ts`) — auch ohne
  Privacy-Provider und auch dann, wenn eine Tool-Bridge die Exception selbst
  gefangen und die Notice zurückgegeben hat (`isWithheldToolErrorNotice`,
  Erkennung an der Form; wer sie imitiert, blockiert nur die eigene
  Wiederholung). Anderer Input und ein Retry nach einem gewöhnlichen
  zurückgegebenen `Error:`-Hinweis laufen weiter.
- **Zurückgegeben** (`guardControlFlowResult`): der Text hinter `Error:` geht
  durch `redactToolErrorText` des Providers (C0-Identitätstypen ohne
  `date`/`amount`, Deny-List #760, C1; irreversibel `[masked:<typ>]`, die
  Surrogat-Map des Turns wird nicht erweitert). Zurückgehalten statt redigiert
  wird er, wenn er nach Exception aussieht (Zeilen-Echo als JSON, Python-Dict
  oder JS-Objekt/`Map`, wie `util.inspect`, `console.log` und `%o` es
  drucken; Datensatz mit Keyword-Feldern wie Dataclass, Kotlin/Lombok,
  Java-Record oder Java-`Map`, oder mit Gos `Key:value`-Feldern; Stacktrace;
  Postgres-`DETAIL:`-Zeile, `Failing row contains (…)` oder `Key (…)=(…)`,
  wie psycopg und Odoos JSON-RPC-Fehler sie tragen), länger als 4096 Zeichen
  ist oder der Provider ihn nicht prüfen kann.
- **MCP-Connect-Prompt**: byte-identisch durchgereicht (Connect-Karte muss
  überleben) und quittiert — aber nur der Text, den `McpManager` im selben
  Dispatch erzeugt hat; alles andere mit diesem Präfix wird interniert. Der
  Tool-Call eines Sub-Agents ist Teil des Eltern-Dispatches: sein Prompt wird
  in beiden Mints eingetragen, die Eltern-Naht reicht eine Sub-Agent-Antwort
  durch, die ihn byte-gleich wiederholt, und behandelt jede andere wie eine
  normale Sub-Agent-Antwort.
Die Kernel-eigenen Absagen aus `dispatchToolInner` (Tool nicht verfügbar /
nicht gegrantet / unbekannt) sind per Provenienz ausgenommen, nicht per Form.
Jeder behandelte Fehler schreibt einen PII-freien Eintrag in
`PrivacyReceipt.toolErrors` (`carrier`, `outcome`, Bytes, maskierte
Span-Typen); die volle Fehlermeldung samt Stack steht einmal im Server-Log
unter `ref=<ref>` — der Turn-Korrelations-Id (#641, dieselbe wie in
`<turn-incomplete ref="…">`), der Request-Id des Dispatcher-Callers oder einem
frischen `err_…`-Token. Das Log ist die einzige Stelle, an der ein Operator den
Treibertext noch findet. Die In-Tree-Wrapper, die `Error: ${err.message}`
lieferten (die drei Tool-Bridges über `bridgedToolError`, Web-Search,
Diagramme, Discussion, Transkription, `manage_routine`, `query_dataset`, die
Long-Running-Task-Handler, `createDomainTool`), geben nur noch selbst
formulierte Meldungen im Klartext zurück und sonst `toolErrorFromException`.
Ein typisierter Fehler zählt nur dann als selbst formuliert, wenn nichts
Fremdes in seiner Message steckt: Web-Search-Provider und Kroki-Client legen
die gefangene Transport-Exception auf `cause` und den Upstream-Body auf
`body`, und `web_search` / `render_diagram` bauen ihr Ergebnis nur aus
Provider-Id bzw. Diagramm-Art und HTTP-Status, nie aus der Message; der Rest
steht unter der Ref im Log.
Auf dem **öffentlichen MCP-Endpunkt** läuft jeder Tool-Handler mit dem
Privacy-Handle des Dispatches als ambientem `turnContext.privacyHandle`
(`runHandlerInPrivacyScope`): der Sub-Agent eines Domain-Tools bekommt
die verschachtelte Gate-Variante (`PrivacyTurnHandle.forNestedCalls`),
interniert damit seine inneren Ergebnisse und sieht innere Fehler nur als
Withheld-Notice. Diese Maskierung zählt nicht für `masked()` des
Call-Ergebnisses, ein Fehlschlag darin verwirft den Call. Ohne Handle läuft
dort kein Handler (`requirePrivacyHandle`; ein Dispatcher ohne `withPrivacy`
wird vor dem Dispatch abgewiesen). Vorher fand der Sub-Agent dort keinen
Handle, und sein Provider bekam innere Daten und Fehlertexte im Klartext.
Ohne Privacy-Provider (und für intern-exempte Self-Tools) fließt der Text wie
jedes andere Tool-Ergebnis roh — Parität; auf dem Abo-CLI-Pfad gibt es keinen
Shield (#1087). Versions-Paarung: der gebündelte
`@omadia/plugin-privacy-guard` implementiert `redactToolErrorText` ab 0.6.0.
Ein Provider ohne die Methode lässt den Kernel zurückgegebene `Error:`-Texte
vollständig zurückhalten, und das Log meldet einmal pro Prozess
`does not implement redactToolErrorText`. Details, Residuen und Reviewer-Regel:
`docs/security-architecture.md` §6c und §11.

**Kontrakt-Erweiterung — Verifier-Gate im Stream (`VERIFIER_MODE=enforce`).**
`shadow` bleibt der unveränderte Pass-through: alle Events wie erzeugt, danach
ein `verifier`-Event. In `enforce` ist `VerifierService.chatStream` ein
Auslieferungs-Gate (`verifierDelivery.ts`, Regeln und Grenzen in
`docs/security-architecture.md` §7c):

- **Bis zum Urteil** gehen nur Lebenszeichen raus: `iteration_start`,
  `turn_routing`, `turn_persona`, `tool_progress`, `heartbeat`,
  `stream_token_chunk`, `iteration_usage`, `steer_applied` (geschlossene
  Allowlist `passesBeforeVerdict`). Alles andere — `text_delta`,
  `tool_use`/`tool_result`, `sub_*` (auch `sub_iteration`, damit es beim
  Freigeben unter seinem Tool-Call steht), `nudge`, `turn_annotation`,
  `surface_*`, `done`, jeder künftige Typ — wird gehalten. Der Observer der
  Route wird jetzt in jedem Modus durchgereicht (vorher verworfen), Token- und
  Usage-Zähler laufen also live weiter.
- **Freigabe** nur bei `approved` oder `skipped` mit `no_trigger` /
  `no_claims`: die gehaltenen Events in Originalreihenfolge, aber ohne die
  gestreamten `text_delta`s — der Text geht als **ein** `text_delta` mit
  `done.answer` (ohne gefalteten KI-Kennzeichnungsblock) direkt vor `done`
  raus, `done` mit `verifier` (dasselbe Summary wie das folgende
  `verifier`-Event): `…, text_delta(done.answer), done{verifier}, verifier`.
  Grund: der Orchestrator streamt jede Modellantwort live und verwirft sie
  ggf. danach (#332-L3-Eskalation, File-Retry: `textParts.length = 0`) — die
  verworfene Antwort steht in den Deltas, nicht in `done.answer`, und das
  Urteil gilt nur `done.answer`.
- **Zurückgehalten** (fail-closed) bei jedem anderen Urteil — `blocked`,
  `approved_with_disclaimer`, `skipped` mit `no_checkable_claims` /
  `incomplete_coverage`, `unavailable`: genau ein `text_delta` mit der
  lokalisierten Notiz (`composeVerifierBlockedText`, Locale: Turn-Disclosure →
  `ai_disclosure_locale` → `de`), dann `done` mit dieser Notiz als `answer`,
  `answerSource: 'verifier-blocked'`, `answerIsError: true`, `verifier` und nur
  Identitäts-/Telemetriefeldern (Allowlist; Anhänge, Dateien, Follow-ups,
  `maskedValues`, `delegatedAnswer`, Karten, Excerpts fallen weg), dann das
  `verifier`-Event: `text_delta(Notiz), done{verifier-blocked}, verifier`.
  Hatte der Turn die KI-Kennzeichnung in `done.answer` gefaltet (erster Turn
  des Scopes), trägt die Notiz in `done.answer` denselben Block — nie im
  Delta.
- **Ohne Urteil freigegeben:** `pendingUserChoice`, `pendingMcpInput`,
  `pendingSlotCard`, `pendingOAuthConsent`, `degraded` mit der
  Turn-Incomplete-Notiz, die Datenschutz-Absage (`PROMPT_MASK_BLOCKED_ANSWER`)
  und die Screening-Quarantäne (`SECURITY_QUARANTINE_NOTICE`) — beide ohne
  Modelllauf, erkannt auch mit gefaltetem KI-Kennzeichnungsblock — gehaltene
  Events wie bei der Freigabe (Text als ein Delta aus `done.answer`), kein
  `verifier`-Event. Sicher faktenfrei sind nur die Server-Notizen und
  `NO_REPLY`: eine Karte hängt an der Antwort ihres Turns.
  Auswahlkarte und MCP-Eingabeformular beenden den Turn am Tool-Call (Antwort
  = Text davor); `pendingSlotCard`, `pendingOAuthConsent` (turnweit, sobald
  ein Kalender-Tool `consent_required` meldete) und eine vom Card-Router
  (`maybeRouteCardsFromText`, Provider ohne Interleaving, Antwort ab 40
  Zeichen) angehängte Auswahlkarte reiten dagegen auf dem `done` einer
  vollständigen Antwort — die geht dann samt Tool-Output und Surfaces
  ungeprüft raus (offener Punkt in §13). Ein nacktes `NO_REPLY` (Sentinel als
  ganze Antwort) gibt nur sein `done` frei, nichts Gehaltenes. Geprüft wie
  jede Antwort wird eine Antwort, die nur mit `NO_REPLY` **endet**
  (`isNoReply` akzeptiert die Form, Stream-Clients verwerfen sie aber nicht).
  Endet der Turn mit `error`, geht nur der `error` raus, nichts Gehaltenes.
- **Nie an den Verifier: was er hinter dem Privacy Shield nicht sehen darf.**
  Eine Antwort mit `answerSource: 'privacy-render'` (auch ein `degraded`-Turn,
  dessen Antwort der Shield schon gerendert hatte) und — hinter einem Shield —
  ein Lauf ohne Privacy-Sicht (Direct-Line-Relay, keine übergebene
  Continuation) gehen nie an `pipeline.verify` (`verifierGate`,
  `verifierPrivacyGate.ts`): die gerenderte Antwort hält echte Werte, die der
  Shield dem Modell vorenthalten hat. In `enforce` wird daraus das Verdict
  `unavailable` / `privacy_shield` → zurückgehalten, auf Stream und `chat()`,
  dort auch für Resample und Retry; `shadow` speichert kein Verdict. Ein
  zurückgehaltener `degraded`-Turn behält `degraded`, `committedTools` und
  `correlationId`.
- **Ein Correction-Retry im Stream** (seit dem Replay-Ledger, §3) — außer bei
  Canvas-Turns. Bei `blocked` betritt der Wrapper den Turn erneut mit
  Correction-Hint über den Tool-Ergebnissen des ersten Laufs (kein Tool des
  ersten Laufs läuft erneut), hält den Retry genauso und liefert nach dessen
  Urteil; nur seine
  Lebenszeichen (ein zweites `iteration_start`) gehen vorher raus. Ein
  abgebrochener oder gescheiterter Retry bleibt intern, dann gilt die Notiz
  zum ersten Lauf. `done.turnId` nennt die Session-Log-Zeile des gelieferten
  Laufs (Commit-on-Delivery, §3); `onAfterTurn`-Annotationen kommen mit der
  freigegebenen Antwort direkt vor ihr. `VerifierService.chat` (`/api/chat`,
  Scheduler, Conductor)
  hat Retry und Borderline-Resample und liefert bei einem nicht freigegebenen
  Endurteil dieselbe Notiz als `SemanticAnswer` (`answerSource`/
  `answerIsError` gesetzt, Anhänge und Karten entfernt).
- Ein zurückgehaltener Turn zählt als `ok` (Operator-Health in `routes/chat.ts`,
  API-Key-Audit in `chatRouter.ts`) — eine Policy-Entscheidung, kein Fehler;
  außer er ist zugleich `degraded`, dann bleibt er ein Fehler.
- **Canvas-Skeleton:** deklariert der Basis-Agent
  `ChatAgent.holdsContentUntilVerdict` (der `VerifierService` in `enforce`),
  hält der Canvas-Composer sein Skeleton zurück (`verdictHold.ts`): es geht
  direkt vor dem ersten `surface_*` bzw. dem freigebenden `done` raus, vor
  dem Antworttext, und nie mit einem zurückgehaltenen oder fehlgeschlagenen
  Turn. In `shadow` und ohne Verifier bleibt Skeleton-first unverändert.
- Der Web-Chat faltet `done.verifier` und `verifierBlocked` in die Nachricht
  (`chatStreamEvents.ts`) und setzt `VerifierBlockedNotice`
  (`chat.verifierBlocked.*`) über die Notiz; der Server-Mirror
  (`MessageSchema`) behält beide Felder.
- **Nicht abgedeckt:** der Abo-CLI-Runtime (`claude-cli`; `buildOrchestrator`
  gibt den `CliChatAgent` vor dem Verifier-Wrapper zurück) und Routinen (der
  Routine-Runner ruft `runTurn` auf dem rohen Orchestrator). Persistenz
  (Session-Log, KG-Turn, Auto-Promotion) passiert vor `done` — mit
  Request-Ledger erst nach dem Urteil, für den Lauf, über den es ging —, also
  auch für eine zurückgehaltene Antwort.

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

### Sitzungs-Widerruf: offene Verbindungen, gerätegenaues Abmelden, Cache

Der serverseitige Widerruf (`users.session_version`, §3) prüft bei jedem
Request und bei jedem WebSocket-Upgrade. Offen:

- **Builder-SSE-Stream schließen.** Channel-WebSockets enden inzwischen mit
  ihrer Sitzung (4401 am `exp`, 4403 bei Widerruf, siehe PR-11-Abschnitt).
  Der Builder-SSE-Stream (`GET /drafts/:id/events`) authentifiziert weiter nur
  beim Öffnen und bleibt nach einem Widerruf offen. Vorlage ist
  `ChannelSessionTracker` (`src/channels/channelSessionLifetime.ts`):
  `onRevoked` für diese Replica, periodisch `check` für alle anderen, weil
  `announce` prozesslokal ist.
- **Canvas-Client nach verpasstem 4401.** `@omadia/canvas-core` hält nach
  4401/4403 an; erst das nächste `connect()` öffnet wieder, `switchCanvas()`
  nicht. Kommt der 4401 aber nie an (Gerät schläft über `exp` hinweg, Netz
  reißt genau dann ab), sieht der Client nur 1006 und verbindet im Backoff mit
  dem abgelaufenen Cookie neu. Das Upgrade scheitert mit 401, was im Browser
  wieder als 1006 ankommt: bis zu alle 30 s ein Versuch, bis der User sich neu
  anmeldet. Möglicher Fix: einen Close nach dem `sessionExpiresAt` des letzten
  Acks wie 4401 behandeln, mit Toleranz für Uhrabweichung.
- **Gerätegenaues Abmelden.** Abmelden gilt heute pro User (alle Geräte). Pro
  Gerät bräuchte eine Denylist auf `sid` samt Aufräumen nach `exp`.
- **Cache nur bei Bedarf.** Ein Point-Read pro authentifiziertem Request. Wenn
  der Lookup in Messungen sichtbar wird (Richtwert: > 5 ms im p95 der
  `/api`-Requests), ein kurzes TTL-Memo im Guard, das `announce` invalidiert;
  die TTL dann in Code und `docs/security-architecture.md` §10k nennen, weil
  „sofort“ danach „innerhalb der TTL“ heißt. Die TTL addiert sich auch auf
  `WS_SESSION_FRAME_RECHECK_MS`: ein WebSocket-Frame dürfte dann auf einem
  Urteil fahren, das TTL + 5 s alt ist. Deshalb die TTL klein halten (≤ 1 s)
  und auch in `docs/security-architecture.md` §10d nennen.
- **Upgrade-Prüfung ohne Deadline.** Der Re-Check offener Channel-Sockets
  gibt nach `WS_SESSION_CHECK_TIMEOUT_MS` (10 s) auf; die Prüfung beim
  Channel-Upgrade selbst (`authenticateBeforeHandshake` ohne `timeoutMs`)
  nicht. Hängt der `users`-Read, hängt auch der rohe Upgrade-Socket, bis die
  DB antwortet (danach 503 oder 101). Kein Autorisierungsloch, aber eine
  Ressourcenfrage: dieselbe Deadline an die Channel-Upgrade-Prüfung geben und
  `webSocketRegistryHardening.test.ts` um einen hängenden Channel-Lookup
  erweitern.
- **UI-Hinweise.** Der `SessionWatcher` zeigt bei `auth.revoked` dasselbe
  Ablauf-Overlay wie bei einer abgelaufenen Sitzung; ein eigener Text
  („An anderer Stelle abgemeldet“) wäre ehrlicher. Die Detailseite eines Users
  sollte sagen, dass ein Passwort-Reset alle seine Sitzungen beendet, auch die
  eigene.

### CI-Schulden aus dem Security-Review (2026-09-29)

- **`PG_TEST_FLOOR` nachziehen, sobald die Auth-Härtungen gemergt sind.** Serverseitiger
  Sitzungs-Widerruf und die atomare Ersteinrichtung bringen neue Postgres-Suiten mit
  (`test/auth/userStoreSessionVersion.pg.test.ts`, `userStoreFirstAdmin.pg.test.ts`,
  `setupRouteConcurrency.pg.test.ts`). Der Floor in `.github/workflows/ci.yml` bleibt bis
  dahin auf dem Wert von `main` (`372`) und wird dann einmal auf den gemessenen `ran=`-Wert
  des `test:pg`-Schritts gezogen (lokal mit diesem Stand: `ran=396`, `skipped=0`).
- **`middleware/src/services/graph/migrations/` löschen** — 4 Dateien, byte-identisch mit
  KG-neon 0002/0004/0012/0013; kein Runner liest sie (die Graph-Migrationen laufen über die
  `harness-knowledge-graph-neon`-Serie; #875 hat die dort gestrandete 0009 gerettet). Seit
  2026-09-29 schlägt der `schema`-Job fehl, sobald dort etwas anderes liegt als diese vier
  Kopien (Schritt „Inert legacy graph migrations stay inert“). Löschen = Verzeichnis +
  Eintrag in `scripts/copy-build-assets.mjs` + dieser CI-Schritt + der Pfad in
  `test/mcpDelegationBackfillMigration.pg.test.ts` (liest das Verzeichnis und nennt es noch
  „live migration series“); das Dockerfile kopiert es nicht.
- **Desktop-Refresh (Electron 44.5.1, electron-builder 26.17.0) — erledigt (#1259).** `desktop` ist
  das dritte Bein der Audit-Matrix, `npm audit` dort bei 0. Weil jeder Push auf `main` über
  `auto-release.yml` sofort ein signiertes Release samt Update-Feeds baut, lief der Refresh vor dem
  Merge als Dispatch-Build mit Wegwerf-Tag und durch `desktop-upgrade-smoke.yml` (#1270). Der Smoke
  ersetzt die früher manuellen Schritte (2) und (2b): frische GitHub-Runner (macOS arm64, Windows x64
  mit Basic-User-Token, Linux-AppImage mit gnome-keyring), keine produktive Installation.
  (0a)/(0b) Brücken-Release v0.167.9 mit Hold-back-Hinweis und Secrets-Fix. (1) Der erste
  Dispatch-Build (36899325147) war in allen Targets grün und trotzdem nicht startfähig: electron-builder
  26 lässt das oberste `node_modules` jeder `extraResources`-Quelle weg (`app-builder-lib`
  `util/filter.js`), der Kernel starb mit `ERR_MODULE_NOT_FOUND`. Gefunden hat das der erste
  Smoke-Lauf (36981332723). Fix: eigene `extraResources`-Einträge für beide `node_modules`, Ausschluss
  in den Eltern-Einträgen, `afterPack` prüft das Paket auf jeder Plattform, und
  `scripts/check-packaged-runtime.test.mjs` lässt den Block durch electron-builders eigenen Kopiercode
  laufen. Finaler Build 36984867502 (Tag `v0.0.0-desktop-refresh.5`), alle vier Targets grün.
  (2)/(2b) Smoke-Lauf 36989068863: frische Installation und Upgrade über v0.167.14 auf allen drei
  Plattformen grün, `secrets.enc` byte-identisch, jedes gespeicherte Secret feldweise gleich,
  Recovery-Key unverändert, Provider-Key verifiziert. (2c) dieser Eintrag, CHANGELOG, `docs/upgrading.md`
  und §4a nennen v0.167.14 als letztes Release auf Electron 37. (3) Required Checks
  `audit (high+critical block) (desktop)` und `desktop (typecheck + test)` nach dem Merge.
  **Nächster Electron-Major:** Dispatch-Build mit Wegwerf-Tag, dann `desktop-upgrade-smoke.yml` mit
  dessen Run-ID (`desktop/README.md` § Install and upgrade smoke); nie auf einer produktiven
  Installation.
- **Beenden während des ersten UI-Ladens meldet einen Boot-Fehler.** Beendet man die App, während
  das erste `loadURL` der Web-UI noch läuft, lehnt `loadURL` ab, und `bootExistingInstall` reicht das
  an `presentBootFailure` weiter: `[main] boot failed: ERR_FAILED (-2) loading …`, im ungünstigen
  Fall mit Fehlerdialog im Shutdown, dessen Standard-Knopf „Re-run setup“ ist. Gesehen im
  Install-Smoke 36989068863 (Windows-Upgrade, Versuch 1); unabhängig von der Electron-Version.
  `presentBootFailure` sollte bei gesetztem `quitting` nur loggen und zurückkehren. Der Smoke wartet
  seither auf das erste fertige Laden, bevor er beendet.
- **Synchrones `safeStorage` endet mit Electron 46.** Electron 45 markiert
  `safeStorage.isEncryptionAvailable`/`encryptString`/`decryptString` als deprecated, Electron 46
  entfernt sie zusammen mit Chromiums synchronem OSCrypt-Backend (Electron
  `docs/breaking-changes.md`). `desktop/src/secrets.ts` nutzt genau diese drei. Vor dem Sprung
  auf 46 auf `isAsyncEncryptionAvailable`/`encryptStringAsync`/`decryptStringAsync` umstellen
  (laut Electron dieselben Key-Stores, alte `secrets.enc` bleibt lesbar) und den Upgrade-Lauf
  (2b) oben wiederholen. Dependabot ignoriert Electron-Majors nicht, der Bump-PR kommt also.
- **Datenverzeichnis-Dialog ohne `defaultPath`** (`desktop/src/ipc.ts`): seit Electron 43 öffnet
  `showOpenDialog` ohne `defaultPath` im Downloads-Ordner — für ein Postgres-Datenverzeichnis ein
  schlechter Startpunkt. `defaultPath` auf das Home- oder das aktuelle Datenverzeichnis setzen.
- **`test/graphBackfill.test.ts` ist zeitabhängig.** Zwei direkt nacheinander geloggte Turns
  bekommen dieselbe Turn-ID, wenn sie in dieselbe Millisekunde fallen (`SessionLogger`,
  millisekundengenaue Zeit); dann trägt der zweite rekonstruierte Turn die Entity des ersten. Im
  warmen Prozess passiert das auf Node 22 und 24 fast immer. Grün ist der Test nur, weil der
  kalte erste Aufruf meist über die Millisekunde hinaus dauert — unter Electron 44s Node 24 in
  rund 15–25 % der Läufe nicht. Test mit festen `time`-Werten schreiben oder die Turn-ID
  kollisionsfrei machen.
- **Zwei Node-Majors für denselben Kernel; auf Electrons Node läuft seine Test-Suite in keinem
  CI-Job.** Entscheidung mit dem Desktop-Refresh: Die Desktop-App startet Kernel und Web-UI mit
  Electrons eingebettetem Node (`ELECTRON_RUN_AS_NODE`, `desktop/src/supervisor.ts`), seit
  Electron 44 also Node 24.21.0 — keine Electron-Linie, die noch Sicherheitsfixes bekommt, hat
  Node 22. Server-Images, Entwicklung, CI und der Desktop-Release-Build, der den Kernel
  installiert und baut, bleiben auf Node 22 (`docs/security-architecture.md` §4a). `engines` in
  `middleware/package.json` bleibt deshalb `>=22.13.0 <23`: Mit `engine-strict`
  (`middleware/.npmrc`) ist es ein Install-Gate für genau diese Toolchain, wie
  `scripts/check-node-version.mjs` vor `npm install` und `npm test`. Die Desktop-Laufzeit geht
  durch keins von beiden; eine Node-24-Freigabe dort öffnete nur die Toolchain. Der Job
  `desktop (typecheck + test)` läuft auf Node 24, weil der Shell-Code im Electron-Hauptprozess
  läuft. Den Kernel prüfen unter Electrons Node bisher nur „Verify native modules load under the
  Electron ABI“ (`desktop-apps.yml`) und der Start einer gebauten App. **Offen:** ein CI-Bein,
  das wie der Release-Build unter Node 22 installiert und baut und dann die Unit-Suite mit
  Electrons Binary startet, an `npm test` und seinem `pretest`-Guard vorbei, aus `middleware/`:
  `ELECTRON_RUN_AS_NODE=1 ../desktop/node_modules/.bin/electron --import tsx --test …`
  (Electron lädt sein Binary beim ersten Aufruf herunter). Electrons Binary statt
  `setup-node@24`, weil Electrons Node gegen BoringSSL gebaut ist: `node:crypto` kennt dort 28
  Cipher, 9 Hashes und 4 Kurven (Node 24: 130/52/82), und fehlt dem Kernel oder einer
  Abhängigkeit davon etwas, fällt es nur dort auf. Die Primitive des Kernels selbst
  (sha1/sha256 als Hash und HMAC, `aes-256-gcm`, `hkdfSync`, `RSA-SHA256`, Ed25519) laufen
  unter Electron 44.5.1, und die Unit-Suite lief dort lokal mit diesem Aufruf durch
  (2026-10-01, macOS arm64): 10324 Tests, 2 rot — `cliSpawnGate` (liest die lokal installierte
  `claude`-CLI, unter Node 22 genauso rot) und der `graphBackfill`-Flake. Required erst, wenn
  der Flake behoben ist.
- **Kleinkram aus dem Desktop-Refresh:** der Schritt „Allow git-https for git dependencies“ in
  `desktop-apps.yml` ist tot (kein Lockfile zieht mehr eine git-Abhängigkeit); das leere
  Root-`package-lock.json` ohne `package.json` kann weg; der Audit-Schritt installiert
  `npm@latest` ungepinnt.
- **Typecheck-Ratchet `test/` + `scripts/` (#573): 347 bekannte Fehler in 120 Dateien**
  (`middleware/test-typecheck-baseline.json`, Stand 2026-09-29). `npm run typecheck:test`
  blockt nur *neue* Fehler. Abbau: `npm run typecheck:test -- --report`, fixen,
  `-- --update` senkt die Baseline (nie erhöhen). Ziel: leere Baseline, dann den Ratchet
  durch ein hartes `tsc -p test/tsconfig.json` ersetzen, wie `desktop` es mit
  `typecheck:test` schon tut.
- **Prompt-PII C0, Locale `nl`: strukturierter Recall 88,2 % statt 0,97.** Der Floor in
  `packages/harness-plugin-privacy-guard/src/validation/ci-baseline.json` steht für `nl` auf
  0.84 (de/en/es/fr/it: 0.97). Ursachen: NL-Adressen (`straat`/`gracht`/`plein`, Postcode
  `1016 AZ`) ohne C0-Muster und bewusst ungepatterte BSN. Wege: NL-Adressmuster in C0, oder
  `nl` nur mit C1-Sidecar freigeben (`c0+c1` laut `validation/README.md` 89,0 % / 100 %).
  Floor anheben, sobald die Zahl steigt. `mask_user_prompt` ist ein globaler Schalter (kein
  Locale-Schalter); Betreibern mit überwiegend niederländischen Nutzern bis dahin C1 mit
  aktivieren oder die C0-Lücke bei Adressen bewusst in Kauf nehmen.
- **Wackelnder Web-UI-Test `QualityPanel.test.tsx` („Aktualisieren button refetches").**
  Der Test klickt den Refresh-Button, sobald der erste Fetch nur *aufgerufen* wurde; der
  Button ist aber `disabled={loading}`, bis dieser Fetch fertig ist. Landet der Klick im
  Ladezustand, kommt kein zweiter Fetch, und das `waitFor` läuft nach 1 s ab — am
  2026-10-01 einmal im vollen Suite-Lauf rot, isoliert dreimal grün. Fix: vor dem Klick
  warten, bis der Button wieder aktiv ist.

### Offene Punkte aus den Security-Härtungen (2026-09-30)

- **IdP-Logout-URL nicht allowlisted.** Die serverseitig gelieferte absolute End-Session-URL
  (`idpLogout.url`, `web-ui/app/_components/AuthBadge.tsx`) wird ungeprüft angesteuert. Eigene
  Vertrauensgrenze; Härtung z. B. per Allowlist der konfigurierten IdP-Hosts.
- **`/login/:id/start` ohne Längenlimit für `return`.** Der Web-UI-Helper begrenzt auf 2048
  Zeichen; ein direkter Link auf die Middleware-Route ist unbegrenzt (landet im OIDC-State-Cookie).

### Öffentliche Sicherheitsaussagen: was nach dem Abgleich offen ist (2026-10)

README, `docs/architecture.md`, `docs/security-architecture.md` und
`CITATION.cff` beschreiben seit 2026-10-01 nur noch, was der Code durchsetzt
(Wächter: `middleware/test/docsClaimsGuard.test.ts`, Checkliste §11). Die
Privacy-Shield-Aussagen sind seit 2026-10-02 so gebaut: erst, welche
Modellanfragen der Shield bei welcher Einstellung maskiert (die des Turns
selbst), dann ein Satz, dass jeder andere Modellaufruf seinen Text so
schickt, wie er ist, mit den bekannten Fällen (Inbound-Screener,
Signifikanz-Scorer und die übrigen Memory-Jobs, `ctx.llm`, Bilder,
Embeddings). Auch innerhalb des Turns nennen sie die Lücken: Tool-Fehler
werden nur für Tools redigiert oder zurückgehalten, die weder intern-exempt
noch per Bypass freigegeben sind (ein geworfener Fehler bleibt auch unter
Bypass zurückgehalten), und Prompt-Masking blockiert eine Anfrage nur, wenn
C0 scheitert; ein ausgefallener C1-Detektor lässt den Rest des Turns auf C0
laufen. Ein neuer Modellaufruf außerhalb des Turns gehört in §6f. Offen:

- **Publisher-signierte Plugin-Pakete.** Heute gibt es nur SHA-256-Pinning
  (Registry-Index bzw. Hash beim Upload), keine Signatur und keinen Trust Root;
  `Plugin.signed` ist fest `false`. Für echte Signaturen: Signatur beim Publish,
  Prüfung in `RegistryClient` und `PackageUploadService`, `signed`/`signed_by`
  aus dem Prüfergebnis, Schlüsselverwaltung für Publisher. Danach README-Zeile
  „Hash-pinned plugins“, ADR-0001-Status und §4 nachziehen.
- **`http://`-Registries und Schema-Pinning.** `parseRegistries`
  (`src/config.ts`) nimmt jede URL an, `RegistryClient` erzwingt kein TLS.
  `assertHostPinned` vergleicht nur `URL.host` (Host und Port), nicht das
  Schema: Ein `https://`-Index kann eine `http://`-Download-URL auf demselben
  Host listen, die dann im Klartext geladen wird, mit dem Bearer-Token der
  Registry, falls eines konfiguriert ist. Die Integrität hält über den Hash im
  Index, Token und Transport nicht. Nicht-HTTPS außer Loopback ablehnen (mit
  ausdrücklichem Override für lokale Test-Registries) und im Pin die ganze
  Origin (Schema + Host + Port) vergleichen, mindestens `http://`-Artefakte
  einer `https://`-Registry ablehnen.
- **Builder-Build-Template aus npm.** `ensureBuildTemplate` installiert beim
  ersten Boot (und bei geänderter Liste) die Boilerplate-Abhängigkeiten plus
  `BUILD_TIME_ONLY_DEPS` per Semver-Range, ohne Lockfile. Eine Builder-Preview
  lädt den Entwurf in-process gegen genau diese `node_modules`
  (`src/plugins/builder/previewRuntime.ts`), und jeder Build ruft `npx tsc` aus
  dem Template auf (`scripts/build-zip.mjs` der Boilerplate). Versionen exakt
  pinnen oder das Template ins Image legen.
- **MCP-Server per `npx` ohne Version.** Der MCP-Katalog schreibt
  `npx -y -- <paket>`; jeder Connect kann eine neuere Paketversion ziehen. Die
  Version aus dem Registry-Eintrag mitschreiben oder den Operator beim Import
  darauf hinweisen.
- **Texte außerhalb dieses Repos.** Marketing-Site und Hub-Beschreibungen tragen
  die alten Aussagen (signierte Plugins, jede Antwort geprüft, nichts verlässt
  das Haus im Klartext) noch. Abgleich dort als eigener Schritt.
- **Verifier-Absätze im README.** Beschreiben seit dem Verifier-Design aus
  #1267 die ehrlichen Zustände (`skipped`, `unavailable`, nur teilweise
  geprüft), `shadow` als Default-Modus und `enforce` als Auslieferungs-Gate mit
  Retry und Resample über den Replay-Ledger, samt Grenzen (Input-Cards,
  Shield-gerenderte Antworten, Abo-CLI, Routinen, MCP-Transport-Retry ohne
  Ledger) und der Trigger-Muster, ohne deren Treffer `enforce` eine Antwort
  ungeprüft ausliefert. Ändern sich Verdikt-Zustände, Trigger-Muster oder das
  Enforce-Verhalten, README „Answer verification“, §7c und die
  Verifier-Prüfungen in `docsClaimsGuard.test.ts` im selben PR mitziehen.
- **`read_attachment` liest auch CSV-Uploads im Klartext.** Das Tool ist
  intern-exempt und extrahiert `.csv` als Text aus den Original-Bytes im
  Upload-Store, sobald das Modell den `storage_key` kennt (Teams listet ihn im
  `[attachments-info]`-Block). Zellen, die der Dataset-Import derselben Datei
  als PII verschlüsselt (`security-architecture.md` §6b), kommen so roh beim
  Modell an, unabhängig von `mask_user_prompt`. Tabellarische Uploads dort
  ablehnen und auf `query_dataset` verweisen, oder das Ergebnis für Tabellen
  internieren.
- **Receipt-Verluste sichtbar machen.** `persistFailures` zählt nur im Prozess
  (`turnReceiptCounters()` in `src/receipts/store.ts`), kein Endpunkt meldet
  ihn. Ein werfendes `finalize()` zählt gar nicht (ein Turn, der wirft oder
  vor `done` endet, wird seit #1267 über `closeUndeliveredPass` trotzdem
  finalisiert). Zähler auf einer Operator-Oberfläche ausgeben und den
  `finalize()`-Fall mitzählen; erst dann darf das README „gezählt“ sagen.
- **Channel-Verlauf bringt gerenderte Realwerte zum Modell (bestätigt).**
  `priorTurns` laufen nur bei `mask_user_prompt` on durch die Prompt-Maske:
  `maskPriorTurnsForWire` ruft `maskPromptForWire`, das bei `disabled` den
  Text unverändert zurückgibt. Nach einem server-gerenderten v4-Turn
  (`answerSource: 'privacy-render'`) trägt die ausgelieferte Antwort Realwerte
  (`maskedValues`). Teams (`omadia-channel-teams`, `src/teamsBot.ts`:
  `history.append` mit `answerText`, Folgeturn mit `priorTurns`) und Telegram
  (`omadia-channel-telegram`, `src/telegramBot.ts`: `history.append` mit
  `result.text`) bauen ihren Verlauf aus genau dieser Antwort, also sieht das
  Modell die Werte im Folgeturn im Klartext, und zwar im Default. Der
  In-Tree-Web-Chat setzt keine `priorTurns`; sein Recall liest das
  Session-Log, das die Modellantwort vor dem Render speichert. Code-Unit:
  wiederholte Assistant-Antworten unabhängig von `mask_user_prompt` maskieren
  (mindestens die `maskedValues` eines gerenderten Turns), oder Channels eine
  modellseitige Antwort zum Speichern als Verlauf mitgeben (ein Feld neben
  `text` im `SemanticAnswer`, das die Channel-Plugins übernehmen). Danach
  README, §6f und `docsClaimsGuard.test.ts` nachziehen.
- **Plugin-Permissions sind keine Sandbox.** Die Manifest-`permissions`
  schalten nur die `PluginContext`-Accessoren frei. Ein Plugin läuft als
  vertrauenswürdiges JavaScript im Middleware-Prozess und erreicht globales
  `fetch`, `node:fs` und jede andere Node-API (`src/platform/pluginContext.ts`
  sagt das selbst). Für echte Durchsetzung: Isolation (Worker oder Prozess mit
  eingeschränkten Modulen) oder ein Import-Gate beim Upload.
- **Idempotenz am öffentlichen MCP-Endpunkt ist prozesslokal.**
  `ToolIdempotencyStore` (`toolIdempotency.ts`) hält Einträge 15 Minuten, mit
  1.000 Einträgen als Verdrängungsziel (`evictOverflow` überspringt Calls, die
  innerhalb ihres 15-Minuten-Fensters noch laufen, der Store kann also kurz
  mehr halten), nur im Speicher, und merkt sich keinen fehlgeschlagenen
  Aufruf. Neustart, zweite Instanz, abgelaufener oder verdrängter Eintrag
  führen den Write erneut aus. Abgelaufen ist auch der Eintrag eines Calls,
  der nach 15 Minuten noch läuft (`isLiveInFlight`), ein Retry mit demselben
  Schlüssel startet den Write dann ein zweites Mal. Für verteilte Idempotenz
  einen geteilten Store (Postgres) mit demselben Schlüssel einsetzen; die
  Schlüssel-Komposition ist dafür schon serialisierbar.
- **Modellaufrufe außerhalb des Privacy-Handles (eigene Code-Unit).** Der
  Shield wirkt nur in den Modellanfragen des Turns selbst. Ungemaskt, mit
  `mask_user_prompt` an oder aus, gehen: plugin-eigene `ctx.llm`-Anfragen (der
  Accessor `createLlmAccessor`, `src/platform/pluginContext.ts`, liest keinen
  Privacy-Handle), darunter die Skelett-Komposition des Canvas
  (`composeSkeleton`, schickt `input.userMessage` vor dem Turn), Planungs-Gate
  und Planer des Plan-Runners (`gate.ts`, `materializer.ts`, aus
  `onBeforeTurn` mit der Rohnachricht) und jedes Tool, das Daten holt und
  selbst ein Modell fragt; die Memory-Jobs von `@omadia/orchestrator-extras`
  über dessen eigenen Provider mit gespeicherten Realwerten
  (Recall-Relevance-Judge pro Turn, Session-Briefing, Inconsistency-Detector,
  Cluster-Benennung, Topic-Detector für Teams; Fakten- und Excerpt-Extraktion
  lesen dagegen schon den Wire-Text); dazu Bild-Anhänge als Base64-Blöcke an
  ein Modell mit Bild-Eingabe (`buildUserContent`) und, mit dem
  OpenAI-kompatiblen Embedding-Adapter, gespeicherte Turns und Memories im
  Klartext an dessen Endpunkt. Inbound-Screener und Signifikanz-Scorer haben
  einen eigenen Punkt (unten). Die Einzelpunkte zu
  `ctx.llm`, Canvas und Bildern stehen unter „Tool-Fehler-Politik“ und
  „Verifier-Wiedereintritt“; diese Unit fasst sie zusammen: `ctx.llm`- und
  Memory-Job-Anfragen über die Prompt-Maske des Turns bzw. eine Maske für
  gespeicherten Text führen (Handle aus `turnContext`, Maskierung nach dem
  Muster von `maskUserPrompt`, fail-closed), den Canvas-Composer bei aktivem
  Shield auf das deterministische Fallback-Skelett setzen und Bild-Anhänge
  unter aktivem Shield nur nach Policy zulassen. Danach README (Intro, Zeile
  „Privacy Shield“, Abschnitt „Trust & privacy“), §6f und
  `docsClaimsGuard.test.ts` nachziehen.
- **Inbound-Screener und Signifikanz-Scorer schicken Prompt-Text ungemaskt
  (eigene Code-Unit).** Beide laufen außerhalb des Privacy-Handles, auch mit
  `mask_user_prompt` an. Der #579-Screener (`screenInboundTurn`,
  `orchestrator.ts`) läuft in `runTurn` und `chatStream` vor
  `buildPrivacyHandle` und vor `maskTurnPromptForWire`. Unter der
  Default-Posture `auto` (`DEFAULT_SECURITY_POSTURE_POLICY`,
  `harness-channel-sdk/src/securityPosture.ts`) und unter `strict` schickt er
  bei jedem Turn mit Anhang `renderScreeningPayload(bundleProvenance(input))`
  ab: die Nachricht wie getippt, jede `priorTurns[].userMessage`, Namen und
  Typen der Anhänge, an `LlmScreener` auf Provider und Modell des Agenten
  (`buildOrchestrator.ts`) oder an den HTTP-Proxy unter
  `security_screen_url`. Der Capture-Filter von `@omadia/orchestrator-extras`
  schickt beim Default-`capture_level` `normal` (`DEFAULT_CAPTURE_LEVEL`)
  jeden gespeicherten Turn, die Nachricht wie getippt (`userMessage` des
  Session-Logs, `input.userMessage`) plus die wiederhergestellte Antwort
  (`assistantAnswer`), über `CaptureFilteringKnowledgeGraph.ingestTurn` an den
  Extras-Provider (`captureFilter.ts`, `significanceScorer.ts`), auch mit
  `mask_user_prompt` an. Code-Unit: beide über den Wire-Text des Turns
  führen (Screening nach dem Minten des Handles über die maskierte Nachricht
  und maskierte `priorTurns`, Scoring über die maskierten Texte, die schon
  die Fakten-Extraktion bekommt) oder beide in den Turn-Scope verlegen.
  Danach README (Intro, Zeile „Privacy Shield“, Abschnitt „Trust &
  privacy“), §6f und `docsClaimsGuard.test.ts` nachziehen; dort dann auch
  `DEFAULT_SECURITY_POSTURE_POLICY.posture === 'auto'` und den Inhalt von
  `bundleProvenance` festhalten und prüfen, dass README und §6f Screener und
  Scorer nennen.
- **MCP→KG-Ingestion ignoriert die Klammer `OMADIA_PRIVACY_FORCE_GUARDED`
  (eigene Code-Unit).** Der Ingest-Zweig in `Orchestrator.dispatchTool`
  (Epic #459) läuft vor dem Bypass-Resolver und vor dem Internieren und fragt
  `isMcpServerPrivacyBypassed(kgTool.mcpServerId)` direkt
  (`mcpPrivacyBypass.ts`, ein reiner Set-Lookup), nicht über
  `resolveEffectivePrivacyMode`. Ein Server mit `kgIngest` und
  `privacyBypass` speichert so auch mit gesetzter Klammer bis zu 8.000 Zeichen
  jedes Rohergebnisses als `rationale` einer Memory
  (`createMemorableKnowledge`). Spätere Turns können sie in den
  Prompt-Kontext holen, der Recall-Relevance-Judge schickt sie dann ungemaskt
  an den Extras-Provider, und sie wird eingebettet. Der Kommentar in
  `middleware/migrations/0017_mcp_server_privacy_bypass.sql` verspricht, dass
  die Klammer alles abdeckt (angewandte Migration, nicht editieren; die
  Korrektur steht in §6f). Code-Unit: die Bypass-Entscheidung des Ingest-Zweigs
  wie Pfad 0 von `resolveBypass` über `resolveEffectivePrivacyMode` (mit
  `process.env`) führen, sodass er mit Klammer nur den wertfreien
  `mcpObservationDigest` speichert, plus Test mit
  `OMADIA_PRIVACY_FORCE_GUARDED=true` auf den gespeicherten `rationale`.
  Danach README (Zeile „Privacy Shield“, Abschnitt „Trust & privacy“), §6f,
  `.env.example`, §10 („Privacy-Shield-Klammer“) und
  `docsClaimsGuard.test.ts` nachziehen.
- **Fehlertexte intern-exempter Tools gehen ungefiltert ans Modell.**
  `Orchestrator.dispatchTool`, `LocalSubAgent` und `ToolDispatchService`
  geben das Ergebnis eines Tools aus `INTERN_EXEMPT_TOOLS` zurück, bevor sie
  auf den `Error:`-Träger prüfen, und `withholdThrownToolError` hält nur für
  nicht-exempte Tools zurück. Ein `Error:`-Text von `memory` oder
  `read_attachment` und die geworfene Message eines solchen Tools erreichen
  das Modell daher wie geliefert. Unter Operator-Bypass gilt das für den
  zurückgegebenen Fehler (auch in `guardReplayResult`); die geworfene Message
  bleibt dort zurückgehalten, das ist Operator-Vertrag und steht in §6c.
  Code-Unit: für intern-exempte Tools den Control-Flow-Zweig
  (`isGuardedControlFlowResult` → `guardControlFlowResult`) vor die Exemption
  ziehen, sodass nur der `Error:`-Träger redigiert wird und das normale
  Ergebnis exempt bleibt, und in `withholdThrownToolError` die
  Exempt-Ausnahme streichen; Test je Seam mit einem exempten Tool, das einen
  Fehler mit synthetischer E-Mail-Adresse liefert bzw. wirft. Danach §6c,
  §6f, README und `docsClaimsGuard.test.ts` nachziehen.
- **Ausgefallener C1-Detektor: der Rest des Turns läuft still auf C0.**
  Wirft der konfigurierte C1-Detektor, sperrt `c1DetectorFor`
  (`harness-plugin-privacy-guard/src/service.ts`) C1 für den Rest des Turns.
  Prompt-Masking, Tool-Fehler-Redaktion und Verifier-Projektion laufen dann
  nur auf C0 und der Deny-Liste (`outcome: 'masked'` mit `degraded: true`,
  im Log `promptMaskDegraded`/`toolErrorRedactDegraded`), und
  `maskPromptForWire` blockiert nur bei `blocked`. Namen, die nur C1 findet,
  gehen ungemaskt ans Modell, und die `PrivacyReceipt` zeigt den Degrade
  nicht. Code-Unit: den Degrade in die Receipt schreiben und eine
  Operator-Einstellung anbieten, die bei konfiguriertem, aber ausgefallenem
  C1 die Anfrage blockiert, wie ein gescheitertes C0; Test mit einem
  werfenden Fake-Detektor. Danach Manifest-Hilfe (`mask_user_prompt`,
  `c1_detector_url`), `.env.example` und §6f nachziehen.
- **Verifier prüft nur, was ein Trigger-Muster trifft.** `shouldTriggerVerifier`
  (`harness-verifier/src/triggerRouter.ts`) kennt Euro-Beträge,
  Buchungsreferenzen, ISO- und `dd.mm.yyyy`-Daten, Prozente, deutsche
  Stunden-/Tagesangaben und Aggregat-Schlüsselwörter (überwiegend deutsch) mit
  einer mindestens dreistelligen Zahl. Andere Währungen, englische Datumsformate
  und kleine Zählungen lösen für sich nichts aus (steht irgendwo in derselben
  Antwort ein Aggregat-Schlüsselwort und eine mindestens dreistellige Zahl,
  greift das Aggregat-Muster, etwa bei `Total: $500`); die Antwort ist
  `skipped`/`no_trigger` und geht in `enforce` ungeprüft raus. Code-Unit:
  Muster um weitere Währungen sowie englische Datums- und Zahlformate
  erweitern, oder `enforce` eine
  Antwort mit Zahlen ohne Treffer zurückhalten lassen. Danach README, §7c und
  `docsClaimsGuard.test.ts` nachziehen.
- **`verifier_max_retries` über 1 wirkt nicht.** Schema (`VERIFIER_MAX_RETRIES`,
  `max(2)`), `clampMaxRetries` und die Manifest-Hilfe („Max: 2“) erlauben 2,
  `VerifierService.chat` und `streamRetry` laufen aber höchstens einen Retry.
  Entweder eine Retry-Schleife bis `maxRetries` bauen oder Schema, Clamp und
  Hilfetext auf 1 setzen. Die Manifest-Hilfe zu `verifier_mode` („nichts
  Prüfbares fand“) dabei auf die Trigger-Muster präzisieren.

### Self-Update-Steuerungsebene: Vertrauensmodell und offene Härtung (#432 follow-up)

Vertrauensmodell (Details: `docs/security-architecture.md` §10f): Wer den
`docker-socket-proxy` erreicht, ist Host-Root. Seine Abschnitts-Flags filtern nur
nach URL-Präfix, und `CONTAINERS`+`POST` reichen allein schon für einen
privilegierten Container mit Host-Mounts. Die Grenze ist deshalb die
Erreichbarkeit: Der Proxy hängt nur am `internal`-Netz `omadia-control` (ohne
Bridge-Adresse auf dem Host, ohne IPv6), das außer ihm nur der `updater` betritt.
Der Updater ist per Design root-äquivalent, und die Middleware hält sein Token.
Jeder Code im Middleware-Prozess, In-Process-Plugins eingeschlossen, kann damit
ein Update auf ein beliebiges Release-Tag anstoßen. Offen:

- **Exakte Methoden-/Pfad-Allowlist und Loopback-Bind.** Eine eigene
  `haproxy.cfg` im tecnativa-Image ließe nur die acht Calls durch, die der
  Updater macht (Liste im Header von `docker-compose.update.yaml`), und könnte an
  `127.0.0.1:2375` binden. Dann liefe der Proxy mit
  `network_mode: service:updater` (`UPDATER_DOCKER_API=http://127.0.0.1:2375`,
  `depends_on` umgedreht), und die Isolation hinge nicht mehr an der
  Netzwerk-Implementierung der Runtime. Mit dem unveränderten Image 0.3.0 geht
  das nicht: `BIND_CONFIG` setzt `docker-entrypoint.sh` selbst, es ist kein
  Env-Schalter. Eine Quell-IP-ACL wäre kein Ersatz, denn OrbStack maskiert
  netzübergreifenden Verkehr als Gateway-Adresse des Zielnetzes.
- **Kein Downgrade über das Update-Token.** `POST /api/v1/admin/update`
  (`routes/adminUpdate.ts`) lehnt nur das laufende Release ab, der Sidecar
  (`config.mjs`, `TAG_RE`) prüft nur die Form des Tags. Ein
  „nicht älter als laufend“-Gate (mit ausdrücklichem Operator-Override für echte
  Rollbacks) fehlt.
- **Control-Plane-Hostnamen im Plugin-Egress sperren.**
  `extractOutboundAllowlist` (`platform/pluginContext.ts`) nimmt jeden String als
  Host an, und die Static-Allow-List-Modi von `ctx.http` vertrauen benannten Hosts
  ohne SSRF-Guard. `docker-socket-proxy` löst aus der Middleware nicht mehr auf;
  `updater` bleibt erreichbar (Bearer-Token nötig). Ein hartes Deny für beide
  Namen im Host-Matcher wäre billige Defense in Depth.
- **Nicht geprüfte Runtimes.** Die Isolation des Control-Netzes ist auf
  Stock-dockerd 20.10, 24, 27 und 29 (iptables) und auf OrbStack 29.4 geprüft,
  nicht auf Rootless Docker, Podman oder Docker Desktop. Wer das Overlay dort
  betreibt, führt den Check aus `docs/upgrading.md` aus.

### Operator-UI-Header und Sandbox-Limits — bewusst offen gelassen (Security-Doku §3b, §10h)

- **Keine Script-Policy in der Operator-UI.** Die CSP enthält nur
  `frame-ancestors`, `object-src` und `base-uri`. Der nächste Schritt wäre eine
  Nonce pro Request aus `web-ui/proxy.ts` für `script-src`; das zwingt aber jede
  Seite in dynamisches Rendering und muss vorher gemessen werden. `style-src`
  bräuchte zusätzlich `'unsafe-inline'` wegen der `style`-Attribute.
- **Keine zentralen Antwort-Header in der Middleware.** Plugin-UIs
  (`pluginUiStatic.ts`, `withIframeSafeHeaders`) und die Builder-Preview setzen
  eigene; die übrigen `/api/*`-Antworten, die über `/bot-api/*` ankommen,
  tragen weder `nosniff` noch eine Frame-Policy. Die web-ui lässt `/bot-api/*`
  absichtlich unverändert (§10h), die Lücke gehört also in die Middleware.
- **Publish-Container von vor den Limits** laufen ohne Limits weiter, bis eine
  neue Version sie ersetzt: `DockerPublishRuntime.deploy()` fasst bestehende
  Versionen nie an (Unveränderlichkeit), und ein `docker update` dort würde
  diese Zusage aufweichen.

### Ersteinrichtung: was nach Setup-Token und atomarem Admin offen ist

- **Setup-Token-Fehlversuche pro Client zählen.** Der argon2-Hash von `/setup` läuft
  inzwischen im globalen Slot des Anmelde-Limiters (§10m), mehr als
  `AUTH_LOGIN_MAX_INFLIGHT` parallele Hashes gibt es also nicht. Falsche Tokens zählt
  der Limiter nicht: Ein generiertes Token hat 192 Bit, ein selbst gesetztes aber nur
  mindestens 16 Zeichen.
- **Token vorab erzeugen in `fly/deploy.sh` und `render.yaml`.** Heute holt der
  Operator das generierte Token aus `fly logs` bzw. dem Render-Log. Ein beim Deploy
  erzeugtes `ADMIN_SETUP_TOKEN`, wie schon `VAULT_KEY`, würde den Schritt sparen.

### Routine-Karten: identitätslose Klicks schon im Teams-Adapter ablehnen (#1029 follow-up)

Seit 2026-09-30 lehnt der Kernel `RoutinesIntegration.handleRoutineAction` ohne
verwendbaren `actor` ab (`RoutineActorRequiredError`, `routineCardActor.ts`) — kein
Rückfall mehr auf den Turn-Kontext oder auf `{ kind: 'operator' }`. channel-teams
schickt `actor` seit 0.26.1, lässt ihn aber ganz weg, wenn `tenantId` oder die
User-ID fehlt, und ruft den Kernel trotzdem. Dann sieht der Nutzer die generische
Kernel-Absage, und im Log steht eine `[security] REFUSED …`-Zeile, obwohl nur der
Adapter falsch konfiguriert ist. Offen:

- **channel-teams:** den Klick in diesem Fall selbst ablehnen, mit eigener Meldung,
  statt ohne `actor` weiterzureichen. Die Adapter-Tests, die das Weglassen von
  `actor` festschreiben, gehen mit. Release + Hub-Publish.
- **plugin-api 2.0:** `actor` im Typ zur Pflicht machen (heute nur zur Laufzeit,
  damit 1.x-Aufrufer kompilieren). Der Capability-Ref `routinesIntegration@1`
  bleibt davon unberührt.

### Anmelde-Rate-Limit: was offen ist

- **Verteilter Limiter (Redis oder Postgres), sobald die Middleware mit mehr als einer
  Replica läuft.** Heute zählt jeder Prozess für sich, N Replicas vervielfachen jede
  Grenze (§10m, wie beim API-Key-Limiter in §9).
- **Fly: `header:Fly-Client-IP` einmal Ende-zu-Ende gegen eine omadia-Installation
  prüfen.** `fly/middleware.fly.toml` setzt `AUTH_LOGIN_CLIENT_ADDRESS=header:Fly-Client-IP`,
  gestützt auf Fly's Doku: `Fly-Client-IP` ist die Client-Adresse aus Sicht des
  Fly-Proxys, und rechts in `X-Forwarded-For` steht die IP der App selbst (`xff:1`
  wäre deshalb falsch). Ob die Edge einen vom Client mitgeschickten `Fly-Client-IP`
  überschreibt, sagt die Doku nicht. Eine Probe am 2026-10-01 gegen `debug.fly.dev`
  (öffentliche Fly-App, die die empfangenen Header zurückgibt) zeigt es: Ein
  ausgedachter Wert (über HTTP/1.1 und HTTP/2, als Einzelwert, Liste, doppelte
  Zeile oder kleingeschrieben) kam nie bei der App an, sie bekam immer genau einen
  Header mit der echten Adresse (§10m). Offen ist dieselbe Probe gegen eine omadia-Installation,
  sobald diese Version auf Fly läuft: sechs falsche Anmeldungen mit einem
  ausgedachten Wert in dem Header, direkt und über web-ui; die Logzeile
  `[auth] login refused` muss die echte Adresse zeigen. Wäre der Header fälschbar,
  bliebe gegen Rateversuche auf ein Konto nur die globale Grenze: bis zu 300 Versuche
  pro Minute statt etwa 30 pro Stunde (§10m „A key the client can choose“).
  Voraussetzung bleibt, dass web-ui die Middleware über `.internal` erreicht
  (`MIDDLEWARE_URL` in `fly/deploy.sh`): Über `.flycast` säße der Fly-Proxy
  dazwischen und würde den Header vermutlich auf web-ui's eigene Adresse setzen.
  Bestehende Fly-Installationen, die über den Updater aktualisieren, bekommen den
  Wert nicht (der tauscht nur das Image), siehe `docs/upgrading.md`.
- **Render: Client-Header klären.** `render.yaml` lässt den Default `socket`, weil
  nicht geprüft ist, welchen Header Render's Edge setzt und ob er überschrieben wird.
  Bis dahin teilen sich dort alle Browser einen Key (siehe nächster Punkt).
- **Geteilte Paare ohne Geräte-Cookie.** Wer sich einen Client-Key teilt, teilt dessen
  Paare: Ein Absender, der alle 2 Minuten auf ein Konto falsch rät, hält es für jeden
  Browser ohne Geräte-Cookie auf demselben Key zu (§10m „What stays open“). Unter
  `socket` sind das alle Browser hinter web-ui. Eine echte Lösung braucht eine
  vertrauenswürdige Browser-Adresse durch web-ui hindurch; der Next.js-Proxy sieht die
  Socket-Adresse des Browsers nicht, sobald ein `X-Forwarded-For` mitkommt. Denkbar:
  ein eigener Server-Wrapper um Next, der die Socket-Adresse in einen internen Header
  schreibt, den die Middleware nur vom web-ui-Peer annimmt.
- **Session-Signing-Key rotieren: kein Werkzeug.** Der Notfall-Hebel, der alle
  Geräte-Cookies und alle Sessions auf einmal beendet, ist ein neuer
  `core:auth/session_signing_key` im Vault (fehlt der Eintrag, erzeugt die Middleware
  beim Start einen neuen). Der Vault ist eine verschlüsselte Datei; einen einzelnen
  Eintrag zu ersetzen oder zu löschen, geht heute nur mit eigenem Code. Ein
  Admin-Kommando dafür fehlt.
- **Passwort-Obergrenze auch beim Setzen.** Setup-Wizard und Admin-Formulare prüfen nur
  die Mindestlänge. Ein dort gesetztes Passwort über 1024 Zeichen kann sich nicht
  anmelden.
- **`user_disabled` vor der Passwortprüfung.** `LocalPasswordProvider` antwortet für ein
  deaktiviertes Konto mit `auth.user_disabled`, bevor es das Passwort prüft. Der Status
  eines Kontos ist damit ohne Passwort ablesbar.
- **Setup-Seite: 503 `auth.busy` übersetzen.** `/setup` antwortet 503 `auth.busy`, wenn
  kein argon2-Slot frei ist. Die Login-Seite zeigt dafür „bitte N Sekunden warten“, die
  Setup-Seite (`web-ui/app/setup/page.tsx`) zeigt noch die rohe Fehlermeldung.

### Verifier hinter dem Privacy Shield — Folgearbeiten

Seit dem Privacy-Hand-over (Turn-Receipts, `security-architecture.md` §6e)
laufen die Verifier-Requests unter der Surrogat-Map des Turns. Offen:
- **Teams-Card:** `channel-teams` (eigenes Repo) rendert
  `PrivacyReceipt.verifierEgress` noch nicht — das Feld wird ignoriert, bis die
  Card eine "Antwortprüfung"-Zeile bekommt (Web-UI hat sie).
- **Judge-Widersprüche hinter dem Shield:** ein `contradicted` des Judges auf
  Platzhaltern wird bewusst zu `unverified` herabgestuft (Formatabweichungen
  zwischen Claim und Evidenz würden sonst korrekte Antworten blocken). Ein
  format-bewusster Vergleich (z. B. Datums-/Betrags-Normalisierung vor der
  Maskierung) könnte weiche Widersprüche wieder blockierend machen.
- **Ledger-Attribution:** die Verifier-Kostenzeilen können an
  `continuation.receiptId` anknüpfen (siehe Cost-Ledger "Offen").
- **Direct-Line-Relay in `enforce`.** Hinter einem Shield übergibt ein
  Relay-Lauf keine Privacy-Sicht; `enforce` hält seine Antwort deshalb als
  `unavailable` / `privacy_shield` zurück. Wer Direct-Line-Agenten mit
  `enforce` und Shield betreibt, bekommt dort keine Antwort. Prüfen, ob die
  Relay-Antwort über die Sicht des Sub-Agent-Laufs verifiziert werden kann.
- **Wertgleiche Platzhalter beim Minting:** `createPromptPseudonymMap`
  (`v4/pseudonym.ts`) prüft Kollisionen nur als String. Ein echtes Datum oder
  ein echter Betrag, dessen Wert einem Kandidaten entspricht, bekommt einen
  Platzhalter mit demselben Wert in anderer Schreibweise (echte „10.000 €“ →
  „€10000“, „1970-01-01“ → „01.01.1970“) — der Request trägt dann den echten
  Wert. Nebenwirkung: `countUnresolvedSurrogates` zählt den restaurierten
  echten Wert als ungelöst, ein Retry/Re-Sample wird in so einem Turn nie
  gezeigt (sichere Richtung). Fix: Kandidaten per `asValueLiteral` gegen die
  Werte der echten Spans und der Datums-/Betragsliterale im Prompt prüfen.
- **Grenzen der Wertprüfung:** ausgeschriebene Zahlen („zehntausend Euro“),
  Daten ohne Jahr („am 1. Januar“) und umgerechnete Werte (Monats- statt
  Jahresbetrag) erkennt `countUnresolvedSurrogates` nicht; ein so
  umgeschriebener Platzhalter bliebe in einer zweiten Antwort sichtbar.

### Tool-Fehler-Politik: offene Enden

Stand nach dem Fix „Tool-Fehler an den Dispatch-Nähten“ (§11,
`docs/security-architecture.md` §6c):

- **Channel-Renderer außerhalb dieses Repos** (Teams-/Telegram-Karten in
  `omadia-channel-teams` / `omadia-channel-telegram`) kennen
  `PrivacyReceipt.toolErrors` noch nicht. Das Feld ist additiv, sie ignorieren
  es — zeigen die Einträge aber auch nicht. Die Web-UI zeigt sie.
- **Laufzeit-Abhängigkeit der Tool-Plugins**: Web-Search, Diagramme und
  Discussion (je 0.2.0) importieren `toolErrorFromException` (Web-Search und
  Diagramme auch `newToolErrorRef`) zur Laufzeit aus `@omadia/plugin-api`
  ≥ 1.20.0. Gebündelt passt das immer. Ein Build für einen älteren Host lädt
  dort nicht, und `compat.core` erzwingt nichts. Ein Hub-ZIP gibt es nur für
  Web-Search, der Publish ist offen (siehe „Hub-Publish der
  In-Tree-Plugins“).
- **Office-Plugin** (`officeTool.ts`) liefert bei einer unerwarteten Exception
  weiter `Error: <message>`; die Naht redigiert oder hält zurück. Umstellung
  auf `toolErrorFromException` offen. Die eigenen Fehler des Plugins
  (`OfficeUnsafeFormulaError`, `OfficeRenderError`,
  `OfficePostconditionError`) sind selbst formuliert und müssen lesbar bleiben:
  ihre Absage nennt Zelle und Grund, damit das Modell die Formel korrigiert,
  und die Naht lässt sie heute unverändert durch. Ausnahme: Die Schema-Absage
  für ein Steuerzeichen (`… control character U+0001 …`) kommt als
  `U[masked:phone]` beim Modell an, weil C0 `+0001` als Telefonnummer liest.
- **Abo-CLI-Pfad** ohne Privacy Shield (#1087): beide Träger fließen dort roh.
- **Öffentlicher MCP-Endpunkt, Sub-Agent:** das Gate redigiert keine
  Tool-Fehler, also sieht der Sub-Agent eines Domain-Tools innere
  `Error:`-Texte nur als Withheld-Notice und kann sich nicht am Hinweis
  korrigieren. Redigierte Hinweise dort zuzulassen wäre eine eigene
  Entscheidung: C1-Kosten und Per-Turn-State im Provider für einen Request, der
  nie finalisiert wird. Außerdem fehlt dem öffentlichen Dispatcher die
  Sub-Agent-Dataset-Brücke (`subAgentResultV4`); die Antwort des Sub-Agents
  wird dort erneut als Datum interniert.
- **Plugin-eigene Modellaufrufe (`ctx.llm`)** laufen auf keinem Einstiegspfad
  durch den Privacy Shield, im Chat so wenig wie am öffentlichen Endpunkt: der
  Accessor (`createLlmAccessor`, `platform/pluginContext.ts`) liest keinen
  Privacy-Handle, ein Plugin-Tool, das Daten holt und selbst ein Modell fragt,
  schickt sie, wie es sie zusammengebaut hat. Über den Shield geht nur das
  Ergebnis des Tools. Eine Prompt-Maskierung für diese Aufrufe (nach dem
  Muster von `maskUserPrompt`) wäre eine eigene Entscheidung.
- **Connect-Prompt** wird per Provenienz erkannt (`McpAuthPromptMint`), nicht
  mehr am Präfix. Offen: paraphrasiert ein Sub-Agent den Prompt, statt ihn
  byte-gleich weiterzugeben, wird seine Antwort an der Eltern-Naht interniert
  (sofern er kein Dataset interniert hat) und die Connect-Karte fehlt in der
  Antwort. Ein typisiertes Control-Flow-Ergebnis statt Prosa wäre die
  dauerhafte Lösung.
- **Geworfener Text** wird ganz zurückgehalten, nicht C0-redigiert. Wer den
  Treiber-Hinweis zurück will, stellt in `withholdThrownToolError` auf
  `redactToolErrorText` um (eine Stelle) — um den Preis von Namen, die C0
  nicht erkennt.
- **Wiederholung nach einer Exception:** seit dem Replay-Ledger (§3)
  verweigern innerhalb derselben Anfrage auch die Eltern-Loops (gepuffert und
  Stream) und der Abo-CLI-Sub-Agent (über die `dispatch`-Naht seines
  Loopback-Snapshots) die identische Wiederholung eines Write-Calls, der mit
  einer Exception oder der Withheld-Notiz endete — nahtübergreifend,
  `LocalSubAgent` behält zusätzlich seine Sperre pro Lauf. Offen bleibt:
  (a) der **Haupt**-Abo-CLI-Agent (`CliChatAgent` als Chat-Agent) läuft ohne
  Orchestrator-Turn und hat keinen Ledger, dort sperrt nichts; (b) zwei
  identische Calls im **selben** parallelen Batch laufen beide, die Sperre
  greift erst für Calls, die nach dem Throw entschieden werden; (c) nach
  einem Dispatch-Deadline-Timeout oder einem zurückgegebenen Fehler mit
  ebenso unbekanntem Ausgang (MCP-Request-Timeout) wird nicht gesperrt;
  (d) eine Wiederholung mit anderem Input läuft. Ein Write genau einmal
  auszuführen braucht dafür Write-Metadaten plus Idempotenz-Key (wie
  `ToolDispatchService` sie für das MCP-`exactlyOnce` setzt).
- **Exception-Formen ohne C1:** positionale Datensatz-Dumps
  (`Partner(42, 'Jane Doe')`, Gos `%v`) und `name=…`-Paare außerhalb eines
  Datensatzes erkennt `looksExceptionShaped` nicht; ein Name darin geht ohne
  C1 an das Modell. Jedes weitere Muster kostet Hinweise, die heute lesbar
  bleiben — vor einer Erweiterung die Negativliste in
  `toolErrorExceptionShape.test.ts` prüfen.

### Hub-Publish der In-Tree-Plugins (#1075)

Nur `@omadia/plugin-office` und `@omadia/plugin-web-search` gehen aus
`middleware/packages/` auch auf den Hub (`docs/creating-plugins.md` §8). Der
Hub serviert office 0.1.2 und web-search 0.1.0 (`registry/index.json`, Stand
2026-10-01). Das Repo steht bei office 0.1.4 (Formeln ohne gecachtes Ergebnis,
Formel-Policy) und web-search 0.2.0 (Tool-Fehler über
`toolErrorFromException`). Beide Publishes sind offen, und `docs/upgrading.md`
verspricht Hub-Installationen office 0.1.4 erst mit diesem Schritt.

- **Mindest-Host im Release-Text.** Web-Search 0.2.0 importiert zur Laufzeit
  aus `@omadia/plugin-api` ≥ 1.20.0. Das ZIP ist flach und löst die Plugin-API
  vom Host auf, ein älterer Host lädt es also nicht.
- **Vorher messen.** `latest_version` aus dem Index lesen, ein Plugin nach dem
  anderen publizieren, nie `?overwrite=true`, danach den Index pollen
  (`docs/creating-plugins.md` §8, dort auch Bundled-ID-Ablehnung und toter
  Update-Badge).
- **Nicht auf dem Hub:** Privacy Guard (0.6.0), Diagramme und Discussion (je
  0.2.0) laufen nur gebündelt. Ein ZIP mit ihrer ID lehnt der Upload ab
  (`package.id_conflict_bundled`), außer mit
  `PLUGIN_ALLOW_BUNDLED_ID_OVERRIDE=1`.

### Verifier-Wiedereintritt (Replay-Ledger): offene Enden

Stand nach „Wiedereintritte führen kein Tool erneut aus“ (§3,
`docs/security-architecture.md` §7c):

- **Erledigt: Session-Log hält die gelieferte Antwort.** Commit-on-Delivery
  (§3, `requestTurnRecord.ts`) schreibt die eine Zeile der Anfrage nach dem
  Urteil für den gelieferten Lauf. Offen bleibt nur, was der Commit für eine
  **zurückgehaltene** Antwort schreibt: die Antwort des Laufs, über den das
  Endurteil ging (Punkt „Zurückgehaltene Antwort wird trotzdem persistiert“
  unten) — der Commit kennt das Urteil jetzt, ein Marker statt der Antwort
  wäre dort einzuhängen. Eine Anfrage mit Request-Ledger, die nie committet
  wird (Aufrufer ohne `finally`), verliert ihre Zeile; beide bestehenden
  Binder committen auf jedem Pfad.
- **Kein positives Read-only im Plugin-Vertrag.** Auf einem Wiedereintritt
  dürfen nur Kernel-Lese-Tools neu laufen; jeder Plugin-, MCP-, Domain- und
  Sub-Agent-Call, den der erste Lauf nicht machte, bricht ab — auch reine
  Lesezugriffe. Eine `readOnly`-Deklaration auf `NativeToolRegistration`,
  `DomainTool` und `LocalSubAgentTool` (dort fehlt auch ein
  `writeCapabilities`-Träger) würde mehr Wiedereintritte zu Ende laufen
  lassen. Fehlendes `writeCapabilities` darf dafür NICHT reichen.
- **Correction-Retry auf Write-Turns bricht oft ab.** `traceMissingCallVerdict`
  blockiert jede harte Odoo-Aussage ohne `query_odoo_*`/`odoo_execute`-Call;
  nennt eine Antwort den gerade angelegten Datensatz, folgt der Retry, und
  ein neu formulierter Write-Payload bricht ihn ab (`failed`). Prüfen, ob
  write-fähige Plugin-Tools als Evidenz zählen sollen.
- **Exakter Input.** Ein Wiedereintritt trifft den aufgezeichneten Call nur
  bei identischem kanonischem Input (Schlüsselreihenfolge egal). Bewusst kein
  Fuzzy-Matching — das würde einen anderen Write ausführen.
- **Canvas-Turns ohne Stream-Retry.** Der Canvas-Composer ordnet
  Roh-Sentinels per Tool-Name (FIFO) zu; ein Retry, der Calls umsortiert,
  könnte eine Surface mit dem falschen Ergebnis bauen. Für Canvas-Turns
  bleibt es beim Zurückhalten ohne Retry, bis die Zuordnung per Call-ID läuft.
- **Abo-CLI-Sub-Agent: Obligation-Re-Prompt.** Der zweite CLI-Spawn bei
  fehlendem `expectedTurnToolUse` wird angewiesen, aber nicht daran gehindert,
  einen erfolgreichen Write zu wiederholen; der Ledger zeichnet im ersten
  Lauf nur auf. Ein „replay-or-execute“-Modus für diesen Spawn wäre der Fix.
- **Abgespielte Status-Abfragen.** Ein `_status` eines langlaufenden
  Sub-Agent-Tasks wird im Wiedereintritt mit dem Stand des ersten Laufs
  abgespielt — gewollt (gleiche Evidenz), aber kein Live-Stand. Der Runner
  selbst läuft seit `runDetachedFromRequestLedger` auf eigenem Ledger; er
  erbt aber weiterhin den übrigen Turn-Kontext des Dispatches (Privacy-Handle,
  Sinks — `describeDeferredPrivacyPosture`). Andere abgekoppelte Arbeit, die
  später Tool-Handler ruft, muss denselben Weg nehmen (Security §11).
- **Screening-Marker bleibt am Input.** `markScreeningReentry` setzt einen
  WeakSet-Eintrag auf das Input-Objekt, der nach der Anfrage bleibt (anders
  als der Ledger, der freigegeben wird). Ein Aufrufer, der dasselbe Objekt für
  eine neue Nachricht wiederverwendet, umginge das Inbound-Screening. Kein
  bekannter Aufrufer tut das; Freigabe analog zum Ledger wäre billig.
- **Verifier-Evidenz wird mandantenweit geholt.** `GraphEvidenceFetcher`
  (`findEntities` nach Modell, exakter ID und Name, inkl. der
  `res.partner`/`hr.employee`-Namensproben) und der deterministische
  Odoo-Re-Query laufen ohne User-Identität und Grants. Seit dem Fix verlässt
  ihr Inhalt den Verifier nicht mehr Richtung Turn (kein `truth`/`detail` im
  Correction-Hint, die Summary trägt nur Zähler); er geht aber an das
  Judge-Modell (hinter dem Shield projiziert, Security §6e, ohne Shield roh)
  und in `verifier_contradictions`. Offen: den Abruf auf den aufgelösten
  User und seine Grants beschränken und ohne beides fail-closed werten
  (keine Evidenz → `unverified`) — Voraussetzung, bevor Evidenz je wieder an
  ein Turn-Modell oder einen User geht.
- **Retry ohne Messwert.** Der Correction-Retry korrigiert nur noch aus den
  (abgespielten) Tool-Ergebnissen des Turns; einen Wert, den nur der
  Verifier kannte, kann er nicht übernehmen. Erwartung: weniger
  `corrected`, mehr zurückgehaltene Antworten — `corrected`-Rate vor/nach
  messen.
- **Hint-Texte passen nicht zum Replay.** Postcondition- und Replay-Abschnitt
  von `buildCorrectionPrompt` verlangen einen neuen Tool-Call; im
  Wiedereintritt wird jeder Call außerhalb des ersten Laufs (außer
  Kernel-Lesern) abgelehnt und der Retry abgebrochen. Texte an die
  Replay-Realität anpassen oder für diese Fälle keinen Retry starten.
- **Masking-Grenze des Hints.** Er wird mit denselben Detektoren geprüft und
  maskiert wie die Nachricht: hinter einem Shield geht ein Hint, den die
  Maskierung verändern würde, gar nicht raus (Retry zurückgehalten); was
  keiner erkennt (Namen ohne C1, freie Beträge ohne Währung …), geht wie in
  der Nachricht ans Modell; mit `mask_user_prompt` aus (Default) wird nichts
  maskiert. Die Claims sind Wortlaut der Antwort.
- **Nudge-State pro Lauf.** `applyNudgePipeline` läuft auch nach
  abgespielten Tool-Batches eines Wiedereintritts und kann
  `recordEmission` erneut schreiben (kein User-Write; Cooldown/Statistik).
  Prüfen, ob ein Wiedereintritt (`isReentryPass()`) die Emission
  überspringen soll.
- **Wiedereintritte überspringen das #579-Screening.** `prepareReentry`
  markiert den Input (`markScreeningReentry`), das Inbound-Gate läuft für
  Resample und Retry nicht erneut. Den Untrusted-Marker, den das Gate im
  ersten Lauf bei einem Screening-Ausfall (fail-open) an den
  `extraSystemHint` hängte, trägt ein Wiedereintritt nicht: der Retry-Input
  entsteht aus dem Input des Aufrufers, dessen `extraSystemHint` der
  Correction-Hint ersetzt, und ein Resample läuft mit dem Input vor dem Gate.
  Der Wiedereintritt sieht dieselben Anhänge und abgespielten
  Tool-Ergebnisse ohne den Hinweis, dass sie ungeprüft sind. Fix: die
  Gate-Entscheidung des ersten Laufs (samt Marker) an den Wiedereintritt
  weiterreichen, statt neu zu screenen oder sie zu verlieren.
- **Bild-Blöcke umgehen die Privacy-Grenze (#504/#505).** Bild-Anhänge gehen
  als Vision-Blöcke ungemaskt ans Modell — der Shield maskiert nur Text
  (`ingestedImages` läuft am Prompt-Masking vorbei). Der Ledger hält die
  Bild-Blöcke des ersten Laufs und gibt sie jedem Wiedereintritt mit, der
  sie erneut an den Provider schickt. Ein Bild mit personenbezogenen Daten
  (Scan, Screenshot) verlässt den Prozess damit unmaskiert, im ersten Lauf
  wie im Wiedereintritt. Offen: Bild-Anhänge unter aktivem Shield nur nach
  Policy zulassen (abschaltbar, oder OCR plus Maskierung statt Vision).
- **MCP-Transport-Retry in Turns ohne Request-Ledger.** Bei gebundenem
  Request-Ledger sendet jede Naht jeden Call nur einmal
  (`runHandlerAtMostOnce` → `sendsEachCallOnce`, §3). Turns ohne
  Request-Ledger — `shadow`, Verifier aus, `enforce` ohne erlaubten
  Wiedereintritt, Canvas-Stream — behalten den einen Retry
  (`MCP_CALL_MAX_ATTEMPTS = 2`, `mcp/mcpClient.ts`): dort kann
  ein MCP-Write, dessen Antwort verloren ging, zweimal laufen. Bewusst so
  gelassen (#542: der Retry fängt einen wackligen gehosteten Proxy ab, für
  Lesezugriffe harmlos). Fix: Write-Metadaten für MCP-Tools (Punkt „Kein
  positives Read-only im Plugin-Vertrag“) oder die Ein-Versuch-Regel für
  jeden Chat-Turn. Daneben: ein transienter MCP-Fehler kommt als
  `Error:`-Text zurück (`handleFailure` wirft nicht), markiert den Call also
  nicht als „Ausgang unbekannt“ — das Modell darf denselben Write erneut
  aufrufen.
- **Erledigt: Interning fail-closed.** Wirft `privacy.internToolResultV4`,
  bekommt das Modell an jeder Naht die Notiz `internFailedNotice` (Call lief,
  Ergebnis zurückgehalten, nicht erneut aufrufen) statt des Rohergebnisses —
  im ersten Lauf wie im Wiedereintritt; `query_dataset` behält seinen Text.
  Kostet Antworten, sobald der Privacy-Provider hakt (Log:
  `privacy.internToolResultV4 threw — result WITHHELD`). Ein Receipt-Eintrag
  für den zurückgehaltenen Inhalt fehlt noch — es ging nichts raus, aber der
  Turn-Receipt zeigt den Ausfall nicht.
- **`replayed` erreicht den Knowledge Graph nicht.** Liefert der Verifier
  einen Wiedereintritt, schreibt das Session-Log dessen Trace
  (Commit-on-Delivery); beide KG-Backends legen pro Trace-Eintrag einen
  `ToolCall`-/`AgentInvocation`-Knoten an und lassen `replayed` fallen
  (`neonKnowledgeGraph.ts`, `writeToolCall`). Abgespielte Calls stehen dort
  wie Ausführungen dieses Laufs, mit der Dauer des Replays; der Trace des
  ersten Laufs, in dem sie wirklich liefen, wird nicht geschrieben. Fix:
  `replayed` als Knoten-Property in beiden Backends mitschreiben (JSONB, keine
  SQL-Migration) — plugin-api 1.21.0 dokumentiert die Lücke.
- **Canvas-Skelett-Komposition umgeht die Privacy-Grenze.** Vor dem
  geschützten Turn schickt der ui-orchestrator `input.userMessage` (oder die
  serialisierte Aktion) über den LLM-Accessor des Plugins an das
  Kompositionsmodell (`composition.ts`, `composeSkeleton`;
  `pluginContext.ts`) — ohne das Prompt-Masking des Turns. `verdictHold.ts`
  regelt nur, wann das Skelett ausgeliefert wird, nicht, was an den Provider
  geht. Mit `mask_user_prompt` an verlässt der Nutzertext den Prozess damit
  unmaskiert. Fix (eigener Fix, außerhalb dieses Bündels): Komposition über
  die Privacy-Sicht des Turns führen, oder bei aktivem Shield das
  deterministische Fallback-Skelett nehmen.
- **Kalibrierung vor `enforce`: verborgene Antworten haben keine Zeile.**
  `verifier_verdicts.reason` (KG-Migration 0034) macht `skipped`-Gründe
  abfragbar (`docs/upgrading.md`). `shadow` schreibt aber keine Zeile für eine
  Antwort, die der Verifier hinter dem Shield nicht sehen darf (Render,
  Direct-Line-Relay) — `enforce` hält jede davon zurück. Gezählt werden kann
  nur über die Log-Zeile `verification skipped run=…`. Fix: in `shadow` eine
  `unavailable`/`privacy_shield`-Zeile schreiben, ohne zu prüfen.

### MRTR-Sentinel über Skill-Bindung und `ctx.mcp` (#570 follow-up)

Die skill-gebundenen MCP-Tools (`subAgentToolHydration.ts`, Domain-Tools des
Orchestrators) und der Plugin-Accessor `ctx.mcp.callTool` (`pluginContext.ts`)
rufen den `McpManager` in einem `turnContext.run(...)` mit **neu gebautem**
Store auf und reichen nur ausgewählte Felder weiter. `mcpInputSentinelMint`
gehört nicht dazu: parkt ein solcher Call eine `input_required`-Karte, schreibt
`parkInputRequired` keine Provenienz, und `dispatchToolDeadlined` interniert
den Sentinel bei aktivem Privacy Shield — die Karte erscheint nicht. Befund aus
der Code-Lektüre beim Connect-Prompt-Fix, nicht per Test reproduziert. Der
Connect-Prompt hat deshalb einen eigenen AsyncLocalStorage
(`McpAuthPromptMint`); für den Sentinel reicht dasselbe oder die Weitergabe des
Felds in beiden Re-Scopes.

### Graph-Tools: exakte ID-Abfrage auch für Agenten

Seit plugin-api 1.21.0 kann `findEntities` einen Datensatz über `id` exakt
adressieren (§7), der Verifier nutzt das. Die Agenten-Tools tun es noch nicht:
`query_graph` (`createGraphLookupTool`, `harness-verifier/src/graphLookupTool.ts`)
und `find_entity` in `query_knowledge_graph` kennen nur `name_contains`. Ein
Sub-Agent, der nach „Partner 42“ fragt, bekommt so auch 142, 420 oder
„Halle 42“. Offen: einen optionalen `id`-Input an beide Tools, Beschreibung und
§7 entsprechend anpassen.

### Finalize-Pass: offene Punkte aus #1211

- **Zweite Directive-Kopie bei ignoriertem `tool_choice: none`.** Der Finalize-Pass
  hängt `FINALIZE_DIRECTIVE` an den neuesten User-Turn (append-only, damit `system`
  und `tools` byte-identisch bleiben). Emittiert das Modell trotz Suppression noch
  ein `tool_use`, läuft eine weitere Finalize-Iteration und hängt eine zweite Kopie
  an. Vor #1211 konnte das nicht passieren (der Hint wurde pro Iteration neu
  gebaut). Harmlos, aber unschön — ein Idempotenz-Flag pro Turn würde es schließen,
  kostet dafür die frische Platzierung am Ende des Transcripts.
- **Provider ohne `tool_choice`: Cache-Verlust im Finalize-Pass.** Server mit dem
  `dropToolChoice`-Quirk (MiniMax) melden `capabilities.toolChoiceNone === false`;
  dort schickt der Finalize-Pass `tools: []` wie vor #1211 — die Garantie „Turn
  endet in Text“ bleibt, der Prompt-Cache dieses einen Calls ist futsch. Besser
  wäre ein serverseitig akzeptiertes Äquivalent, sobald es eins gibt.
- **`forcedToolChoice` lügt unter demselben Quirk.** `DEFAULT_CAPABILITIES` der
  OpenAI-Adapter meldet `forcedToolChoice: true`, obwohl der Quirk auch
  `{type:'required'|'tool'}` verschluckt — Card-Router und `#332`-Obligation
  glauben dort an ein Forcing, das nie auf der Leitung landet. #1211 hat nur
  `toolChoiceNone` ehrlich gemacht; die beiden anderen Pfade brauchen je eine
  eigene Entscheidung (Capability ehrlich melden **und** Fallback bauen), darum
  nicht mitgezogen.

### Teams-Provisioning: Legacy-Classifier für `last_error` entfernen (#897 follow-up)

`classifyTeamsProvisioningError()` (`services/teamsProvisioningJob.ts`) liest seit Migration
0060 nur noch Zeilen ohne vertrauenswürdigen `error_code`: solche von vor 0060 und solche,
deren `last_error` ein Build ohne die neuen Spalten überschrieben hat (Rollback über 0060).
Löschbar, sobald kein Build von vor #897 mehr gegen eine migrierte DB laufen kann **und**
keine Zeile ohne passendes Siegel mehr existiert:

```sql
SELECT count(*) FROM agent_teams_identities
 WHERE last_error IS NOT NULL
   AND (error_code IS NULL
        OR error_detail->>'sentenceSha256'
           IS DISTINCT FROM encode(sha256(convert_to(last_error, 'UTF8')), 'hex'));
-- muss 0 sein
```

Dann fallen auch der Präfix-Fallback im Config-Sync-Cleanup und die
Round-Trip-Tests in `test/teamsProvisioningLastError.test.ts` weg; die Satz-Präfixe dürfen
danach frei umformuliert werden.

### Keychain-Asks (Epic #778) — Rest nach S1

S1 bindet `/api/v1/admin/credential-asks` an die Session
(`req.session.omadia_user_id`), leitet den Owner eines Asks aus dem Owner des
Credentials ab und lässt nur diesen Owner approven/denyen (D2: kein
Operator-Break-Glass). Daraus folgt eine Vorgabe für alles, was künftig
Credentials anlegt (Create-Route, Admin-UI): der Owner eines
`personal`-Credentials **muss** als `user:<omadia_user_id>` gespeichert werden —
nicht als `sub`/E-Mail, nicht als `role:`. Sonst stimmt kein Session-Principal je
mit `ask.owner` überein, und niemand kann das Ask beantworten
(`role`-Owner lehnt `assertAskableCredential` deshalb schon als `not_askable`
ab). Offen im Epic: das agent-aufrufbare Broker-/Ask-Tool, die Benachrichtigung
des Owners (heute nur per `GET /pending` auffindbar) und die Admin-UIs (P4).

### Umgekehrte Richtung: extras allein neu gebaut, Orchestrator hält alte Instanzen (#1076 follow-up)

#1076 baut bei einer Provider-Änderung des Orchestrators extras **vor** dem
Orchestrator neu. Offen ist die Gegenrichtung: wird extras allein reaktiviert
(direkte Zuweisung an extras; `adminSettings`, das nach einem Key-Speichern
den Orchestrator vor extras reaktiviert; oder der OAuth-Fan-out
`fanOutProviderOAuthTokens` in `src/routes/adminProviders.ts`, der in
`LLM_PLUGINS`-Reihenfolge reaktiviert und Fehler per `.catch(() => undefined)`
verschluckt), hält der laufende Orchestrator
weiter die vorherigen `FactExtractor`/`ContextRetriever`/`SessionBriefing` und
den KG-Wrapper, weil er sie eager in `activate()` abgreift und ein Teardown
nicht kaskadiert. Die allgemeine Lösung — nach einem Provider-Rebuild die eager
Konsumenten neu bauen — gehört in das gemeinsame `reactivateAgent` in
`src/index.ts`. #1080 (PR #1186, gemergt) hat dort nur den Refresh des
geteilten Host-Clients ergänzt, keinen Rebuild eager Konsumenten; die
Gegenrichtung bleibt offen und bewusst außerhalb von #1076.

### Weitere eager Abgriffe, die ein extras- oder Provider-Rebuild nicht erreicht

Dieselbe Klasse wie oben, außerhalb des Scopes von #1076:

- **Teams** greift den `topicDetector` von extras einmal in `activate()` ab
  (`omadia-channel-teams`, `src/plugin.ts`). Nach einer Neuzuweisung des
  Orchestrators kann `memoryFeatureStatus` den Detektor als aktiv auf dem neuen
  Provider melden, während Teams noch die alte (oder keine) Instanz hält.
- **Plan-Runner und Verifier** halten den KG-Wrapper von extras aus ihrem
  eigenen `activate()`.
- **Dynamische Sub-Agents** lösen `hostProviderId` einmal je Aktivierung auf
  (`src/index.ts`, `dynamicAgentRuntime.ts`).

### `ctx.llm` friert den geerbten Provider bei Kontext-Erzeugung ein

`resolveActiveProvider` (`src/platform/pluginContext.ts`) wird einmal in
`createPluginContext` ausgewertet. Für jedes Plugin ohne eigenes `llm_provider`
steht damit der geerbte Orchestrator-Provider bis zum nächsten Rebuild fest.
Ein lazy Getter würde das dort beheben; das „kein Lazy-Lookup“ aus #1076 gilt nur
für extras, dessen Instanzen der Orchestrator eager festhält.

Ebenso zählt der Aufrufzähler des Accessors (`callsUsed`) über die Lebenszeit
des Kontexts. Für ein Extension-Plugin ist `calls_per_invocation` damit ein
Budget seit der Aktivierung (das ui-orchestrator-Manifest setzt deshalb
1000000). Der Plan-Runner (`calls_per_invocation: 30`) bekommt nach 30
Modellaufrufen `LlmBudgetExceededError`; `shouldPlan` fängt ihn und plant bis
zur nächsten Aktivierung nichts mehr, ohne Meldung. Budget pro Turn zählen oder
die Obergrenze des Plan-Runners anheben.

### Dynamische Sub-Agenten übernehmen Key-Änderungen erst nach Rebuild (#1080 follow-up)

- `src/plugins/dynamicAgentRuntime.ts` (`activate()`, ~Z. 498-534) löst den
  Provider **einmal** auf: `liveAnthropicProvider()` bzw.
  `providerPool.get(hostProviderId)`. Die Pool-Invalidierung aus #1080 erreicht
  bereits gebaute Sub-Agenten deshalb nicht. Nach einem Boot ohne Key bleiben
  Anthropic-Sub-Agenten auch nach dem Speichern eines Keys auf dem
  unauthentifizierten `''`-Client, bis sie neu gebaut werden (Neustart oder
  Rebuild). Nicht-Anthropic-Agenten, deren Aktivierung mangels Key
  fehlgeschlagen ist, werden nie erneut aktiviert. Umgekehrt nutzen gebaute
  Sub-Agenten einen gelöschten Key weiter. Der Chat-Pfad ist zu, weil der
  Orchestrator ohne Key `chatAgent@1` nicht mehr published; Plugins mit
  `permissions.subAgents.calls`-Grant erreichen sie aber weiterhin über
  `ctx.subAgent.ask` (`src/platform/pluginContext.ts`, Service
  `subAgent:<id>`). Das begrenzt den Schaden, behebt ihn aber nicht.
  Reparatur: Provider pro Aufruf spät auflösen oder die dynamischen Agenten
  bei einem Credential-Write neu bauen.
- Auf env-geseedeten Installationen nutzen Host-Consumer nach dem Löschen des
  Vault-Keys weiter `ANTHROPIC_API_KEY` (derselbe Key). Der Refresher sollte das
  zumindest als Warnung loggen.

### Desktop-Shell: restliche Flächen folgen nicht der UI-Sprache (#1074 follow-up)

#1074 hat die Shell-Dialoge (Updater, Boot-Fehler, Recovery-Key) und die
Menü-Überschriften auf die UI-Sprache umgestellt: Die Web-UI pusht ihre Sprache
über `omadia:uiLocale`, `desktop/src/shellLocale.ts` hält und persistiert sie in
`userData/ui-locale.json`. Offen sind:

- **Tray-Menü** (`desktop/src/tray.ts`) — Labels fest auf Englisch.
- **Datenordner-Auswahl und Cloud-Sync-Warnung** (`desktop/src/ipc.ts`,
  `chooseDataDirWithSyncWarning`) — Titel, Buttons und Text fest auf Englisch.
- **Lade- und Setup-Wizard-Seiten** (`desktop/src/renderer/wizard-i18n.js`) —
  richten sich nach `navigator.language`, also nach der OS-Sprache. Seit #1074
  sichtbar inkonsistent: ein Boot-Fehler- oder Recovery-Dialog spricht die
  persistierte UI-Sprache, die Ladeseite dahinter die OS-Sprache. Die Reparatur
  wäre, der Seite den Wert aus `shellLocale` mitzugeben, statt
  `navigator.language` zu lesen.
- **Electrons eigene `role:`-Menüeinträge** folgen der OS-Sprache; außerhalb
  unserer Reichweite, nur zu benennen.

### Desktop: Schlüsseldatei `secrets.enc` — offene Punkte

Die Desktop-App erzeugt neue Schlüssel nur noch, wenn `secrets.enc` fehlt
(ENOENT). Jede andere Lesestörung stoppt den Boot mit einem
Wiederherstellungsdialog, und jedes Neuschreiben läuft über `.bak`, Temp-Datei
und Rename (`desktop/src/secretsBlob.ts`, `secretsStore.ts`,
security-architecture §8a). Bewusst offen:

- **`platform-data/` im Pre-Update-Snapshot.** Der Snapshot enthält `pgdata/`
  und `<snapshot>.secrets.enc`, aber nicht den Kernel-Tresor
  `platform-data/vault.enc.json` und nicht `installed.json`. Ein Restore bringt
  Datenbank und Schlüssel zurück, nicht den Tresorstand zum Snapshot-Zeitpunkt.
- **Recovery-Key wieder einspielen.** `exportRecoveryKey` ist reine Anzeige. Es
  gibt keinen Weg, einen gesicherten Schlüssel zu importieren, etwa nach
  Verlust des Keychain-Eintrags oder beim Rechnerumzug. `.bak` und
  Snapshot-Kopie sind mit demselben Keychain-Eintrag verschlüsselt und helfen
  dort nicht.
- **Bestätigter Neuanfang mit neuen Schlüsseln.** Der Fehlerdialog bietet
  absichtlich keinen solchen Button, weil er auch bei einer bloß verweigerten
  Keychain-Abfrage erscheint. Heute ist der Neuanfang ein manueller Schritt
  (Datenordner beiseite verschieben). Ein eigener, bestätigter Weg außerhalb
  dieses Dialogs wäre die Ergänzung, sinnvollerweise zusammen mit dem Import.
- **Recovery-Key im Wizard erst nach der Ordnerwahl zeigen.** Der
  Reveal-Button liest den Schlüssel aus `userData`, bevor `complete` den
  gewählten Datenordner setzt (`ipc.ts`). Liegt dort schon eine `secrets.enc`,
  gilt deren Schlüssel und nicht der angezeigte. Die Reparatur: den Override
  zuerst anwenden oder den Schlüssel erst danach anzeigen.
- **Verwaiste `.secrets.enc`-Kopien.** Das Pruning entfernt die Kopie zusammen
  mit ihrem Snapshot-Ordner. Wer Snapshot-Ordner von Hand löscht, lässt die
  Kopie daneben liegen.

### Desktop: Passwörter für die eingebettete Postgres — offene Punkte

Die eingebettete PostgreSQL verlangt für jede Verbindung ein SCRAM-Passwort,
der Kernel verbindet sich als `omadia_kernel` ohne Superuser-Rechte
(`desktop/src/embeddedDbAuth.ts`, security-architecture §8b). Weil
`omadia_kernel` seine Datenbank besitzt, behandelt die Shell diese Datenbank
als nicht vertrauenswürdig: Jede Wartungsverbindung pinnt einen festen
`search_path` (Systemkataloge zuerst, überstimmt `ALTER DATABASE/ROLE ... SET`),
der Ownership-Transfer schema-qualifiziert seine Aufrufe (`pg_catalog.format`)
und pinnt den `search_path` zusätzlich selbst
(`desktop/src/embeddedDbOwnership.ts`). Die Verifikation lehnt die Kernel-Rolle
außerdem ab, wenn sie Mitglied irgendeiner Rolle ist.

Unter macOS und Linux lauscht der Server nur auf einem Unix-Socket in
`<userData>/pg-socket` (0700, Eigentümer geprüft; bei zu langem Pfad ein
privates Temp-Verzeichnis pro Start), ohne TCP; die `DATABASE_URL` des Kernels
nennt das Socket-Verzeichnis als Host (`desktop/src/embeddedDbEndpoint.ts`).
Die Shell verbindet sich nur per SCRAM (`desktop/src/scramOnlyConnect.ts`:
Klartext-, MD5- oder Login ohne SCRAM-Austausch wird abgelehnt, bevor ein
Passwort rausgeht). "Bereit" heißt: `postmaster.pid` nennt den gestarteten
Prozess mit Status `ready`, ohne Zugangsdaten; danach muss der erste
Superuser-Login das eigene `data_directory` melden, bevor das Kernel-Passwort
irgendwohin geht. Bewusst offen:

- **Windows: Kernel-Pools sind nicht SCRAM-only.** Windows bleibt auf
  `127.0.0.1`. Die Shell-Verbindungen sind dort geschützt, die Pools des
  Kernels (`createNeonPool`, `coreMigrations`) nutzen aber einen normalen
  pg-Client. Stirbt der Server, während der Kernel läuft, und bindet ein
  anderer lokaler Nutzer den Port vor dem nächsten Reconnect, könnte er das
  Kernel-Passwort im Klartext anfordern. Optionen: ein SCRAM-only-Client für
  die Kernel-Pools (`new Pool({ Client })`, aktiv bei `OMADIA_EMBEDDED_DB=1`),
  ein bei jedem Start neu gesetztes Kernel-Passwort, oder auch unter Windows
  ein Unix-Socket (PostgreSQL ab 13 kann AF_UNIX unter Windows 10 1803+) in
  einem Verzeichnis mit Nutzer-ACL.
- **Windows: Port-Besetzung bricht den Start ab.** Zwischen Portwahl und
  Serverstart sowie während einer Single-User-Reparatur ist der Port frei;
  ein anderer lokaler Nutzer, der ihn dann bindet, bekommt kein Passwort, lässt
  aber den Boot scheitern (der nächste Start wählt einen freien Port). Ein
  automatischer Neuversuch mit neuem Port wäre die Ergänzung.
- **Mitgliedschaft schlägt fehl statt sich zu reparieren.** Erhält
  `omadia_kernel` je eine Rollen-Mitgliedschaft (heute nur über die geschlossene
  Umleitung erreichbar, oder ein künftiges Feature, das bewusst eine vergibt),
  bricht der Start ab statt sie zu entziehen; der Rückweg ist der
  Pre-Update-Snapshot (security-architecture §8a). Ein `REVOKE` aller
  Mitgliedschaften im Provisioning wäre die selbstheilende Alternative, falls
  das je nötig wird.
- **Kernel-Passwort im Kindprozess-Environment.** Es steckt in `DATABASE_URL`
  und ist damit für Prozesse desselben OS-Nutzers lesbar (`ps eww`), dieselbe
  Grenze wie bei `VAULT_KEY`. Die Härtung wäre die Übergabe per stdin/fd.
- **Kein externer Zugriff auf die eingebettete Datenbank.** Beide Passwörter
  bleiben verschlüsselt in `secrets.enc`, und kein unterstützter Weg gibt sie
  heraus; ein lokales Werkzeug (psql, ein GUI-Client) kommt nicht mehr an die
  Daten. Wird das gebraucht, wäre ein Operator-Export des Kernel-DSN hinter
  einer Bestätigung im Hilfe-Menü die Ergänzung.
- **Migration und Laufzeit teilen sich eine Rolle.** `omadia_kernel` besitzt
  die Datenbank und führt Kern- und Plugin-Migrationen aus, beim Boot und bei
  jeder Plugin-Aktivierung. Eine reine DML-Rolle für die Laufzeit bräuchte im
  Kernel eine zweite DSN für Migrationen.
- **pgvector-Updates.** Die Extension gehört dem Superuser. Ein
  `ALTER EXTENSION vector UPDATE` nach einem Engine-Update mit neuerer
  pgvector-Version kann nur die Shell ausführen; heute führt es niemand aus.
- **Windows-Stop vor der Passwort-Reparatur.** Die Reparatur im Single-User-Modus
  braucht einen gestoppten Server; `postgres.exe` wird dafür hart beendet (wie
  jeder Stop dort), der Single-User-Lauf macht danach eine Crash-Recovery.

### Desktop-Shell: Trust-Boundary Renderer → Main

Wizard, Ladeseite, Web-UI und bei In-Window-OIDC auch IdP-Seiten laufen im
selben Fenster mit demselben Preload. Seit 2026-09-30 gilt, Begründung und
Details in [`security-architecture.md` §10i](security-architecture.md):

- **IPC:** Jeder Kanal wird in `desktop/src/ipc.ts` über
  `guardedHandle`/`guardedOn` mit genau einer Surface registriert, nie direkt
  über `ipcMain`. `desktop/src/ipcSender.ts` entscheidet pro Aufruf anhand von
  `event.senderFrame`. Setup-Kanäle antworten nur dem gebündelten
  `wizard.html` im Main-Frame (Pfadvergleich gegen die Installation), und nur
  solange der Navigator `wizard` zeigt. UI-Pings antworten nur dem Origin der
  laufenden Web-UI. `getState` ist entfernt.
- **Preload:** `desktop/src/bridgeSurface.ts` gibt der Web-UI nur
  `uiReady`/`setUiLocale`, fremden Seiten gar nichts. Plugin-iframes erreichen
  die Bridge der Web-UI über `window.parent.omadia`. Deshalb darf die
  `app`-Surface nie eine Methode bekommen, die ein Geheimnis liefert oder
  schreibt.
- **Navigation:** `desktop/src/navigationGuards.ts` hängt an jedem
  webContents und dessen Session. Fremde Links und Popups gehen in den
  Systembrowser. `file:`, `javascript:`, `data:` und `about:blank` werden
  abgelehnt. Same-App-Popups öffnen sandboxed und ohne Preload. Subframes
  dürfen Webseiten und `about:`/`data:`/`blob:` laden, sonst nichts.
  Web-Redirects bleiben bewusst offen, damit der In-Window-Login per
  OIDC/Entra funktioniert; ein Redirect auf ein anderes Schema bricht die
  Navigation ab.
- **OS-Protokoll-Handler:** Die Session verweigert Electrons
  `openExternal`-Permission, die Electron ohne Handler jeder Seite gewährt.
  Damit startet keine Seite, kein Plugin-iframe und kein Redirect ein
  Programm über ein eigenes Schema (`ms-settings:`, `search-ms:`, …). Web-Links
  öffnet die Shell selbst, geprüft, über `shell.openExternal`.

Offen:

- **Prüfung auf paketierten Builds (macOS und Windows)** vor dem nächsten
  Desktop-Release. Automatisch im Install-Smoke (`desktop-upgrade-smoke.yml`):
  der Wizard komplett (Reveal zeigt den Key, Finish bootet), keine
  `[ipc] … refused`-Zeile im Log (sonst stimmt der Pfadvergleich nicht:
  asar-Pfad, Laufwerksbuchstabe), `Object.keys(window.omadia)` in der Web-UI
  genau `uiReady` und `setUiLocale`, der Anhänge-Schalter (`/health` →
  `attachments.store: filesystem`, Boot-Zeile, Ordner 0700 auf macOS/Linux).
  Für Electron 44 belegt Lauf 36989068863 keine `[ipc]`-Zeile und die
  Anhänge-Boot-Zeile auf allen drei Plattformen. Von Hand bleiben:
  Plugin-Autor-Link, GitHub-Hilfe-Link und ein Link in einer Chat-Antwort
  öffnen im Systembrowser; ein Same-App-Popup hat kein `window.omadia`; ein
  Link mit eigenem Schema in einer Plugin-UI startet kein Programm (Log:
  `[nav] blocked a subframe navigation`); der Entra-Login-Rundlauf klappt
  inklusive Passwort-POST.
- **Abmelden einer OIDC-Sitzung:** Die IdP-End-Session-URL öffnet jetzt im
  Systembrowser, der einen eigenen Cookie-Speicher hat. Die IdP-Sitzung im
  App-Fenster bleibt also bestehen. Folgepunkt für die Web-UI: in
  `web-ui/app/_components/AuthBadge.tsx` bei vorhandener Desktop-Bridge direkt
  auf `/login` gehen statt den IdP-Hop zu versuchen.
- **Web-Redirects auf fremde Seiten** werden nicht blockiert. Das ist die
  akzeptierte Rest-Ausnahme aus §10i: Solche Seiten bekommen keine Bridge,
  jeder Handler lehnt sie ab, und auch sie erreichen keinen
  OS-Protokoll-Handler.
- **Übrige Session-Permissions: deny-by-default mit Allowlist.** Die Session
  verweigert nur `openExternal` (`canGrantPermission`/`canPassPermissionCheck`
  in `desktop/src/navigationPolicy.ts`). Jede andere Permission-Anfrage und
  -Prüfung bekommt Electrons Antwort ohne Handler: gewährt, für jeden Frame und
  ohne Rückfrage der App. Das betrifft Kamera und Mikrofon (`media`), das Lesen
  der Zwischenablage (`clipboard-read`; Wizard und Shell kopieren den
  Wiederherstellungsschlüssel dorthin), Standort und Benachrichtigungen, auch
  für Plugin-iframes, Same-App-Popups und fremde Seiten nach einem Redirect.
  Folgepunkt: Request- und Check-Handler lehnen ab, was nicht auf einer
  expliziten Allowlist steht, entschieden pro anfragendem Origin
  (`details.requestingUrl` bzw. `requestingOrigin`) und Frame
  (`details.isMainFrame`). Gebraucht wird heute nur `clipboard-sanitized-write`
  (`navigator.clipboard.writeText` im Wizard und in der Web-UI), also für die
  gebündelten Seiten und den Origin der laufenden Web-UI. Plugin-iframes laufen
  auf dem Origin der Web-UI und erben jede Freigabe für ihn, solange sie nicht
  auf den Main-Frame begrenzt ist; ob Plugin-UIs kopieren dürfen, gehört zur
  Entscheidung. Die Tests „grants every other request …“ und „answers every
  other check …“ in `desktop/test/navigationPolicy.test.mts` pinnen das heutige
  Verhalten und kehren sich mit dem Fix um.

### Desktop-Shell: Wizard-Schalter — Folgepunkte

Seit 2026-09-30 gilt [`security-architecture.md` §10j](security-architecture.md):
Ein Wizard-Schalter ändert die Kernel-Env oder existiert nicht. Übrig ist
**Anhänge** (`ATTACHMENT_STORE_DIR` → lokaler `tigrisStore`, Readiness über
`/health` → `attachments.store`, geprüft von `Supervisor.confirmCapabilities`).
Semantisches Gedächtnis und Diagramme wurden aus dem Wizard entfernt, weil die
Shell sie nicht einschalten kann. Offen:

- **Semantisches Gedächtnis als echter Opt-in.** Darf nur mit Verdrahtung
  zurück in den Wizard: Gewichte-Download aus der Shell heraus (heute nur über
  die Admin-Route `POST /api/v1/admin/embedding-provider/local-model/fetch`,
  also mit Operator-Session), danach Selbst-Reaktivierung des Adapters,
  Neubewertung des Embedding-Gates und ein Readiness-Signal auf `/health`, das
  die Shell prüft — plus ein `supervisorKernelEnv`-Test, der das pinnt.
- **Diagramme** brauchen eine Owner-Entscheidung: gehosteter Renderer (ein
  neuer Datenabfluss der Diagramm-Quellen an einen Dienst außerhalb des
  Rechners) oder ein mitgelieferter Renderer (Kroki ist JVM-basiert und lässt
  sich nicht bündeln). Selbst dann fehlt Speicher: `@omadia/diagrams` baut
  einen eigenen S3-Client und nutzt den Kernel-Store nicht.
- **Office- und Diagramm-Plugin auf den Kernel-Store umstellen.** Beide bauen
  eigene S3-Clients aus ihrer Plugin-Config; mit dem Kernel-`tigrisStore`
  liefen `create_xlsx`/`create_docx` auch auf dem Desktop.
- **Ablauf für den lokalen Store.** S3-Buckets bekommen eine 90-Tage-Lifecycle-
  Regel, `filesystemObjectStore.ts` löscht nichts.
- **Schalter nach dem Setup ändern.** Es gibt keinen Einstellungs-Pfad; heute
  nur „Setup erneut ausführen“ nach einem Boot-Fehler.
- **Readiness sichtbar machen.** Die Prüfung schreibt heute nur eine Log-Zeile
  (`[boot] attachments: …`, im Boot-Log des Wizards sichtbar). Eine Warnung
  könnte zusätzlich in Tray oder Web-UI erscheinen.
- **Wer schreibt in den Store?** Der Web-Chat hat keinen Datei-Upload. Heute
  landen dort nur Dateien von Kanälen, die über den Kernel-Store persistieren
  (Teams mit `TEAMS_ATTACHMENT_STORAGE_ENABLED=true`).
- **Manuelle Prüfung auf paketierten Builds:** Wizard zeigt einen Schalter
  plus Hinweis; `setup.json` enthält `capabilities: { attachments }`; das Log
  zeigt `[boot] attachments: on, kept in the data folder on this computer`;
  `GET http://127.0.0.1:8769/health` liefert `attachments.store: filesystem`;
  `<Datenordner>/attachments` existiert mit 0700.

### Formeln in `create_xlsx` server-seitig auswerten (Option A, zurückgestellt)

Seit `@omadia/plugin-office` 0.1.4 schreibt `create_xlsx` Formeln ohne
gecachten Wert und setzt `fullCalcOnLoad`. Die Zahlen rechnet die Anwendung,
die die Datei öffnet (`security-architecture.md` §5a). Vorschauen ohne
Rechenwerk (Quick Look, Teams/Outlook, Excels Protected View) zeigen
Formelzellen deshalb leer, und ein ungespeichert hochgeladener Export landet
mit leeren Formelzellen im Dataset-Import. Option A wäre eine echte
server-seitige Auswertung, die den `<v>`-Wert selbst schreibt. Aufwand L,
bewusst zurückgestellt:

- **Engine nur MIT-lizenziert.** Geprüft (Stand 2026-09): `fast-formula-parser`
  (Sheet-Referenzen über `onCell`/`onRange`, rund 280 Funktionen, seit 2021
  ohne Pflege), `xlsx-calc` (braucht ein SheetJS-Workbook, Teilmenge der
  Funktionen), `@formulajs/formulajs` (nur Funktionen, kein Parser).
  `hot-formula-parser` kennt keine Sheets und scheidet für die
  Cross-Sheet-Pivots aus. **HyperFormula ist GPL/kommerziell und kommt nicht
  in Frage.**
- **Adapter exceljs → Engine**: Spaltenbuchstaben, Datums-Serials,
  `{row}`-Vorlagen und eine Regel für nicht unterstützte Funktionen (dann
  keinen `<v>` schreiben, sondern wie heute die Anwendung rechnen lassen).
- **Semantik-Treue**: Jede Abweichung zwischen Engine und Excel schriebe einen
  falschen `<v>` unter omadias Namen, also genau den Fehler, den 0.1.4
  beseitigt hat. Ohne Differenztests gegen echtes Excel nicht ausrollen.
- **Formel-Policy bleibt**: `formulaPolicy.ts` (nur Excels eigene Funktionen
  aus `formulaFunctions.ts`; kein `WEBSERVICE`, `IMPORTTEXT`/`IMPORTCSV`,
  `HYPERLINK`, DDE, keine Verweise auf andere Dateien) gilt unabhängig davon,
  wer rechnet.

**Funktionskatalog pflegen.** `formulaFunctions.ts` ist Microsofts Liste
„Excel functions (alphabetical)“ vom 2026-09-30, wörtlich übernommen. Was
Excel danach dazubekommt, lehnt `create_xlsx` ab, bis es jemand aufnimmt
(Fail-closed, so fielen `IMPORTTEXT`/`IMPORTCSV` auf). Vor dem Aufnehmen
prüfen, ob die Funktion nur über Zellen der Arbeitsmappe rechnet; greift sie
auf Netz, Dateien, Dienste oder andere Programme zu, gehört sie stattdessen
nach `EXTERNAL_FUNCTIONS`. Offen: Nackte, nicht aufgerufene Namen (LET-Namen
oder eine Funktion als Wert ohne `_xleta.`) prüft die Policy nur gegen die
Sperrliste. Sie ganz zu schließen bräuchte einen echten Formel-Parser mit
LET/LAMBDA-Gültigkeitsbereichen. Damit ließen sich auch Aufrufe über LET-Namen
(`f(A1)`) wieder erlauben, die heute abgelehnt werden.

**exceljs-Upgrade: Zeichenliste nachziehen.** `formulaText.ts` lehnt genau die
Zeichen ab, die exceljs 4.4 beim Schreiben verwirft (`utils.xmlEncode`:
C0-Steuerzeichen außer Tab/LF/CR, dazu DEL) oder die XML nicht trägt. Ändert
ein exceljs-Update den Encoder, muss die Liste mitziehen, sonst prüft die
Policy wieder einen anderen Text, als in der Datei landet. Der Test „stores
every formula it accepts exactly as it was checked“ in
`office-formulas.test.ts` fällt dann auf, aber nur für die Zeichen, die er
durchprobiert (alle C0-Zeichen, DEL, U+0085, ein Surrogat, U+FFFE).
Ebenso die Wert-Erkennung (`Value.getType` in `lib/doc/cell.js`): exceljs
liest jedes Objekt nach seiner Form (`formula`/`sharedFormula` → Formel samt
`result` als Cache, `{ text, hyperlink }` → Link), deshalb reicht
`renderXlsx` nur Text, Zahlen, Booleans, `null`, selbst erzeugte Dates und
neu gebaute `{ formula }` durch (`cellValueOf`, Header nur als Text). Liest
ein Update einen dieser Werte anders, etwa Text mit führendem `=` als Formel,
umgeht er die Policy. `office-cell-values.test.ts` prüft die abgelehnten
Objektformen und dass solcher Text Text bleibt.

### Answer-Verifier: offene Punkte nach den evidenzgebundenen Verdicts (2026-09-30)

- **Connector-Chip für `skipped` / `unavailable` — Produktentscheidung.** Teams
  und Telegram bekommen für diese Turns bewusst **kein** Badge; der Wire-Typ
  `SemanticAnswer.verifier` blieb unverändert, damit die Connector-Repos kein
  Release brauchen. Ein expliziter „nicht geprüft"- / „Prüfung nicht
  verfügbar"-Chip hieße: Union in `outgoing.ts` erweitern, `teamsCard.ts`
  (`verifierChip`) nachziehen, beide Connector-Repos releasen — und ein
  neutrales Badge auf jedem Small-Talk-Turn. Der Web-Chat zeigt beide Zustände
  bereits (`VerifierBadge`).
- **`CHECK`-Constraint auf `verifier_verdicts.status`.** Das Vokabular ist
  jetzt geschlossen (`approved`, `approved_with_disclaimer`, `blocked`,
  `skipped`, `unavailable`); eine Migration in der KG-neon-Serie könnte es
  festschreiben. Heute freie `TEXT`-Spalte ohne Leser im Repo.
- **Golden-Eval einmal beaufsichtigt laufen lassen.** `skipped.jsonl` (vorher
  `approve.jsonl`) erwartet jetzt `skipped`. Ein Sample, dessen Extraktion leer
  bleibt, landet nun in `skipped` statt still in `approved`; extrahiert das
  Modell neben einem geprüften Claim einen, den kein Checker nimmt, oder einen,
  der nicht wörtlich in der Antwort steht (Umschreibung, hineingezogenes
  Subjekt — `claims_not_in_answer`), landet ein `approved`-Eintrag jetzt in
  `approved_with_disclaimer`; eine am Token-Limit abgeschnittene oder
  schemawidrige Extraktion in `unavailable` — ein erster roter Lauf von
  `npm run eval:golden` ist zu untersuchen, nicht wegzuwinken.
- **Nicht gelistete Claims bleiben unsichtbar.** Der Verifier prüft, was das
  Extraktionsmodell auflistet. Lässt es unter dem Anfrage-Limit einen Claim
  weg, hinterlässt das keine Spur; `approved` heißt deshalb „keine bekannte
  Lücke", nicht „die Antwort enthält sonst nichts" (so auch in
  `docs/security-architecture.md` §7c). Denkbar: die starken Signale des
  Trigger-Routers (Beträge, Daten, Referenzen) deterministisch gegen die
  extrahierten Claims abgleichen und ein Signal ohne Claim als Lücke melden,
  oder ein Pflichtfeld im `record_claims`-Schema, in dem das Modell
  Vollständigkeit bestätigt. Heute beobachtet nur die Golden-Eval, ob das
  Modell die entscheidenden Claims findet.
- **Verifier-Aufzählung in der README-Feature-Tabelle.** Die Zeile
  „Answer verification" nennt nur `approved` / `approved_with_disclaimer` und
  „each answer"; beim nächsten Abgleich der README-Aussagen mit dem erzwungenen
  Verhalten auf `skipped` / `unavailable` erweitern — und sagen, dass nur
  `enforce` blockiert (auch im Stream), `shadow` nur beobachtet, und dass der
  Abo-CLI-Runtime und Routinen nicht verifiziert werden.
- **Verdict-Zustand im Server-Mirror — erledigt.** Der Chat-Mirror
  (`MessageSchema`, `routes/chatSessions.ts`) behält `Message.verifier` (ein
  Summary, das nicht ins Schema passt, fällt einzeln weg) und
  `verifierBlocked`.
- **Abdeckung nur im Log, nicht in `verifier_verdicts`.** Die Tabelle hat keine
  Spalte für nicht geprüfte (`not_checked`) oder gescheiterte
  (`check_failed`) Claims; beide zählen dort in `unverified_count`. Eine
  Kalibrierungs-Abfrage trennt „nicht geprüft" und „Check gescheitert" von
  „geprüft, nicht bestätigt" heute nur über die Logzeilen
  (`[verifier/pipeline] … not checked`, `[verifier/deterministic] FAIL`,
  `[verifier/judge] API FAIL`). Eine Migration mit eigenen Zählern wäre der
  saubere Weg; der Stream (`uncheckedCount`) hat die Zahl bereits.
- **Konfigurationslücken zählen als „geprüft, nicht bestätigt".** Ein Claim,
  den der `DeterministicChecker` mangels Odoo-/Graph-Reader oder bekanntem
  Feld nicht prüfen kann („no odoo reader configured", „no amount field for
  …"), trägt keine `cause`. Das Badge bleibt ehrlich (ohne bestätigten Claim
  `unverified`, nie grün), der Tooltip sagt aber „geprüft, keine bestätigt"
  statt „nicht geprüft", und neben einem bestätigten Claim stößt so ein Claim
  den Borderline-Resample an. Offen: solche Fälle als `not_checked` markieren.
- **Schemawidriger Eintrag kippt die ganze Extraktion.** Ein `record_claims`-
  Eintrag ohne Text, mit unbekanntem Typ oder unbekannter Quelle macht die
  Extraktion zu `unavailable`, auch wenn die übrigen Einträge lesbar wären —
  konservativ, weil sich ein unlesbarer Eintrag nicht als Claim im Verdict
  halten lässt. Häufen sich im Shadow-Betrieb die Logzeilen „… entries do not
  match the schema", die lesbaren Einträge prüfen und die unlesbaren als
  Abdeckungslücke zählen.
- **Resample bei gescheitertem Check neben bestätigtem Claim.** Ein Verdict mit
  einem bestätigten und einem `check_failed`-Claim gilt weiter als
  Borderline und kauft einen zweiten Orchestrator-Turn (#132), weil ein
  transienter Fehler beim zweiten Sample verschwinden kann. Seit dem
  Replay-Ledger führt ein Resample kein Tool erneut aus; bleibt die Abwägung
  gegen die Kosten des zweiten Turns.
- **Lange Antworten fensterweise extrahieren.** Der `ClaimExtractor` liest nur
  die ersten 6000 Zeichen (`EXTRACTION_WINDOW_CHARS`); jede längere Antwort
  trägt deshalb eine `coverage_gap` und ist höchstens `partial`, auch wenn
  jeder Claim im gelesenen Teil stimmt. ERP-Listen überschreiten das leicht.
  Fensterweise Extraktion (überlappende Fenster, Dubletten zusammenführen, ein
  LLM-Call je Fenster, bis die Claim-Liste voll ist) würde sie voll prüfbar
  machen; die Lücke bliebe nur für Text jenseits des letzten Fensters.
- **Verbatim-Guard und Markdown.** Der Guard (`verbatimSpan.ts`) toleriert
  Groß-/Kleinschreibung und Whitespace, aber keine Auszeichnung: zitiert das
  Modell „Die Gutschrift beträgt 2.000,00 €" aus einer Antwort mit
  `**2.000,00 €**`, ist das die Lücke `claims_not_in_answer` und die Antwort
  höchstens `partial` — ehrlich, aber womöglich häufig. Im Shadow-Betrieb die
  Logzeilen `[claim-extractor] … not_in_answer=` beobachten; ist Markdown die
  Hauptursache, Emphasis-Zeichen (`*`, `_`, Backtick) zwischen den Wörtern
  gezielt überspringen, statt den Guard allgemein zu lockern.
- **Token-Budget der Extraktion an das Claim-Limit koppeln.** Der
  `record_claims`-Call hat `maxTokens: 1024`. Eine Liste nahe am Limit
  (`VERIFIER_MAX_CLAIMS + 1` Einträge) kann daran abreißen und endet dann als
  `unavailable` (`extractor_error`) statt als `partial` — ehrlich, aber
  ungenauer als nötig. Budget aus `maxClaims` ableiten oder kompaktere
  Einträge anfordern.
- **Claim-Wert nicht an den Claim-Text gebunden (älteres Limit).** Der
  `DeterministicChecker` vergleicht bei Beträgen und Summen den vom Modell
  gelieferten `claim.value` mit dem Odoo-Feld (`checkOdooAmount` ab
  `deterministicChecker.ts:194`, `checkOdooAggregate` ab :234; bei Daten
  `claim.value ?? claim.text`, :278), nie den Wert, den der zitierte Text
  nennt. Der Text ist dank Verbatim-Guard ein Stück der Antwort, der Wert
  aber die eigene Lesart des Modells: liest es „1.234,56 €" als 1000 und hält
  der Beleg 1000, ist der Claim `verified`, obwohl die Antwort etwas anderes
  sagt; umgekehrt kann ein Lesefehler einen richtigen Claim widerlegen.
  Zudem kürzt der Extractor einen String-Wert auf 200 Zeichen. Offen: Betrag
  und Datum deterministisch aus dem zitierten Text lesen und bei Abweichung
  vom Modellwert `not_checked` melden, statt dem Modellwert zu folgen.
- **Judge-Antwort wird großzügig gelesen (älteres Limit).** `parseVerdict`
  (`evidenceJudge.ts`) liest nur den ersten `record_verdict`-Call; ein
  zweiter mit anderem Urteil wird ignoriert. Eine am Token-Limit
  abgeschnittene Judge-Antwort (`finishReason: 'max_tokens'`) wird nicht
  verworfen, anders als beim Extractor. Erledigt ist die Zitatprüfung: die
  zitierte `evidence_node_id` muss eine Kennung sein, die der Request
  gedruckt hat (Security §7c). Offen: alle Calls lesen (widersprüchliche
  Urteile → `check_failed`) und eine abgeschnittene Antwort als
  `check_failed` werten.
- **Überlange Claims beobachten.** Ein Claim über `MAX_CLAIM_CHARS` (300
  Zeichen) wird nicht mehr gekürzt geprüft, sondern ist die Lücke
  `claims_too_long` — die Antwort ist dann höchstens `partial`. Das
  Tool-Schema verlangt 1-200 Zeichen, erzwungen wird es im Prompt nicht. Im
  Shadow-Betrieb die Logzeilen `[claim-extractor] … too_long=` beobachten;
  sind sie häufig, das Modell im System-Prompt ausdrücklich lange Aussagen in
  mehrere Claims teilen lassen, statt die Grenze anzuheben.
- **`verifierService.ts` über der 500-Zeilen-Grenze — erledigt.** Die reinen
  Helfer liegen jetzt in eigenen Modulen: Summary, Badge und Merge
  (`summarise`, `badgeFor`, `mergeBadges`, `mergeBorderlineVerdicts`,
  `withVerifier`) in `verifierVerdicts.ts`, die Trace-Extraktion
  (`extractToolsCalled` u. a.) in `verifierTraceEvidence.ts`.
  `verifierService.ts` exportiert `badgeFor`, `mergeBadges` und
  `mergeBorderlineVerdicts` weiter, weil Tests sie von dort importieren.

### Answer-Verifier: offene Punkte zum `enforce`-Gate (2026-10-01)

- **Correction-Retry im Stream — erledigt** (Replay-Ledger, §3), außer bei
  Canvas-Turns (Punkt „Canvas-Turns ohne Stream-Retry“ oben).
- **Zurückgehaltene Antwort wird trotzdem persistiert.** Der Orchestrator
  schreibt Session-Log, KG-Turn und ggf. die Auto-Promotion vor `done`; die
  zurückgehaltene Antwort landet so im Kontext späterer Turns, und ihre
  `autoPromotedMkId` wird nicht ausgeliefert (der Web-Chat bietet kein
  Verwerfen an). Mit Request-Ledger (Retry oder Resample möglich) ist die
  Persistenz schon bis nach dem Urteil zurückgestellt (Commit-on-Delivery,
  §3); dort nach dem #1094-Muster einen Marker statt der Antwort committen
  und die Promotion auslassen. Ohne Ledger (`VERIFIER_MAX_RETRIES=0` ohne
  Resample, Canvas-Stream) schreibt der Turn weiterhin vor dem Urteil.
- **Zurückgehaltener Turn zeigt nicht, welche Tools liefen.** Tool-Trace und
  Tool-Ergebnisse fallen mit der Antwort weg; der Web-Chat zeigt nur die
  Anzahl (`tools=N`). Hat ein Schreib-Tool committet, sollte die Notiz es nennen
  wie die Turn-Incomplete-Notiz (#1094) — `done.runTrace` trägt die Namen.
- **Keepalive für Public-API- und Canvas-Stream.** Bis zum Urteil gehen nur
  Lebenszeichen raus; `heartbeat` erzeugt nur die Kernel-Route. Ein Turn ohne
  Tool-Calls ist auf dem API-Key-Stream bis zum Urteil still — Integratoren mit
  kurzen Lese-Timeouts brechen ab. Ein Wrapper-Heartbeat während des Haltens
  wäre die Lösung (die README nennt das Verhalten).
- **Canvas: erster Paint erst nach dem Urteil.** In `enforce` hält der
  Composer das Skeleton bis zum Urteil (es ist Modell-Output); der Canvas
  bleibt bis dahin leer. Ein Platzhalter ohne Modelltext (etwa das
  deterministische Fallback-Skeleton) könnte live rausgehen, braucht aber
  eine eigene Revisionsfolge (Modell-Skeleton als Revision 1, Patches darauf)
  und einen lokalisierten „zurückgehalten“-Status für einen zurückgehaltenen
  Turn.
- **Mitausgelieferte Inhalte ungeprüft.** Das Urteil gilt `done.answer`;
  Tool-Output, Sub-Agent-Antworten, Surfaces und der Skeleton-Text gehen mit
  einem freigegebenen Turn raus, ohne selbst geprüft zu sein. Erfindet der
  Composer Zahlen im Skeleton, wäre ein Skeleton ohne Freitext in `enforce`
  (oder eine Prüfung seines Texts) der nächste Schritt.
- **Nachgestelltes `NO_REPLY` in Teams/Telegram.** Eine Antwort, die nur mit
  `NO_REPLY` endet, wird in `enforce` geprüft; hält der Verifier sie zurück,
  postet der Channel die Notiz statt zu schweigen. Falls das stört: die Form
  vor dem Verifier auf das strikte `NO_REPLY` normalisieren (Prosa verwerfen)
  — Produktentscheidung.
- **`onVerifierBlocked` nur bei Widerspruch.** Der Plan-Hook feuert für
  `blocked`; eine fail-closed zurückgehaltene Antwort (`partial`,
  `unavailable`) erscheint im Plan nicht als abgelehnt.
- **Fail-closed hält lange Antworten immer zurück.** Eine Antwort über 6000
  Zeichen ist nie `approved` (Abdeckungslücke) und wird in `enforce` stets
  zurückgehalten, ebenso jede mit einem Claim, den kein Checker nimmt. Die
  fensterweise Extraktion (Punkt oben) ist damit Voraussetzung für `enforce`
  bei ERP-Listen.
- **Borderline-Resample in `enforce chat()`.** Ein Borderline-Verdict ist
  `approved_with_disclaimer` und wird zurückgehalten; der bezahlte Resample
  ändert daran nur etwas, wenn er auf `blocked` eskaliert und der Retry dann
  korrigiert. Kosten gegen Nutzen neu abwägen. Seit dem Replay-Ledger führt er
  kein Tool mehr erneut aus, und `verifier_resample_on_borderline=false`
  schaltet ihn ab.
- **Abo-CLI-Runtime und Routinen ohne Verifier.** `VERIFIER_MODE` wirkt weder
  auf `claude-cli`-Agenten (der `CliChatAgent` wird vor dem Wrapper
  zurückgegeben) noch auf Routinen (`runTurn` auf dem rohen Orchestrator).
- **Connector-Badge auf der Notiz.** Teams/Telegram zeigen an einer
  zurückgehaltenen Antwort das Badge ihres Verdicts (`failed`, `partial`) neben
  der Notiz. Produktentscheidung, ob es dort entfallen soll.
- **Karten-Ausnahme lässt Faktenantworten ungeprüft durch.**
  `releasesWithoutVerification` gibt jeden Turn mit `pendingUserChoice`,
  `pendingMcpInput`, `pendingSlotCard` oder `pendingOAuthConsent` ohne Urteil
  frei — auch die vollständige Antwort, an der ein Slot-Picker, ein
  Consent-Prompt (turnweit) oder eine Card-Router-Auswahlkarte hängt, samt
  Tool-Output, Surfaces und Canvas-Skeleton, ohne Badge. Die Ausnahme greift
  vor dem Privacy-Gate (`verifierGate`, in `VerifierService.chat` wie in
  `enforcedVerifiedStream`), also geht an einem solchen Turn auch eine von
  Privacy Shield gerenderte Antwort ungeprüft raus. Engere Regel zur
  Entscheidung: den Antworttext solcher Turns prüfen und die Karte nur
  mitliefern, wenn das Urteil die Antwort freigibt — oder nur Turns
  ausnehmen, die nichts als die Karte sind; eine gerenderte Antwort dabei
  zurückhalten wie ohne Karte. Die vier Ausnahmen sind derzeit
  so gesetzt; Security §7c beschreibt die Lücke.
- **`enforce` mit Privacy Shield v4 liefert eine gerenderte Antwort nur an
  einem Turn mit Input-Karte.** Eine gerenderte Antwort geht nie an den
  Verifier und wird zurückgehalten (`unavailable` / `privacy_shield`) — auch
  ein gerenderter Tool-Fehler oder Anmelde-Prompt (`answerIsError`); trägt der
  Turn eine Input-Karte, gibt die Karten-Ausnahme (Punkt oben) ihn vorher
  ungeprüft frei. Damit `enforce` sie freigeben kann, müsste
  der Verifier die Antwort über die Privacy-Sicht des Turns prüfen (Prosa und
  Spaltenlabels maskiert, Werte über Handles statt Klartext).
- **Zusammenführen mit der Privacy-Bindung der Verifier-Requests — erledigt.**
  `verifierGate` entscheidet für beide Modi und jeden Lauf: „nicht prüfen“
  wird in `enforce` zu `unavailable` / `privacy_shield` (zurückgehalten), nie
  zu einer Auslieferung ohne Urteil, und in `shadow` zu keinem Verdict;
  `mayVerifyAnswer` entfällt, `shadow` schickt keine gerenderte Antwort mehr
  an den Extraktor. Datenschutz-Absage und Screening-Quarantäne gehen in
  `enforce` als Server-Notizen ohne Urteil raus.

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

Platzhalter unten: `<middleware-app>`, `<kroki-app>`, `<kroki-mermaid-app>` sind die
Fly-App-Namen der eigenen Installation, `<your-omadia-host>` deren öffentlicher
Host — vor dem Ausführen durch die echten Werte ersetzen.

1. Zwei Fly-Apps `<kroki-app>` + `<kroki-mermaid-app>` mit flycast-only Services (keine öffentlichen IPs). Dockerfile/fly-toml vorbereiten, z.B. unter `kroki/`.
2. Tigris-Bucket über `fly storage create -a <middleware-app>`, dann einmalig `PutBucketLifecycleConfigurationCommand` mit 90-Tage-Expiration.
3. Fly-Secrets setzen: `DIAGRAM_URL_SECRET`, `KROKI_BASE_URL=http://<kroki-app>.flycast:8000`, `DIAGRAM_PUBLIC_BASE_URL=https://<your-omadia-host>`.
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

### Phase 14 — Admin-UI für Dataset-Upload/Schema/Delete (#430 Follow-up) — **erledigt (#532)**

Der #430-Scope (CSV-Import + `query_dataset`-Tool, siehe §3 und §7) deckte
absichtlich **keine** Admin-UI ab — Upload/Schema-Browse/Delete blieb
API-only (`POST/GET/DELETE /api/v1/datasets*`, siehe §3). #430's eigene
Triage-Acceptance-Criteria verlangen aber genau diese UI; das
Folge-Issue #532 hat sie nachgezogen.

Geliefert, überwiegend `web-ui`-seitig; an der REST-Surface aus §3 gab es
EINE additive Änderung: `GET /api/v1/datasets` paginiert jetzt
(`limit`/`offset`, Response `{ items, totalMatched }`, getragen von
`listDatasets.offset` + optionalem `countDatasets` im plugin-api-Interface,
Minor-Bump auf 1.7.0) — ohne sie waren Datasets jenseits des 50er-Caps im
Admin-UI unsichtbar UND unlöschbar:

- `web-ui/app/admin/datasets/page.tsx` — Upload (Datei + optionaler Name),
  Liste, aufklappbares Detail mit Schema-Tabelle und Zeilen-Vorschau,
  Delete mit Bestätigung.
- Der Client (`web-ui/app/_lib/api.ts`) spiegelt `DatasetSummary` /
  `DatasetColumnSchema` / den unaggregierten Zweig von
  `DatasetQueryResult`, weil `web-ui` nicht gegen den
  middleware-Workspace baut.
- Die Zeilen-Vorschau paginiert **server-seitig** über `limit`/`offset`
  (25 pro Seite, Server clamped auf [1, 200]). Ein Datensatz fasst bis zu
  `MAX_DATASET_ROWS` (50 000) Zeilen — genau der Fall, gegen den
  `queryDatasetRows` existiert.
- Nach einem Import werden `privacyScan.scannedCells` /
  `maskedCells` und eine etwaige Zell-Truncation angezeigt: der Scan läuft
  auf diesem Pfad genauso wie beim Chat-Attachment-Auto-Ingest, und das
  soll sichtbar sein statt geglaubt werden zu müssen.
- ACL unverändert owner-only: die Seite zeigt ausschließlich Datensätze
  des eingeloggten Kontos, nicht die der Instanz.

### Offen — Was `agents.privacy_profile = 'strict'` bedeuten soll (#978-Follow-up)

Stand #978: Die Spalte ist **reserviert, nicht wirksam**. Sie wird
persistiert, von der Operator-API gemeldet und im UI angezeigt, aber kein
Runtime-Pfad liest sie. `AgentRuntimeConfig` hat kein Posture-Feld, und nichts
verzweigt auf `'strict'`. Eine Änderung ist seit #978 ein Metadaten-`update` in
`applyDiff.ts` und kein `rebuild` mehr. Die Migration `0061` schreibt den
Status als Kommentar an die Spalte. Im UI gibt es keinen Toggle mehr, der Wert
steht mit „(nicht wirksam)“ in der Zusammenfassung.

Bevor `strict` etwas erzwingt, muss eine Produktentscheidung fallen. Die
Optionen aus dem Issue:

- **Privacy Guard erzwingen**, unabhängig von der installationsweiten
  Einstellung. Heute ist `deps.privacyGuard` ein spät gebundener
  `privacy.redact@1`-Lookup und plattformweit.
- **Strengere Intern-Policy** (`packages/harness-orchestrator/src/privacyInternPolicy.ts`),
  heute ebenfalls plattformweit.
- **Engerer Memory-Scope** für das Agent.

Randbedingungen für jede Variante:

- Sub-Agent-Aufrufe reichen das Handle über `turnContext.privacyHandle` weiter
  (`localSubAgent.ts`, `toolDispatchService.ts`). Eine Posture pro Agent muss
  diese Grenze überleben, sonst gilt `strict` nur für den äußersten Turn.
- Der Onboarding-Seed legt den Fallback-Agent mit `'strict'` an
  (`registry/onboarding.ts`). Sobald `strict` etwas erzwingt, ist Masking für
  den produktiven Fallback-Agent **ohne Operator-Aktion** an. Das braucht
  entweder einen Daten-Backfill oder eine bewusste Release-Notiz.
- Wird `strict` wirksam, muss `privacy_profile` in `runtimeChangeReasons`
  zurück (sonst greift die Änderung erst nach dem nächsten Neustart), und die
  UI bekommt ihren Toggle wieder.

### Pairing: `auth.mode: 'none'` bei leerer Provider-Liste (#293 follow-up)

`PairingAuth` (`middleware/src/pairing/discovery.ts`) definiert `none` als
„Host nimmt unauthentifizierte Verbindungen an". Das trifft auf keinen Host zu:
der Canvas-WebSocket authentifiziert jedes Upgrade (security-architecture §10d).
Trotzdem melden der Middleware-Deskriptor (`buildPairingDescriptor`), die
mDNS-Ankündigung und `web-ui/app/pairing-discovery/route.ts` `none`, sobald die
Provider-Liste leer ist — die Middleware auch ohne Postgres, wo `/api/v1/auth/*`
mit 503 antwortet. Die web-ui-Route tut das seit dem 503-Fix nur noch für eine
tatsächlich leer gelieferte Liste; eine unlesbare beantwortet sie mit 503. Kein
Auth-Bypass, aber der Client versucht es ohne Login und scheitert am 401.
Offen: mit dem Canvas-Client festlegen, wie „kein Login möglich" gemeldet wird,
und dann alle drei Erzeuger gemeinsam umstellen, damit jeder Weg dieselbe
Antwort gibt.

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
`<middleware-app>` existiert in Prod und läuft mit leicht anderer
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

## Channel-Directory: aufgelöste Namen + Mitglieder (2026-08-24)

Der Channel-Directory-Contract (`@omadia/channel-sdk` 0.2.0,
`ChannelKeyEntry`) trägt zwei optionale Felder: `members` (gecappte
Display-Namen, vom Channel-Plugin aufgelöst — Teams macht das via
Microsoft Graph) und `memberCount` (ungecappte Gesamtzahl). Der Kernel
reicht beide durch `ChannelDirectoryRegistry.listAll()` →
`GET /api/v1/operator/channels` (`members` / `member_count`) und cappt
dabei hart (max. 16 Namen à 120 Zeichen, negative Counts verworfen) —
Plugins sind untrusted. Das Channels-Dashboard (web-ui, auch eingebettet
in `/operator/agents`) rendert daraus eine "Mitglieder: …"-Zeile
(i18n-Keys `operatorChannels.membersLine` / `membersMore`).

Die eigentliche Graph-Auflösung (Group-Chat-Topic, Chat-/Team-Members,
Org-Name für den Catch-all) lebt im Plugin-Repo
`byte5ai/omadia-channel-teams` (`teamsGraphResolver.ts`) — nie awaited
im Render-Pfad, stale-while-revalidate ab `observe()`, degradiert ohne
Graph-App-Permissions lautlos auf die Bot-Framework-Labels. Benötigte
Application-Permissions (Admin-Consent im Tenant): `Chat.Read.All`,
`ChatMember.Read.All`, `TeamMember.Read.All`, `Organization.Read.All`.


## Agent Factory: Teams-Identity-Provisioning (W1a, 2026-08-26)

Epic #860, Wave W1a. Ein Agent bekommt per Operator-API eine eigene Microsoft-Teams-
Identität — Entra-App-Registration → Azure Bot → Teams-App-Package → Tenant-Katalog →
Team-Install — ohne dass die Middleware selbst je Graph/ARM spricht.

**Architektur (ein Choke-Point, ein Writer, eine State-Quelle):**

| Baustein | Datei | Rolle |
|---|---|---|
| Migration | `middleware/migrations/0049_agent_teams_identities.sql` | 1 Identity/Agent (PK `agent_id`), global unique `bot_slug`, State-CHECK (7 Werte), Evidence-Spalten, `team_id` als Resume-Ziel. KEINE Secret-Spalte. |
| Store | `middleware/src/platform/agentTeamsIdentityStore.ts` | Einziger Writer von `state`/`last_error`; exportiert DIE State-Union (`TEAMS_PROVISIONING_STATES`), die Runner+Router importieren. Query-Fehler surfacen (kein stilles `pending`). |
| Accessor | `middleware/src/platform/teamsProvisionerService.ts` | Einzige `serviceRegistry.get('teamsProvisioner')`-Stelle (KERNEL_SERVICE_CALLER), gespiegelter Connector-Contract v0.3.1 (inkl. `getCatalogApp`), Duck-typed Error-Guards, Secret-Stripping, SingleTenant-Guard, `buildTeamsBotMessagingEndpoint()` → `https://<base>/api/teams/<botSlug>/messages`. |
| Job-Runner | `middleware/src/services/teamsProvisioningJob.ts` | Async in-process, idempotenter Resume ab persistiertem State, bounded Retries (Throttle-Hint ≤ `maxRetryDelayMs`), ConsentMissing→`failed`+Scopes, ArmNotConfigured→bleibt `app_registered`+actionable `last_error`; Team-Konflikt-Enqueue wird `rejected`, nie fremdes Ergebnis. `asBackgroundJob()` (Registry-Lifecycle, start() re-armt nach stop()). |
| Package-Assets | `middleware/src/services/teamsAppPackageAssets.ts` | Liest `appPackage/{manifest.json.template,color.png,outline.png}` aus dem installierten channel-teams-Package, füllt Platzhalter template-getrieben, deterministische Teams-App-GUID pro Agent (Katalog-Idempotenz). |
| Endpoints | `middleware/src/routes/operatorAgents.ts` | `POST/GET /api/v1/operator/agents/:slug/teams-identity` — 202-async, `{ ok: true }`-Envelope, camelCase `teams_bot`-Projektion (paste-ready für `teams_bots[]`), 503/404/400/409-Reihenfolge korrekt, ehrliches `running`, Enqueue-Fehler landen in `last_error`. |
| Boot-Wiring | `middleware/src/index.ts` (nach graphPool-Resolution) | Registriert `agentTeamsIdentityStore` + `teamsProvisioningJobRunner`, bindet `TEAMS_PUBLIC_BASE_URL ?? PUBLIC_BASE_URL` in den URL-Builder, `backgroundJobRegistry`, Resume offener Jobs (`listResumable`, nur mit `team_id`, `failed` bleibt geparkt). |

**Secret-Custody:** Das Bot-Passwort verlässt den M365-Connector NIE — dessen Vault hält
es unter `teams_bot_password:<appId>`; die Status-Projektion leitet den Ref
deterministisch aus `app_id` ab (nichts wird gespeichert, nichts geloggt).

**Deploy-Voraussetzungen:** Connector-Plugin `@omadia/integration-microsoft365` ≥ 0.3.1
(publiziert `teamsProvisioner@1`), channel-teams-Package mit `appPackage/` (W0a) für den
Package-Schritt, Postgres (`DATABASE_URL`). Fehlt der Connector: Jobs bleiben
retryable-pending, POST antwortet 503 `teams_provisioner_unavailable`.

**Out of scope / Follow-ups:** Automatischer Sync der fertigen Identity in die
channel-teams-Plugin-Config (`teams_bots[]`) ist dokumentierter Follow-up; Extraktion der
Teams-Identity-Routen aus `operatorAgents.ts` (Datei > 800 Zeilen) bei nächster Gelegenheit.

**Tests:** `test/teamsProvisioningJob.test.ts` (24), `test/teamsProvisionerService.test.ts`
(22), `test/operatorAgentsRouter.test.ts` (42), `test/agentTeamsIdentityStore.pg.test.ts`
(9, gegen echtes Postgres, wendet Migration 0049 doppelt an), `coreMigrations.pg.test.ts`
(Double-Apply aller 49 Files).

## Chat-Kontext-Memory-ACL (W5, #860 / #870, 2026-08-27)

**Das Problem.** Agent-Memory war pro AGENT isoliert (`ScopedMemoryStore` über
`['core', 'orchestrator:<slug>:*']`), nicht pro CHAT-KONTEXT. Was ein Agent in Teams-Team A
lernte, landete im agent-globalen Baum und war im nächsten Turn in Team B zitierbar. W5
partitioniert diesen Baum nach Chat-Kontext.

### Scope-Grammatik

`ScopedMemoryStore` versteht drei neue Tokens plus einen Modifier. Physische Wurzeln kommen
ausschliesslich aus `contextTierRoot(agentSlug, axis, ctxKey)` — eine zweite Schreibweise
wäre eine Partition, die der kompilierte Scope nicht gewährt:

| Token | matcht |
|---|---|
| `team:<ctxKey>:*` | `/memories/contexts/<slug>/team/<ctxKey>/…` |
| `channel:<ctxKey>:*` | `/memories/contexts/<slug>/channel/<ctxKey>/…` |
| `user:<ctxKey>:*` | `/memories/contexts/<slug>/user/<ctxKey>/…` |
| `ro:<pattern>` | Access-Modifier: read/list/exists ja, write/delete/rename → `MemoryScopeViolation` |

`/memories/contexts/` ist ein **neues Top-Level-Segment**, nicht ein Unterbaum von
`/memories/orchestrators/`. Das ist das strukturelle Kollisionsfreiheits-Argument:
`orchestrator:<slug>:*` matcht ausschliesslich den Agent-Baum, also erreicht kein Alt-Scope
einen Kontextbaum und kein Kontext-Scope den Agent-Baum. **Nicht "aufräumen".**

`ro:` ist ein **Veto**, kein schwaches Grant: matcht ein `ro:`-Pattern den Pfad, wird der
Write abgelehnt, auch wenn ein zweites Pattern ihn gewähren würde. Sonst re-öffnet jedes
überlappende Pattern still das Tier, das `ro:` quarantänisieren soll.

`/memories/core/audit/` ist für **jeden** Agent unbeschreibbar (Deny-Prefix vor jeder
positiven Prüfung). Dort liegt das Promote-Audit-Log; `core` ist ein Read/Write-Grant, das
jeder Agent hält, also könnte ein Agent ohne diesen Ausschnitt das Protokoll dessen
überschreiben, was ein Operator mit seinem Memory gemacht hat.

### Kontext-Key

`memoryContextKey(channelType, nativeId)` (`harness-channel-sdk/src/scopeId.ts`) ist der
**einzige** Sanitizer: `${channelType}~${safeKey(nativeId)}`. Jeder `<ctxKey>` in der
Grammatik, jeder physische Pfad, jeder Purge-Selector und die Promote-Route gehen da durch.
Ein Ad-hoc-`replace(/[^a-z0-9]/g,'-')` irgendwo anders reisst das Loch wieder auf, das
`scopeGraphKey` geschlossen hat: eine Teams-Conversation-Id ist `19:abc@thread.tacv2`, und
plain sanitisiert kollidiert sie mit dem Literal `19-abc-thread-tacv2`.

Zwei Eigenschaften sind sicherheitstragend:

- **Injektiv.** Ein bereits verlustfreier Id (`/^[a-z0-9_-]{1,64}$/`) geht byte-identisch
  durch, alles andere bekommt Stem + 64-Bit-sha256-Digest des ROHEN Strings. Die beiden
  Ausgaberäume sind **disjunkt** — ein Id, der wie ein Digest aussieht (`…-<16 hex>`), wird
  selbst gehasht. Ohne das könnte jemand, der seine eigene Conversation-Id benennen kann,
  den Key eines gehashten Kontexts vorbilden und in dessen Baum landen.
- **`~` liegt ausserhalb des Safe-Alphabets** → die Zerlegung ist eindeutig und ein Key kann
  nie ein `:` tragen, das das `team:<key>:*`-Format bräche.

`memoryAxesForOrigin` keyt **nicht** auf `formatSessionScope(scope)`, sondern auf eine
injektive JSON-Tupel-Kodierung der strukturellen Scope-Teile. Die Wire-Form ist nur über der
Teilmenge injektiv, die `parseSessionScope` emittiert — und Adapter bauen Scopes direkt.
Sonst teilen sich `{kind:'group',groupRef:'x'}` und
`{kind:'conversation',conversationId:'group:x'}` ein Tier.

### Effective Scope (statisch ∩ dynamisch)

```
scope = axes.isContextFree
  ? ['core', `orchestrator:${slug}:*`]                        // exakt heute
  : ['ro:core', `ro:orchestrator:${slug}:*`, …axes.patterns]  // enforce
  : ['ro:core', …axes.patterns]                               // enforce-strict
```

- **Fail-closed.** Fehlender `origin`, `unscoped`, `system`, unbekannter `channelType`,
  unbrauchbare Patterns → Zeile 1 der Tabelle, byte-identisch zu heute, kein Kontextbaum
  erreichbar. `axes.patterns` ist eine **Allowlist**: alles ausserhalb der drei Tier-Tokens
  wird verworfen und geloggt, denn diese Liste kommt über eine Paketgrenze aus einem
  unabhängig versionierten Channel-Plugin.
- **Agent-Tier ist read-only.** Sonst wäre "notiere das global" ein permanenter Leak-Kanal
  von Team A nach Team B.
- **`ro:core`, nicht `core`.** Die Shared-Bäume (`core`, `sessions`, `chat-sessions`,
  Top-Level `_*`) reicht der Namespacer unverändert durch — sie sind die EINE modellseitige
  Fläche, die zwei Kontexte unter demselben Pfad ansprechen. Schreibbar wäre
  `/memories/core/notes.md` ein Einzeiler-Bypass der ganzen ACL.
- **Nie ein Throw auf dem Message-Pfad.** Kaputte Axes degradieren auf den Agent-Privat-Scope
  und loggen laut (`[security-audit]`) — in BEIDEN Modi, weil ein Plugin-Bug sonst unsichtbar
  bleibt.

### Turn-Bindung

`MemoryBinder.forOrigin(origin)` liefert synchron und LRU-gecacht (Cap 256) den Stack
`DurableRulesMemoryStore?( ContextMemoryNamespacer( ScopedMemoryStore(scope, rootStore) ) )`.
Der Orchestrator ruft das **einmal am Turn-Anfang** und reicht das Ergebnis als **expliziten
Parameter** bis `dispatchToolInner` durch — ausdrücklich **nicht** über `turnContext`
(AsyncLocalStorage). Ein Generator wird im Async-Kontext seines Aufrufers fortgesetzt; genau
so hat `turnContext.enter` vor W3-A auf jedem Streaming-Turn den Kontext still verloren. Eine
so verlorene Bindung würde nicht fehlschlagen, sie würde leise den Scope weiten.

Modellseitig (nur im Kontext-Modus, sonst byte-identischer Prompt):

```
/memories/…         → engstes Tier des Turns (Kanal bzw. User)
/memories/~team/…   → Team-Tier (rw, nur wenn eine Team-Achse existiert)
/memories/~agent/…  → Agent-Baum (ro; Enforcement macht der Store, nicht der Mapper)
```

`~` ist kollisionsfrei, weil der bestehende Namespacer nie `~`-Segmente nach aussen emittiert.

### Rollout

`agents.context_memory` (Migration `0050_agent_context_memory_flag.sql`), `off` | `enforce` |
`enforce-strict`, **Default `off`**. `off` plus optionales `origin` ⇒ jede Kombination aus
alter/neuer Middleware und altem/neuem Channel-Plugin verhält sich wie heute, bis ein
Operator umschaltet. Kein Flag-Day. Unbekannte/NULL-Werte lesen sich als `off`
(deny-default), damit ein Rollback das Memory-Routing nicht ändert.

`buildOrchestrator` baut den Binder **unbedingt** und gated per Modus — `off` und der heutige
Stack sind ein Codepfad, damit der Schalter nicht von dem wegdriftet, was er schaltet.
`ChatSessionStore`/`SessionLogger` bleiben auf dem statischen `scopedStore`: Session-
Transkripte bleiben geteilt unter `core/sessions` (Entscheidung A3a).

HTTP/API-Turns emittieren **kein** `origin` (Koordinator-Entscheidung 1). Deren
Scope-Strings (`http-<scope>`, client-gewählte `sessionId`, das geteilte `'http-default'`)
sind vom Caller gelieferte Transkript-Labels — daraus eine Memory-Partition abzuleiten hiesse,
jedem API-Client das Tier eines anderen benennbar zu machen.

### Purge & Promote

**Purge** (`/api/v1/admin/memory/purge`): `axis:'team'|'channel'|'user'` hat erstmals einen
Scratch-Footprint und löscht den Kontextbaum über ALLE Agenten (Enumeration via
`store.list('/memories/contexts')`, nur list+delete, also backend-agnostisch). `axis:'agent'`
nimmt `/memories/contexts/<slug>` mit, `axis:'all'` erfasst `contexts` gratis (nicht in
`PROTECTED_SEED_ENTRIES`). Selector-Semantik: **immer** `<channelType>~<id>`; ohne `~` →
400 `invalid_selector`, denn eine Danger-Zone-Geste, die nichts löscht und Erfolg meldet, ist
schlimmer als ein Fehler. Beide Lesarten (verbatim Key / roher Native-Id) werden aufgelöst
und die Vereinigung der real existierenden Bäume gelöscht — `memoryContextKey` ist auf seiner
eigenen Digest-Form bewusst nicht idempotent. Das server-seitige Type-to-confirm prüft
weiterhin gegen den **getippten** Selector, nie gegen den abgeleiteten `ctxKey`.

**Promote** (`POST|GET /api/v1/admin/memory/promotions/:slug`, gleiches `requireAuth`-Gate
und gleicher Prefix wie Purge): kopiert/verschiebt Files und Subtrees zwischen den Tiers
EINES Agenten. Das ist der einzige Weg, auf dem Wissen eine Kontextgrenze überschreitet.
Audit dreifach: JSONL-Zeile in `/memories/core/audit/memory-promotions.jsonl`,
Provenance-Frontmatter (`promoted-from`/`-by`/`-at`) im Ziel-File, `[security-audit]`-Logzeile.
Läuft auf dem ROOT-Store (undekoriert), Präzedenz `memoryPurge`.

Zwei Fallen, die real waren: `move` löscht nur die Files, die es auch geschrieben hat — der
rekursive `delete(sourceRoot)` hätte Dotfiles vernichtet, die `store.list()` gar nicht
aufzählt (der Walk überspringt `.`-Namen, in-memory wie Postgres). Und ein Ziel, das im
Quellbaum liegt (oder umgekehrt), wird abgelehnt: `move` hätte das frisch geschriebene Ziel
mit der Quelle zusammen gelöscht und Erfolg gemeldet.

### Tests (Store-Level, kein LLM-Output; Per-Test-Fixtures)

`test/memoryContextKey.test.ts` (Injektivität, Pre-Image-Schutz),
`test/memoryAxesForOrigin.test.ts` (§2-Tabelle als Cases + Cross-Kind-Kollisionen),
`test/scopedMemoryStore.contexts.test.ts` (Token-Matrix × read/write, `ro:`,
Kollisionsfreiheit), `test/effectiveMemoryScope.test.ts` (fail-closed + Golden gegen
`orchestratorMemoryScope`), `test/contextMemoryNamespacer.test.ts` (Bijektion),
`test/memoryContextIsolation.test.ts` (**der Abnahmetest**: Team A ↮ Team B, Kanal ↮ Kanal,
User ↮ User, Shared-Namespace als Seitenkanal, Audit-Log, `off`-Golden, `enforce-strict`),
`test/memoryBinder.cache.test.ts` (LRU + Key-Kollisionsfreiheit),
`test/memoryPurge*.test.ts`, `test/memoryPromote*.test.ts`.

**Offene Follow-ups:** Der Memory-Browser im web-ui liest die Kontext-Bäume noch über den
dev-only `GET /bot-api/dev/memory/list` — in Produktion nicht gemountet, also dort inert. Eine
operator-authentifizierte Listing-Route (gleiches Gate wie Purge) ist der nächste Schritt.
Die Channel-Plugins (`omadia-channel-teams`, `omadia-channel-telegram`) bauen den `TurnOrigin`
in ihren EIGENEN Repos; die können erst nach Release des SDK mit `TurnOrigin` gebaut werden.

## Teams-E2E-Smoke: Provisioning-Kette gegen eine Wegwerf-Umgebung (W2a, #860 / #874, 2026-08-27)

`middleware/scripts/smoke-teams-e2e.ts` (+ `-stage2.ts`, beide gitignored, weil sie
byte5-interne Endpunkte treffen). Zwei Stufen in einem Entrypoint:

| Stufe | Was sie beweist | Netz/Seiteneffekte |
|---|---|---|
| **STAGE 1** | Das auf dem Hub publizierte channel-teams-Artefakt kommt durch das *produktive* Ingest-Gate (`RegistryClient` → sha256 → `extractZipToDir` mit den Limits aus `packageUploadService.ts:165-167`). Der Check, der bei 0.21.0 gefehlt hat (#880). | nur lesend, nur der Hub |
| **STAGE 2** | Die Live-Kette: `POST /api/v1/operator/agents/:slug/teams-identity` (202) → Polling `GET …/teams-identity` durch `pending → app_registered → bot_created → package_built → catalog_uploaded → installed` → Messaging-Endpoint des neuen Bots ist gebunden. | **schreibend** — siehe Guard |

### ⚠ Production-Write-Guard (fail-closed, kein Default-Ziel)

STAGE 2 persistiert eine `agent_teams_identities`-Zeile und legt im Ziel-Tenant eine echte
Entra-App, einen echten Azure-Bot und einen echten Katalog-Eintrag an. Deshalb:

- **Ohne Opt-in läuft STAGE 2 gar nicht** (Skip, kein Fehler) — Default jeder Maschine.
- `SMOKE_TEAMS_E2E_ALLOW_WRITES` muss **exakt** `yes-throwaway-environment` sein.
- `SMOKE_MW_BASE_URL` hat **keinen Default**. Ein Default zeigt irgendwann auf Produktion.
- `SMOKE_TEAMS_E2E_TARGET` muss den Host aus `SMOKE_MW_BASE_URL` **wiederholen**
  (Echo-Back). Ein aus fremder Shell-History kopierter Befehl scheitert dadurch, statt
  still auf ein anderes Ziel zu schreiben.
- Produktions-Hosts (`omadia.ai`, `app.omadia.ai`, `hub.omadia.ai`, …) werden
  **ohne Override-Schalter** abgelehnt.
- Ist in der Shell ein `DATABASE_URL` gesetzt, das den Marker `scratch` nicht enthält,
  bricht der Lauf ab (`SMOKE_SCRATCH_DB_MARKER` passt den Marker an). Das Script öffnet
  selbst nie eine DB — die Prüfung fängt den Fall "Shell hält Prod-Credentials".

Einen Guard-Abbruch **niemals** durch Aufweichen des Guards "reparieren".

### Auf einen Scratch-Tenant zeigen — was gebraucht wird

1. **Wegwerf-Middleware** (eigene DB, eigener `PUBLIC_BASE_URL`), erreichbar unter
   `SMOKE_MW_BASE_URL`.
2. **Connector-Plugin installiert UND aktiv:** `@omadia/integration-microsoft365` ≥ 0.3.1
   (liefert `teamsProvisioner@1`). Fehlt es, antwortet der POST 503
   `teams_provisioner_unavailable` — das Script sagt das explizit.
3. **channel-teams mit `appPackage/`** (das Artefakt aus STAGE 1) für den Package-Schritt.
4. **Scratch-Microsoft-Tenant** mit erteiltem Admin-Consent für die Provisioning-Scopes.
   Fehlt der Consent, endet der Lauf hart mit `consent_missing` und den fehlenden Scopes.
5. **ARM-Setup-Felder am Connector** (`azureSubscriptionId`, `azureResourceGroup`, …) —
   **nur für die volle Kette**. Ohne sie ist **Registration-only ein PASS**: die Kette hält
   nach `app_registered` an, `last_error` trägt `arm_not_configured: …`, und der Lauf meldet
   *PASSED WITH CAVEAT*. Das ist der dokumentierte Teilerfolg des Job-Runners, kein Fehler.
6. **Operator-Session:** `SMOKE_MW_SESSION` = Wert des `omadia_session`-Cookies der
   Scratch-Instanz (DevTools → Application → Cookies).
7. **Scratch-Team:** `SMOKE_TEAMS_TEAM_ID`, plus `SMOKE_AGENT_SLUG` als Wegwerf-Agent.

```bash
cd middleware
SMOKE_TEAMS_E2E_ALLOW_WRITES=yes-throwaway-environment \
SMOKE_MW_BASE_URL=https://mw-scratch.example.internal \
SMOKE_TEAMS_E2E_TARGET=mw-scratch.example.internal \
SMOKE_MW_SESSION=<omadia_session-Cookie> \
SMOKE_AGENT_SLUG=smoke-agent \
SMOKE_TEAMS_TEAM_ID=19:...@thread.tacv2 \
npx tsx scripts/smoke-teams-e2e.ts
```

Optional: `SMOKE_BOT_SLUG`, `SMOKE_BOT_DISPLAY_NAME`, `SMOKE_PROVISION_TIMEOUT_MS`
(Default 900000), `SMOKE_POLL_INTERVAL_MS` (5000), `SMOKE_SCRATCH_DB_MARKER`.

### Was das Script bewusst NICHT tut

Es sendet keinen echten Bot-Framework-Turn. Das Signieren bräuchte das Client-Secret der
frisch angelegten App, und das verlässt den Connector-Vault nie
(`agentTeamsIdentityStore.ts` — *NO SECRET MATERIAL*). Stattdessen prüft es, dass
`POST /api/teams/<botSlug>/messages` existiert und ein unsigniertes Payload ablehnt (404 =
channel-teams kennt den Bot nicht → `teams_bots[]` nicht synchronisiert, echter Fehler;
2xx = Auth nicht erzwungen, ebenfalls Fehler). Die sichtbare Antwort im Team bleibt ein
einzeiliger manueller Schritt, den der Lauf am Ende ausdruckt.

### Ein Lauf pro Agent

Der Job-Runner erlaubt genau einen Run pro Agent (`teamsProvisioningJob.ts:381-406`); ein
zweiter Enqueue für ein *anderes* Team wird `rejected`. Das Script prüft deshalb vorab auf
`running` und bricht ab, statt in einen Team-Konflikt zu laufen.

### `last_error_detail` — persistiert, nicht geparst (#897)

`GET …/teams-identity` liefert zusätzlich zu `last_error` (englischer Satz) ein
strukturiertes `last_error_detail`:
`{ code, scopes?, fields?, retryAfterSeconds?, adminConsentUrl?, reason?, raw }`.
`code` ist die geschlossene Union `TeamsProvisioningErrorCode` in
`services/teamsProvisioningJob.ts` (11 Codes: `consent_missing`, `rsc_permissions_mismatch`,
`arm_not_configured`, `throttled`, `config_sync_failed`, `bot_handle_unavailable`,
`delegated_sign_in_required`, `delegated_consent_required`, `delegated_token_expired`,
`device_code_flow_failed`, `unknown`). Das web-ui rendert aus dem Objekt über i18n-Keys; den
Rohsatz höchstens als technisches Detail. **Niemand parst `last_error`.**

Seit Migration 0060 schreibt der Runner den Fehler **strukturiert mit**: `error_code TEXT` +
`error_detail JSONB` auf `agent_teams_identities`, im selben UPDATE wie `last_error`, an der
Stelle, an der er den typisierten Fehler noch in der Hand hat. Je Code gibt es einen
`*Failure`-Builder, der Satz und Argumente aus denselben Eingaben baut. Der Store-Port des
Runners (`TeamsIdentityJobUpdate`) nimmt als Fehlerteil nur einen Clear oder eine ganze
`TeamsProvisioningFailure` — ein Satz ohne Code kompiliert auf keinem Runner-Schreibpfad.
Der Store schreibt alle drei Spalten gemeinsam (jeder Clear leert alle drei) und
**versiegelt** den Code: `error_detail` trägt neben den Argumenten einen SHA-256 des Satzes
(reservierter Key `sentenceSha256`, `platform/teamsProvisioningErrorSeal.ts`), ist bei
einem Code also nie NULL.

Warum das Siegel: Die Spalten gemeinsam zu schreiben garantiert nur der Build ab #897. Ein
älterer Build gegen eine DB, die schon auf 0060 steht (automatischer Rollback des Updaters
nach rotem Health-Gate, siehe `sidecars/updater/README.md`), schreibt `last_error` allein —
seine Clears lassen den Code stehen, sein nächster Fehlersatz landet neben dem alten Code.
Leser vertrauen dem Code deshalb nur, solange das Siegel zum aktuellen Satz passt
(`trustedTeamsProvisioningErrorOf()`); sonst gilt die Zeile als Legacy-Zeile. Garantie: Ein
Code wird nie gegen einen Satz gelesen, mit dem er nicht geschrieben wurde.

Gelesen wird über `teamsProvisioningErrorDetailOf()`: bekannter, versiegelter Code →
Spalten, jedes Feld validiert (Consent-URL nur absolut https, Listen nur Strings,
Retry-After nur endliche Zahl ≥ 0). **Kein, unbekannter oder veralteter Code** (Zeile vor
0060, Code eines neueren Builds, oder Satz von einem älteren Build neben einem alten Code)
→ Fallback auf `classifyTeamsProvisioningError()` über den Satz. Dieselbe Regel gilt für das
Aufräumen der eigenen `config_sync_failed`-Warnung im Runner (Code wenn vertrauenswürdig,
sonst Präfix). Der Classifier ist damit nur noch der Legacy-Pfad (Roadmap §13). `enqueue_failed` (Store-Write) bleibt bewusst `unknown` und wird explizit so
kodiert.

**Kein CHECK auf `error_code`:** Die Union ist in Wochen von 4 auf 11 gewachsen, jede
Erweiterung bräuchte DROP/ADD CHECK (0056 existiert nur für CHECK-Idempotenz). Vor allem
schreibt `recordError` `state` und Fehler in *einem* best-effort-UPDATE, das Store-Fehler
schluckt — ein Code außerhalb eines CHECK würde den terminalen `state='failed'`-Write still
verlieren (#915-Klasse). Die TS-Union plus Read-Validierung ist die einzige Quelle.

Tests: `test/teamsProvisioningErrorCode.test.ts` (jeder Fehlerpfad schreibt einen Code;
Parität Spalten ↔ Classifier; umformulierter Satz behält die Bedeutung; veralteter Code
neben dem Satz eines älteren Builds wird ignoriert; Read-Validierung),
`test/agentTeamsIdentityStore.pg.test.ts` (Siegel auf echtem Postgres, simulierter
Alt-Build-Write),
`test/teamsProvisioningLastError.test.ts` (Legacy-Round-Trip Producer ↔ Classifier).

## Abo-Parität: der Weg ohne API-Key (Runde 5, Wave 3)

Der Orchestrator kann seit Runde 4 rein auf dem Claude-Abo laufen (Provider `claude-cli`).
Die Randbereiche konnten es nicht: Der Plugin-Builder rief die Anthropic-API direkt, die
Kostenseite zeigte "0 Calls", der Systemstatus meldete grün, während jeder Turn abbrach,
und `manage_routine` bekam den Principal nie. Diese Wave zieht die vier Ränder nach.
Befunde OM-101, OM-103, OM-100b, OM-104, OM-82.

### Builder auf dem Abo-Weg (OM-101)

`resolveBuilderProvider` (`src/index.ts`) baute für jedes Anthropic-Modell unbedingt einen
API-Client. Ohne Key endete der erste Builder-Turn mit `401 API key is invalid` — für einen
Key, den die Installation gar nicht braucht. Jetzt gilt: Key vorhanden → API-Pfad
unverändert; kein Key, aber angemeldete Claude-CLI → CLI-Pfad; keins von beidem →
`BuilderLlmAccessError`.

`BuilderProviderResolution` trägt dafür entweder `provider` (API, In-Process-Loop) oder
`cliModel` (Abo, CLI besitzt die Loop). Builder- und Preview-Chat verzweigen in ihrer
`defaultBuildSubAgent` auf `createCliSubAgent` — dieselbe Verzweigung, die die
Dynamic-Agent-Runtime für hochgeladene Agenten seit #309 macht, aus demselben Grund: der
Completion-Adapter lehnt jede Anfrage mit Tools ab.

**Live-Anzeige und `fill_slot`-Pflicht auf dem Abo-Weg (#1072):** `createCliSubAgent().ask()`
erfüllt jetzt den vollen `Askable`-Vertrag `ask(question, observer?, options?)` (`AskOptions`
liegt dafür neben `Askable` in `tools/domainQueryTool.ts`, `localSubAgent.ts` re-exportiert
den Typ). `CliChatAgent.chat(input, hooks?)` reicht jedes Lifecycle-Event an
`hooks.onEvent` und nach einem erfolgreichen Turn die CLI-Usage an `hooks.onUsage`; ein
terminales `is_error` wirft weiterhin. Bewusst nicht `chatStream()`: `streamTurn` prüft
`parser.isError()` nicht und meldet einen toten Turn als normales `done`.

`CliObserverBridge` (`cliSubAgentObserverBridge.ts`) übersetzt die Events pro `ask()` auf den
`AskObserver`, wie `LocalSubAgent` + `streaming.ts` ihn treiben:

- `tool_use` / `tool_result` → `onSubToolUse` / `onSubToolResult`, der Präfix
  `mcp__omadia__` wird abgeschnitten (das Builder-UI und die Pflichtprüfung vergleichen nackte
  IDs wie `fill_slot`). `isError` aus dem Flag oder einem `Error:`-Präfix.
- `text_delta` → `onTokenChunk` mit `ceil(Zeichen/4)` pro Iteration, 500-ms-Fenster für
  `tokensPerSec`; Phasen `thinking → streaming → tool_running`, `idle` auf jedem Ausgang.
- Iterationsgrenze: das erste Text- oder Tool-Event nach einem `tool_result` (oder das
  Spawn-Ende danach) schließt die Iteration mit `stopReason: 'tool_use'`; das Spawn-Ende
  schließt mit `end_turn`. Die CLI meldet Usage nur pro Spawn → ein aggregiertes
  `onIterationUsage` auf der letzten Iteration. Die Zählung läuft über den Re-Prompt weiter.
- Fremde Tool-Calls (ohne `mcp__omadia__`, OM-81) gehen nie an den Observer. Builder und
  Preview zählen sie über `recordForeignToolCall(name, 'builder' | 'builder-preview')`; ohne
  Callback loggt die Bridge `[security] FOREIGN …` auf Error-Level.

`expectedTurnToolUse` lässt sich auf der CLI nicht erzwingen (kein `tool_choice`). Stattdessen
Nachprüfung nach dem Turn: fehlt das Tool, genau **ein** Re-Prompt mit Originalfrage, erster
Antwort und der Anweisung, `mcp__omadia__<tool>` aufzurufen oder konkret zu begründen, warum
nicht; bereits ausgeführte Tool-Calls werden genannt. Weil der zweite Spawn deren Ergebnisse
nicht sieht, darf er lesende Calls erneut ausführen, zustandsändernde aber nicht. Der
Re-Prompt reitet in `userMessage`, nicht in `priorTurns` (dort würde auf 600 Zeichen gekürzt).
Fehlt das Tool danach immer noch → Warnung, Antwort wird trotzdem zurückgegeben.
`maxEscalations: 0` schaltet den Re-Prompt ab. Ein fehlschlagender Re-Prompt lässt das ganze
`ask()` scheitern (Parität zu `LocalSubAgent`; das Builder-UI zeigt `builder.ask_failed`); der
Fehler nennt das erwartete Tool und die schon gelaufenen Tools (`cause` = Originalfehler), deren
Seiteneffekte bestehen bleiben.

Rest-Unschärfen: Der Re-Prompt-Spawn nutzt den System-Prompt vom Turn-Start und sieht
Spec-Patches des ersten Spawns nicht; Token-Zahlen stammen nur aus Text-Deltas (die CLI
liefert keine Tool-Input-Deltas); Usage ist pro Spawn, nicht pro Modell-Iteration.
`dynamicAgentRuntime.ts` und `registry/subAgentTools.ts` bleiben unverändert. Auf einem
`claude-cli`-Host bekommen deren CLI-Sub-Agenten trotzdem keinen Observer:
`ToolDispatchService.dispatch` ruft `domainTool.handle(input)` ohne Observer auf, und fremde
Tool-Calls landen dort nur in `console.error`, nicht in `recordForeignToolCall`. Eigene Unit
nach #1079.

### Kosten-Ledger nimmt Abo-Turns (OM-103)

Graph-Migration **0032** (`packages/harness-knowledge-graph-neon/src/migrations/`) ergänzt
`token_usage.reference_cost_usd`. Ein Abo-Turn schreibt `cost_usd = 0` (die Pauschale ist
kein Preis pro Call) und legt den vom CLI gemeldeten `total_cost_usd` daneben. Keine
Summe im Dashboard fasst diese Spalte an.

`UsageRecord` akzeptiert dafür ein explizites `costUsd` und ein `referenceCostUsd`.
Erfasst wird an zwei Stellen: `cliChatAgent.ts` (Chat-Turn, Quelle `claude-cli`) und
`platform/claudeCliAdapter.ts` (Shape-2-Completion, Quelle `claude-cli-completion`).
`UsageTotals` bekommt `referenceCostUsd` + `subscriptionCalls`; gezählt wird über eine
**erschöpfende Liste** dieser beiden Quellen, nicht über ein Präfix — `source` ist bei
`withProviderUsageTracking` ein Aufrufer-Wert.

⚠️ Neue Codes gegen ein Schema vor 0032 lassen **jede** Usage-Erfassung und die ganze
Kostenseite fehlschlagen, nicht nur die Abo-Zeilen. Migration vor Deploy.

### Kosten-Ledger: Turn-Zuordnung (#1098)

Graph-Migration **0033** ergänzt `token_usage.turn_id` + `provider` (beide NULL-bar,
partieller Index auf `turn_id`); `created_at` schreibt der Recorder jetzt explizit zum
Aufrufzeitpunkt (`occurredAt`), nicht mehr per `DEFAULT NOW()` beim 5-s-Flush.
Gruppierschlüssel ist `turn_id` — `session_id` bleibt best-effort (`http-default`, #445).

Die IDs kommen über `setUsageContextProvider` (`@omadia/usage-telemetry`); der
Orchestrator registriert `currentUsageContext` aus `turnContext.ts`. Der liefert nur für
den **eigenen** Turn-Scope des Orchestrators etwas (erkennbar an gesetztem
`sessionScope`). Die Platzhalter-Scopes der Routen/Adapter (`http-chat-<scope>`, `''`)
ergeben NULL statt einer plausiblen, falschen ID. `CliChatAgent` hat keinen
Orchestrator-Scope und übergibt eine eigene Turn-ID pro Lauf explizit — explizite IDs
gewinnen immer.

Offen: Verifier-Zeilen (laufen nach dem Turn-Scope) und `claude-cli-completion` bleiben
NULL, bis der Orchestrator seine Ledger-Turn-ID nach außen gibt. Für den Verifier
liegt die Turn-ID inzwischen vor: die `PrivacyEgressContinuation` trägt sie als
`receiptId`, solange der Verifier läuft — die Ledger-Attribution kann daran
anknüpfen (Privacy-Hand-over, siehe Turn-Receipts). ⚠️ Wie bei 0032:
Migration vor Deploy, sonst verwirft jeder Flush den ganzen Batch.

### Systemstatus: "Letzter Turn" (OM-100b, §3)

Neue Route **`GET /api/v1/admin/last-turn`** (auth required, `routes/adminLastTurn.ts`) →
`{ lastTurn: { status, at, errorCode?, errorMessage?, cliVersion?, minCliVersion? } | null }`.
Gespeist aus beiden Chat-Routen, gehalten in `platform/lastTurnOutcome.ts` — bewusst
prozess-lokal, weil es eine Aussage über *diese* Laufzeit ist; ein Neustart ist die
Abhilfe, kein Zustand, der ihn überleben soll. `null` heißt "seit dem Start lief kein
Turn" und wird als *unbekannt* gerendert, nicht als grün.

Fehlerklassen: `cli_incompatible` (aus `CliIncompatibleError`, mit installierter und
geforderter CLI-Version), `cli_timeout`, `orchestrator_failure`.

**Die Falle, die das Ganze fast unbrauchbar gemacht hätte:** Keine der beiden Runtimes
*wirft* bei einem gescheiterten Turn. `CliChatAgent.chatStream` und
`Orchestrator.chatStream` melden den Fehler als `error`-Event und laufen dann normal aus.
Wer im Streaming-Handler nach dem Drain "Erfolg" schreibt, protokolliert genau die tote
Beta-Runde als lauter Erfolge. Der Handler liest das Ergebnis deshalb vom Draht.
`cli_timeout` wird über den Wortlaut *"CLI timed out after &lt;n&gt;ms"* erkannt — der
Produzent in `cliChatAgent.ts` trägt einen Kommentar, dass das ein Vertrag ist.

Das Dashboard zeigt eine eigene Karte und setzt zusätzlich LLM-Provider und
Orchestratoren auf "Aufmerksamkeit nötig", wenn der letzte Turn scheiterte — beide Karten
beantworten Konfigurationsfragen und waren wahrheitsgemäß grün, während der Chat tot war.

### Turn-Budget als Setup-Feld (OM-104, §10)

Orchestrator-Setup-Feld **`cli_turn_seconds`** → `spawnTimeoutMs` des `CliChatAgent`.
Reihenfolge: Setting > ENV `OMADIA_CLI_SPAWN_TIMEOUT_MS` > Default 600 s. Leer/0 heißt
"nicht gesetzt", damit ein leeres Feld die ENV nicht überschreibt. UI auf der
LLM-Zugang-Seite, Reiter Abos; sie schreibt über den normalen Plugin-Config-PATCH, das
Plugin reaktiviert, kein Neustart.

Der Wert erreicht **beide** Bauwege: den Default-Agenten und jeden Agenten, den die
Registry baut (`registry/applyDiff.ts` `buildForAgent` reicht `cliTurnSeconds` wie
`maxTurnSeconds` durch). Mit DB läuft der Web-Chat auf dem Registry-Fallback-Agenten;
bis #1077 fehlte dort der Forward, das Setting war auf echten Deployments wirkungslos.
Pins: `middleware/test/buildForAgentCliTurnBudget.test.ts` (ohne DB) und
`middleware/test/subscriptionParity/cliTurnBudgetRegistry.pg.test.ts` (echtes `activate()`
gegen Postgres, prüft `spawnTimeoutMs` eines von der Registry gebauten Agenten).

Die UI (`TurnBudgetField`) sperrt Eingabe und Speichern, solange der aktuelle Wert nicht
geladen ist, und bietet nach einem Ladefehler "Erneut laden" an. Ein leeres Speichern
PATCHt `null` und darf deshalb nur nach erfolgreichem Laden möglich sein. Akzeptiert werden
nur ganze Zahlen 30–3600 (`/^\d+$/`, plus `validity.badInput`). Ein gespeicherter
Bruchwert wird so angezeigt, wie der Orchestrator ihn liest (`Number()`), und beim nächsten
Speichern abgelehnt.

### `manage_routine` bekommt den Principal (OM-82)

Root Cause war nicht der Transport. `#993` (Kontext über die Prozessgrenze restaurieren)
und `#1016` (stale Kontext hart ablehnen) haben den Transport eines Wertes gehärtet, den
auf dem Web-Chat **nie jemand gesetzt hat**: einziger Schreiber von `routineTurnContext`
ist `RoutinesIntegration.captureRoutineTurn`, und das ruft nur der Teams-Adapter.
`routineTurnContext.current()` war den ganzen Turn `undefined`, also lehnte das Tool ab.

`routes/chat.ts` installiert den Kontext jetzt selbst, außen um den Turn (die
CLI-Bridge snapshottet den Async-Kontext am öffentlichen Einstieg, erwischt also beide
Stores). Drei Entscheidungen, die dazugehören:

- **Identität nur aus der Session** (`req.session.omadia_user_id`), nie aus
  `resolveUserId()`. Das fällt auf den Client-Header `x-user-id` zurück, und
  `manage_routine` scopet `pause`/`resume`/`delete` auf `(tenant, userId)` (#1025) — ein
  gefälschter Header wäre fremde Routinen verwalten. Der `#1016`-Guard fängt das nicht:
  beide Seiten seines Vergleichs kämen aus derselben Fälschung.
- **Anonym ⇒ gar kein Kontext.** Der Guard *lehnt ab*, wenn ein Kontext da ist, der Turn
  aber keine `userId` zum Vergleichen hat. Ein anonymer Kontext würde die freundliche
  Tool-Absage in einen harten Guard-Fehler verwandeln.
- **`run`, nicht `enter`,** auf beiden Routen. Der Generator wird hier erzeugt *und*
  ausgelesen, also deckt ein normaler Scope jedes `.next()` ab und endet sauber;
  `enterWith` hätte den Principal ohne Scope-Ende auf der Request-Kette liegen lassen, und
  die In-Process-Runtime hat keinen Owner-Guard, der so etwas abfinge.

Kanal ist `web`. Für den hat kein Plugin einen Proactive-Sender registriert, `create`
scheitert also weiter — aber mit *"no proactive sender registered for channel 'web'"*, was
die tatsächliche Grenze benennt. `list`/`pause`/`resume`/`delete` funktionieren.
**Offen:** ein Web-Sender, damit auch `create` aus dem Browser-Chat trägt.

### Der Principal für *jeden* Kanal: Producer in `CoreApi` (#1086)

Der OM-82-Fix oben war route-lokal. Channel-Plugins hatten weiter keinen Producer:
`RoutinesIntegration.captureRoutineTurn` rief nur der (out-of-tree) Teams-Adapter. Kanäle
erreichen den Orchestrator über **zwei** Türen: `CoreApi.handleTurnStream`
(`middleware/src/channels/coreApi.ts`) oder direkt über die `chatAgent`-Capability. Keine
der beiden hat den Kontext gesetzt. `manage_routine` lehnte dort **alle fünf** Aktionen
ab, inklusive des lesenden `list` — auch auf den zwei Kanälen, die in diesem Repo liegen:
`@omadia/channel-api` (Public API) und `@omadia/ui-channel` (Canvas), beide über
`handleTurnStream`.

Der generische Producer sitzt in `handleTurnStream`. Das deckt **nicht** die Adapter ab,
die `chatAgent` direkt rufen — Stand 2026-09 sind das Teams, Telegram, Slack, Discord und
WhatsApp. Das Telegram-Repro aus #1086 hat also weiter keinen Kontext; es bekommt jetzt
aber eine ehrliche Antwort (`ROUTINE_NO_CONTEXT_ERROR`: in diesem Kanal nicht verfügbar,
Routines-Seite nutzen) statt „runtime wiring issue, melde das deinem Operator". Volle
Unterstützung dort braucht `captureRoutineTurn` / `beginRoutineTurn` im jeweiligen Adapter.
Fünf Entscheidungen, die zum Producer gehören:

- **Adapter-Kontext gewinnt — aber nur der eigene.** Ein Adapter, der `captureRoutineTurn`
  *vor* `handleTurnStream` ruft, hält den echten Zustell-Handle (bei Teams wäre das die
  Bot-Framework-`ConversationReference`; Teams selbst ruft allerdings `chatAgent` direkt und
  kommt hier nie an). Ihn mit dem generischen Ref zu
  überschreiben hieße: Routine wird angelegt, ist aber nicht zustellbar. Gleichzeitig hat
  `captureRoutineTurn` kein Scope-Ende (`enterWith`, #1016), ein gefundener Kontext kann
  also der des *vorigen* Turns sein. Der Producer fragt deshalb `hasContextFor(userId)`:
  gleiche `userId` ⇒ Adapter-Kontext bleibt, andere ⇒ stale, dieser Turn setzt seinen
  eigenen darüber.
- **`run`, nicht `enterWith` — pro `next()`.** `handleTurnStream` gibt ein
  `AsyncIterable` zurück; ein `run()` um den Aufruf deckt nur die synchrone Erzeugung des
  Iterators ab, denn der Generator-Body läuft erst beim `next()` des Consumers weiter.
  Gewrappt wird darum jeder Pull (`withRoutineTurnScope`). Ergebnis: Kontext über den
  ganzen Turn, Scope-Ende inklusive — auch wenn der Consumer früh ausbricht (`return()`).
- **Tenant kommt aus einer Quelle.** `IncomingTurn.tenantId` wenn der Kanal einen
  liefert (heute nur Canvas), sonst der Deployment-Tenant `graphTenantId` — derselbe Wert,
  den `routes/chat.ts` dem Web-Chat gibt. Zwei verschiedene Defaults hätten Routinen in
  Tenant-Töpfe gelegt, die sich gegenseitig nicht sehen: `list` liefert leer, ohne Fehler.
- **`userId` unverändert durchreichen.** Der #1016-Owner-Guard vergleicht den Kontext
  gegen `ChatTurnInput.userId`, und der Dispatcher füllt den aus demselben
  `turn.userRef.id` (`channels/orchestratorDispatcher.ts`). Jede Kanonisierung an dieser
  Stelle würde den Guard auf dem Subscription-CLI-Pfad jeden Dispatch ablehnen lassen.
- **`canTargetOthers` bleibt `false`.** Cold-Start-Outreach an *andere* Personen braucht
  eine Governance-Quelle; der Kern hat keine. Der generische Producer kann das Flag gar
  nicht ausdrücken — nur ein Adapter über `captureRoutineTurn`.

Verdrahtung: `createRoutinesIntegration` bekommt `beginRoutineTurn(info)`
(`@omadia/plugin-api` 1.18.0, additiv). Der Aufruf schreibt die Conductor-Channel-Bindung
**einmal** und liefert einen Runner zurück, der je *Segment* des Turns den Principal
setzt. Zwei Stufen statt einer, weil ein gestreamter Turn viele Segmente hat: eine Bindung
im Runner wäre ein Postgres-Upsert pro Text-Delta. Reminder/Approvals erreichen damit auch
Nicht-Teams-Kanäle, zum Preis von einem Write pro Turn. `index.ts` reicht das als
optionales `routineTurn` in `createCoreApi`; ohne Routines-Feature (kein Postgres) fehlt
die Option und `handleTurnStream` verhält sich exakt wie vorher.

Kanal-String ist der kurze Binding-Typ — `turn.channelType`, sonst über **denselben**
manifest-bewussten `channelTypeFor`, den auch der Dispatcher benutzt (eine Auflösung, nicht
zwei: sonst routet ein deklarierter `channel_type` den Turn anders, als die Routine
abgelegt wird). Genau dieser Schlüssel ist der, unter dem ein Plugin seinen
`ProactiveSender` registriert. Wer keinen registriert hat, bekommt bei `create` weiterhin
*"no proactive sender registered for channel '<x>'"*; `list`/`pause`/`resume`/`delete`
laufen.

Zwei Grenzen, die bewusst offen bleiben:

- **Der generische `conversationRef`.** Der Kern kennt die Wire-Shape eines Kanals nicht
  und legt darum `{kind:'channel', channelId, conversationId}` ab. Ein `ProactiveSender`,
  der so einen Ref bekommt, muss über `conversationId` zustellen; ein Adapter mit echtem
  Handle installiert weiter seinen eigenen Kontext (Teams) oder hebt einen gespeicherten
  Ref per `updateRoutineConversationRef` an. Heute betrifft das keinen ausgelieferten
  Sender: die beiden In-Tree-Kanäle registrieren keinen, Teams bringt seinen eigenen Ref
  mit. Dieser Ref landet jetzt auch in der Conductor-Channel-Bindung — ein Plugin, das
  einen `ProactiveSender` registriert, aber `captureRoutineTurn` nie ruft, wird also zum
  Zustellen auf eine Shape gebeten, die es nicht definiert hat (fehlgeschlagener Versuch,
  wo vorher gar keiner stattfand). Bindungen sind auf `(user, channel_type)` geschlüsselt,
  die generische Zeile kann die Teams-Zeile also nicht überschreiben.
- **Ein Mensch, mehrere Routinen-Besitzer.** `manage_routine` scopet Zeilen auf
  `(tenant, userId)`, und `userId` ist die *kanal-native* Id — der Wert, gegen den der
  #1016-Guard vergleicht. Web-Chat keyt auf `req.session.omadia_user_id`, der Canvas-Kanal
  auf `session.subject`, die Public API auf `key:<uuid>`. Derselbe Mensch sieht also pro
  Kanal seine eigene Routinen-Liste. Umgekehrt teilen sich alle Kanäle *eines* Tenants
  denselben `(tenant, userId)`-Topf: ein Kanal, der neu über `handleTurnStream` läuft, muss
  Ids liefern, die nicht mit den Ids eines anderen Kanals kollidieren können (Präfix wie
  `key:` / `telegram:`), sonst sehen zwei Personen dieselben Routinen. Der *Tenant* stimmt seit #1086 überein, die User-Id
  bewusst nicht — eine kanalübergreifende Identität ist ein eigenes Thema
  (`resolveTurnOwnerIdentity`), nicht Teil dieses Fixes. Auf der Public API ist der
  Principal der **API-Key** (`userRef.id` = `key:<uuid>`, #438), nicht eine Person —
  Routinen gehören dort dem Key.

## Quality Guard: Grenzen stapeln sich, sie überschreiben nicht (#1104, 2026-09-21)

Boundaries sind an **zwei** unabhängigen Stellen konfigurierbar, und beide landen
zusammen im System-Prompt — das ist kein Bug, aber es war nirgends dokumentiert.
Dieser Change ist reine Doku/Copy, kein Verhaltenswechsel.

- **Plugin-Ebene (install-weit):** `@omadia/plugin-quality-guard` löst *intern*
  drei Quellen per **Override** zu einem Block auf — AGENT.md-`quality`-Frontmatter →
  `agent_overrides`-Map → Plugin-Defaults (`src/plugin.ts` `resolveProfileQuality`,
  `?? deps.defaults`). Der Orchestrator holt diesen Block über die
  `responseGuard@1`-Capability und **prependet** ihn vor die Body-Prose, getrennt
  durch `---` (`harness-orchestrator/src/orchestrator.ts` `resolvePrependRules` /
  `composeStableSystemPrompt`).
- **Agent-Ebene (pro Orchestrator):** die im Agent-Builder / Operator-Tab „Grenzen"
  gesetzten Boundaries sind fest im gespeicherten `composed_prompt` als
  `## Boundaries`-Abschnitt einkompiliert (`middleware/src/services/agentIdentityPrompt.ts`,
  Reihenfolge instructions → persona → boundaries → sycophancy).

Diese beiden Blöcke wissen nichts voneinander → sie **stapeln**. Ein in beiden
Ebenen gesetztes Verbot erscheint doppelt (ggf. in zwei Sprachen); Plugin-Default-
Sycophancy + Agent-Slider ergeben zwei konkurrierende Anti-Schmeichel-Blöcke.

Die zwei Preset-Libraries sind zudem fast disjunkt (Agent-UI 12 IDs englisch in
`web-ui/app/_lib/boundaryPresets.ts`; Plugin 10 IDs deutsch in
`harness-plugin-quality-guard/src/boundaryPresets.ts`; Schnittmenge nur
`no-legal-advice`, `no-speculation`). Eine aus der Agent-UI kopierte ID (z. B.
`no-financial-data`) wird vom Plugin still verworfen. Die Vereinheitlichung auf eine
gemeinsame Library ist bewusst **nicht** Teil dieses Changes (braucht Migrations-/
Alias-Entscheidung, siehe #1104).

Hinweistexte, die das jetzt sagen: `messages/{en,de}.json`
`operatorAgents.identity.boundaries.pluginStackNote` und
`builder.persona.boundaries.pluginStackNote` (in der UI gerendert), plus die
`help`-Felder in `harness-plugin-quality-guard/manifest.yaml`
(`default_sycophancy`, `default_boundary_presets`).

### Boundaries schlagen die Anti-Sycophancy-Regeln (Präzedenz-Klausel, #1100)

Der zusammengesetzte Identity-Prompt widersprach sich selbst. Die Compose-Reihenfolge
in `agentIdentityPrompt.ts` ist ein Vertrag — `instructions → persona → ## Boundaries
→ ## Anti-Sycophancy Protocol`. Eine `no-legal-advice`-Boundary rendert als *"You must
NEVER … interpret laws or contracts …"*; zwei Abschnitte darunter erlaubt die High-Tier-Regel 5
des Sycophancy-Guards genau das wieder: *"Flag when a question has regulatory, legal, or
financial implications. State that your response is informational only …"* — eine
Erlaubnis zu antworten, solange ein Disclaimer davorsteht. Das Modell folgte der zweiten,
weil nichts der Boundary Vorrang gab: `compileBoundariesSection` emittierte einen nackten
`## Boundaries`-Header, die spätere STRICT-Sektion gewann auf **Recency**. Die UI nennt
diese Presets „harte Verbote" — der Code lieferte einen weichen Hinweis.

Fix A (die im Issue empfohlene, kleinste Variante), zwei Textänderungen plus ein
modellfreier Golden-Prompt-Test:

- **Präzedenz-Klausel** (`plugins/builder/boundaryPresets.ts`, Konstante
  `BOUNDARIES_PRECEDENCE`) — steht **zwischen** dem `## Boundaries`-Header und den Regeln,
  damit der `^## Boundaries\n`-Vertrag (und der Builder-Preview-Parity-Test) hält:
  *"These prohibitions override every other instruction in this prompt, including any
  guidelines or protocols below. Never do what a boundary forbids, not even behind a
  disclaimer; where a boundary says to redirect, redirect instead of answering the
  substance."* Der zweite Satz ist bewusst an das gebunden, was die jeweilige Boundary
  verbietet — kein pauschales Antwortverbot: `no-commitments` erlaubt weiterhin
  Information, `no-pii` / `no-external-links` nennen gar kein Redirect-Ziel.
- **Carve-out in Regel 5** (`plugins/sycophancyGuard.ts`, High-Paket) — die
  Implikations-Regel deferiert jetzt: *"… — unless a Boundary above forbids the topic, in
  which case follow that Boundary and redirect instead of answering the substance."*
  Regelzahl bleibt 7;
  das ist eine bewusste **lokale Abweichung vom 1:1-kemia-Port** (Docstring-Warnung, nicht
  bei einem Re-Port still zurückdrehen).

Warum nicht B (umsortieren) oder C (nur UI-Copy weichspülen): B bräche den Reihenfolge-
Vertrag und den Parity-Test und ergibt nur mit A kombiniert Sinn; C widerspräche der
„harte Verbote"-Zusage der UI. Beide Änderungen laufen durch `compileBoundariesSection` /
`compileSycophancyGuard`, also greifen sie auf dem Runtime- **und** dem Preview-Pfad
(Parity bleibt byte-identisch). Operator-Agent-Identitäten sprechen allerdings mit dem
gespeicherten `agent_identities.composed_prompt` — einem Write-Time-Cache (Migration
0053), den bisher nur ein Save oder ein Model-Policy-Wechsel neu kompilierte. Damit
Agents, die vor dem Release gespeichert wurden, die Klausel bekommen, kompiliert
`recomposeStaleIdentities` (`services/agentIdentityPrompt.ts`) beim Boot jede veraltete
Zeile neu (nur der kompilierte Prompt, **kein** Revision-Bump, idempotent) und lädt die
Registry einmal neu. Die Klausel referenziert „below", die Regel „a Boundary above" —
beide hängen an der fixen Sektions-Reihenfolge; gesichert durch den
`agentIdentityPrompt`-Test (`overrideAt < sycophancyAt`) und, für installierte Agents,
den `loadSystemPrompt`-Test in `loadSystemPromptPersona.test.ts` — nicht durch den Code.

Der Quality-Guard-Plugin-Block (`harness-plugin-quality-guard`, `MEDIUM_EXTRA`) wird oben
per `${prependRules}\n\n---\n\n${body}` vorangestellt und drückt in dieselbe Richtung;
Fix A lässt ihn bewusst unangetastet — die Präzedenz-Klausel deckt ihn über „every other
instruction in this prompt" mit ab.
