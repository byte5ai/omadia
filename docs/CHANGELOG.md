# CHANGELOG

Rolling chronologische Chronik aller signifikanten Änderungen an `odoo-bot`. Jeder Agent fügt **einen Eintrag pro abgeschlossene Aufgabe** an, bevor die Aufgabe als fertig gilt. Siehe [`/AGENTS.md`](../AGENTS.md) für die Policy.

Format: umgekehrt chronologisch, neueste oben. Jeder Eintrag: Datum + Kurz-Titel + Kontext + Wirkung + berührte Dateien/Secrets + offene Folge-Punkte.

---

## 2026-04-19 — Session-Wrap-Up: Graph-RAG, Topic-Detection, Performance

Mehrere Deploy-Runden an einem Tag. Konsolidierte Zusammenfassung der Folge-Deployments nach dem ursprünglichen Diagramm/Fly-Rollout:

### Features live in Prod

**Topic-Detection + In-Memory-Conversation-History** (→ behebt Follow-up-Verwirrung):
- `ConversationHistoryStore` hält per `sessionScope` die letzten 10 Turns als echte `messages[]`-Pairs. Orchestrator injiziert sie vor dem aktuellen User-Prompt — kein Retrieval-Query, keine Race.
- Ursprünglicher Bug: `sessionLogger.log` war fire-and-forget → Follow-up rannte los bevor Turn 1 im Graph stand → Retriever lieferte `tail=0` → Bot halluzinierte (Q1 2026 statt 2025).
- `TopicDetector` (Ollama Cosine + Haiku-Klassifier + Adaptive-Card-Rückfrage bei Ambiguity). Thresholds 0.55/0.15. Warp-Style User-Prompt bei mittlerer Konfidenz.

**Graph-RAG-Evolution**:
- **Phase C**: Turn-Embeddings via Ollama `nomic-embed-text` in pgvector(768) mit HNSW-Index. `searchTurnsByEmbedding` mit Cosine + `minSimilarity`. Retriever versucht Vector-first, Fallback auf FTS.
- **Phase A (minimal)**: Aggregat der CAPTURED-Entity-Neighbors aus Vector-Hits im System-Prompt.
- **Phase B**: `OdooEntitySync` lädt alle 6 h `res.partner`, `hr.employee`, `hr.department`, `account.journal` in den Graph (574 Partner, 28 Employees, 13 Departments, 31 Journals in Prod). HR-Fields red-line-scrubbed im Sync. `ConfluenceEntitySync` analog (off by default).
- **`query_knowledge_graph`** um `search_turns` (FTS) + `search_turns_semantic` (Embedding) erweitert — **Bug-Fix**: bisher konnte der Orchestrator Turn-Text gar nicht durchsuchen, nur Entity-Namen. Signifikanter Recall-Boost.
- **Fact-Extractor** (Haiku, fire-and-forget nach Turn): extrahiert subject-predicate-object-Tripel → `Fact`-Nodes mit `DERIVED_FROM` + `MENTIONS`-Edges.
- **`query_graph`-Sub-Agent-Tool** (aktuell live): Sub-Agents nutzen scope-gelockten Graph-Lookup für stabile Stammdaten → eliminiert Odoo-Round-Trips für `res.partner`/`account.journal`/`hr.employee`/`hr.department`/`account.account`/`res.currency`.

**Performance-Tuning**:
- `ORCHESTRATOR_MODEL` + `SUB_AGENT_MODEL` auf `claude-sonnet-4-6` (war Opus) → ~60 % Latenz-Reduktion pro LLM-Call.
- **Prompt-Caching auf Tool-Specs** im Orchestrator + LocalSubAgent (`cache_control: ephemeral` auf letztem Tool) → TTFT ab iter 2.
- **Odoo-Response-Cache** für stabile Lookups (`account.journal`, `account.account`, `hr.department`, `res.currency`, alle `fields_get`). 5-min-TTL. Defense-in-Depth zum Graph-First-Pfad.
- **Ollama-Sidecar-Scale**: shared-cpu-1x → shared-cpu-2x / 2 GB (nach beobachteten 30 s Timeouts unter parallel load).
- **Kroki-Sidecar-Scale**: shared-cpu-1x / 1 GB → shared-cpu-2x / 2 GB (analog, PlantUML-JVM + Vega-Lite-Node brauchten es).
- **Turn-Embedding-Backfill-Script** für bestehende Turns (67 von 74 erfolgreich; die 7 verbleibenden sind sehr lange GuV-Turns — Ollama-Context-Limit).

### Infrastruktur-Stand

| Komponente | Fly-App | Grösse |
|---|---|---|
| Middleware | `odoo-bot-middleware` (Frankfurt) | shared-cpu-1x, 512 MB |
| Kroki Gateway | `odoo-bot-kroki` (flycast-only) | shared-cpu-2x, 2 GB |
| Kroki Mermaid | `odoo-bot-kroki-mermaid` (flycast-only) | shared-cpu-2x, 2 GB |
| Ollama | `odoo-bot-ollama` (flycast-only) | shared-cpu-2x, 2 GB, 3 GB-Volume |
| Tigris-Bucket | `byte5-odoo-bot-diagrams-prod-2` | 90 Tage Lifecycle |
| Neon Postgres | Frankfurt, pgvector | — |

### Operational Learnings (neu + konsolidiert)

1. **Fly droppt stdout INFO unter Load**. Alle produktiv wichtigen Log-Zeilen auf `console.error` (stderr). Beobachtet bei `[context]`, `[topic]`, Boot-Ready-Lines.
2. **Sub-Agents brauchen eigenen Graph-Zugriff**. Orchestrator-Tool `query_knowledge_graph` hilft dem Sub-Agent nicht — der hat sein eigenes Tool-Set und weiß nichts vom Graph, solange er kein explizites Tool bekommt. Lösung: `createGraphLookupTool(scope)` pro Sub-Agent.
3. **Teams' `aadObjectId` kann innerhalb eines Threads variieren** (`328d16de-…` vs. `72e41d28-…` im selben Chat beobachtet). Betrifft jeden user-scoped Retrieval-Filter; `sessionScope` ist stabiler als `userId`.
4. **Fly 6PN ist IPv6-only**. Dual-stack-bind nötig (`[::]:PORT`); v4-only bind produziert ECONNRESET zwischen Apps.
5. **`fly deploy` allokiert public IPs automatisch** — danach `fly ips release <addr>` für flycast-only Apps. Dauert ~1 min bis sie wirklich weg sind.
6. **`.flycast` DNS braucht `[[services.ports]]`-Block mit Handlern**. Ohne → `.internal` nehmen (direktes 6PN zur Machine, kein Load-Balancer, schneller aber kein HA-Failover).
7. **Kroki `KROKI_COMMAND_TIMEOUT` braucht Zeit-Einheit** — `30s`, nicht `30000`. Sonst crasht der Boot.
8. **shared-cpu-1x/1 GB reicht nicht für LLM-adjacent Sidecars**. Kroki, Ollama beide auf 2x/2 GB gebracht.
9. **Tigris-Bucket-Name-Reuse nach destroy** ist minutenlang geblockt. Anderen Namen nehmen ist schneller als warten.
10. **Prompt-Priorität**: Kontext-Block muss **vor** dem stable System-Prompt stehen, sonst dominieren Memory-Regeln wie „vor jeder Antwort `_rules` lesen" den Verbatim-Tail.
11. **In-Memory-History > Graph-Retrieval für Follow-up-Kohärenz**. Der Graph bleibt Source-of-Truth für Cross-Chat + Persistenz; Single-Chat-Continuity lebt im Process.

### Offene Baustellen (für nächste Session)

**High-Value:**
- **Phase D** (Edge-Typen `INVOICE_OF`, `WORKS_ON`, `PART_OF`, `RELATED_TO` + Auto-Mining aus Odoo-Tool-Results + `traverse`/`path`-Query-Tool)
- **account.account + res.currency** im `OdooEntitySync` aufnehmen (aktuell via Zufall im Graph weil im Chat erwähnt)
- **Confluence-Sync aktivieren** (Code steht, `CONFLUENCE_ENTITY_SYNC_ENABLED=false`)
- **Turn-Embedding-Backfill v3** für die 7 verbleibenden Long-Text-Turns (Chunking-Strategie statt single-call)

**Operational:**
- **Delete-Detection im Sync** — gelöschte Partner/Employees bleiben als stale Nodes
- **`tenantId` aus Teams-Activity in `TurnContextValue`** (aktuell statisch `byte5` aus Env)
- **Mermaid-Cold-Start-Warmup-Probe** beim Gateway-Boot (erster Call braucht >30 s)
- **Rate-Limit für `render_diagram`** pro User/Turn
- **`copy-build-assets.mjs`** erweitern, damit `setup-tigris-lifecycle.ts` im Runtime-Image liegt (aktuell Inline-`.cjs` via `fly ssh sftp`)

**Quality/Monitoring:**
- Monitoring/Alert auf Kroki + Ollama-Apps (aktuell nur Fly-native Health-Checks)
- Security-Review der gesamten Stack (Kroki flycast-only ✓, Tigris signed-URLs ✓, Ollama flycast-only ✓, Fly-Secrets ✓, Graph-Scope-Filter ✓ — Dokumentation fehlt)

**Frontend:**
- Diagrams + Fact-Nodes + query_graph im Web-Dev-UI sichtbar machen (`/dev/graph`-Explorer)

### Verifikations-Prompts für die nächste Session

Um zu bestätigen dass alles läuft:

```
1. "Welche Buchungs-Journale haben wir?"
   → Erwartet: Sub-Agent-`query_graph` (≤10 ms), KEIN `odoo_execute`.

2. "Zeig mir einen Mermaid-Flow: Angebot → Bestellung → Rechnung"
   → Erwartet: `render_diagram` attach=1, Kroki <1 s.

3. "Haben wir schon mal über Mahnwesen oder überfällige Posten gesprochen?"
   → Erwartet: `search_turns` oder `search_turns_semantic`, findet 6+10+3 Turns.

4. "Was meldet die Unternehmensampel für Q1?" (gleicher Chat)
   → Erwartet: Topic-Detector ggf. ask oder continue; baut auf vorherigen Turn auf.
```

---

## 2026-04-19 — Graph-RAG-Evolution Phase C + A + B

**Kontext**: Der Knowledge-Graph speicherte bis dato nur Turns + Entity-Refs aus Tool-Calls. Embeddings-Spalte existierte seit 0001, war aber `vector(1536)` und leer. `ContextRetriever.loadFtsHits` nutzte `plainto_tsquery` ausschließlich — lexikalisches Matching, kein Synonym-Recall. Entity-Lookup (`findEntityCapturedTurns`) fand nur Dinge, die irgendwann in einem Turn erwähnt wurden — Stammdaten blieben unsichtbar bis zur ersten Chat-Erwähnung.

**Wirkung**: Drei Stufen, alle live:

**Phase C — Turn-Embeddings + pgvector**:
- Migration `0005_turn_embeddings_768.sql`: `DROP + ADD vector(768)` + HNSW-Index (cosine).
- `NeonKnowledgeGraph.ingestTurn` embeddet nach Commit fire-and-forget via Ollama; Ergebnis wird in `embedding`-Spalte geschrieben. Failures nur geloggt, blockieren ingest nie.
- Neue Interface-Methode `searchTurnsByEmbedding(queryEmbedding, …)` → pgvector `<=> cosine` mit `minSimilarity`-Filter (default 0.3) + `overshoot` → `limit`-Trimming, damit Filter-Drop den Topk nicht verhungern lässt.
- `ContextRetriever.loadFtsHits` embeddet Query via Ollama, versucht Vector-Search first, fällt auf FTS zurück bei Fehlschlag oder 0 Hits — das behält lexikalisches Matching als Safety-Net für spezifische IDs/Namen.
- Nebenstand: `vectorLiteral` helper serialisiert numeric[] zum pgvector-`::vector`-Cast (das `@neondatabase/serverless` bietet keinen binary-vector-encoding).

**Phase A — Entity-Aggregat aus Vector-Hits (minimal)**:
- `ContextRetriever` sammelt nach Vector-Hits die CAPTURED-neighbor Entities (OdooEntity, ConfluencePage) via `graph.getNeighbors`, dedupt sie, rendert als eigenen Block `## Entitäten aus diesen semantisch verwandten Turns` (displayName + system:model:id).
- `ContextBuildResult.sources` erweitert um `relatedEntities: GraphNode[]`.
- `renderContext` hat eine neue Sektion dafür, mit eigenem Budget-Check — rest bleibt unverändert.

**Phase B — Proaktive Odoo-Entity-Sync**:
- Neuer Service `OdooEntitySync` (`services/odooEntitySync.ts`) mit `syncAll()` + Per-Modell: `syncPartners`, `syncEmployees`, `syncDepartments`, `syncJournals`.
- Pro Modell batched `search_read` (page=100, cap=5000), mapped zu `EntityIngest`-Records, `graph.ingestEntities` upsertet.
- HR holt nur public-domain Felder: `name, work_email, work_phone, job_title, department_id` — nie `wage`, `identification_id`, `private_street/phone/email`, `bank_account_ids`. Defense-in-depth zum bestehenden odooCore Red-Line-Enforcement.
- Partner filter: `active=true AND (customer_rank>0 OR supplier_rank>0)` — überspringt bloße Adressbuch-Kontakte.
- Scheduler: `setTimeout(initial, jitter 0–30s)` + `setInterval(every N hours)` mit `timer.unref()`. Fails soft — pro Modell isoliertes try/catch, eine Odoo-Hüststler-Response blockiert die anderen Modelle nicht.
- Neue Interface-Methode `KnowledgeGraph.ingestEntities(entities): Promise<EntityIngestResult>` mit `inserted`/`updated`-Counts. NeonKnowledgeGraph + InMemoryKnowledgeGraph beide implementiert. Neue `EntityIngest`-Type mit `system, model, id, displayName?, extras?`.
- Feature-Flag per Env: `ODOO_ENTITY_SYNC_ENABLED` (default `false`), `ODOO_ENTITY_SYNC_INTERVAL_HOURS` (default 6), `_PAGE_SIZE` (100), `_MAX_PER_MODEL` (5000). Auf Fly über `fly secrets set ODOO_ENTITY_SYNC_ENABLED=true` aktiviert.

**Infrastruktur**:
- `compose.yml` um Ollama-Service + `ollama-init` erweitert (pullt `nomic-embed-text` 274 MB beim ersten Start, persistiert in `ollama-data`-Volume).
- `ollama/fly.ollama.toml` → `odoo-bot-ollama` Fly-App (shared-cpu-1x, 1 GB, 3-GB-Volume, flycast-only, `OLLAMA_KEEP_ALIVE=24h`).
- Middleware-Secret `OLLAMA_BASE_URL=http://odoo-bot-ollama.internal:11434`.

**Observability**:
- Alle neuen Log-Lines auf `console.error` (stderr) — Fly droppt stdout-INFO unter Load.
- `[graph] embedded turn uuid=… dims=768` nach jedem Ingest.
- `[context:inner] …` und `[context] built …` für Retrieval-Debugging.
- `[odoo-sync] done partners=read=X/ingested=Y/ins=Z/upd=W/skip=V employees=… departments=… journals=… took=…ms` pro Pass.

**Fliegen-Gotcha (noch offen, dokumentiert)**: `[graph] backfill failed: Cannot use a pool after calling end on the pool` erscheint sporadisch beim lokalen tsx-watch-reload — Neon-Pool wird vor dem Graceful-Shutdown geschlossen. Produktion ist nicht betroffen (keine watch-Reloads).

**Dateien**:
- Neu: `middleware/src/services/graph/migrations/0005_turn_embeddings_768.sql`, `services/embeddingClient.ts`, `services/topicDetector.ts`, `services/odooEntitySync.ts`, `ollama/fly.ollama.toml`.
- Geändert: `services/graph/neonKnowledgeGraph.ts` (+embedding-ingest, +`searchTurnsByEmbedding`, +`ingestEntities`, +`vectorLiteral`-helper), `services/inMemoryKnowledgeGraph.ts` (Interface-Konsistenz), `services/knowledgeGraph.ts` (Interface-Erweiterungen), `services/contextRetriever.ts` (Vector-first + related-entities), `services/graph/index.ts` (EmbeddingClient-Option), `src/index.ts` (Hoisting, Sync-Scheduler), `src/config.ts` (Env-Schema), `.env.example`, `compose.yml`.

**Tests**: 135/135 grün (inkl. `embeddingClient.test.ts`, `topicDetector.test.ts`, `topicAskCard.test.ts`).

**Offen**:
- Phase-A-voll: semantic entity lookup als eigene Graph-Methode (statt Aggregat aus Turn-Hits), damit Entities, die nur in alten FTS-gematchten Turns auftauchten, auch per Embedding-Similarity gefunden werden.
- Weitere Edge-Typen (`INVOICE_OF`, `WORKS_ON`, …) + Cross-Entity-Traversal-Query-Tool.
- Structured-Fact-Extraction via Haiku-Klassifikator nach jedem Turn.
- Confluence-Sync (aktuell nur Odoo).

---

## 2026-04-19 — Follow-up-Kohärenz: In-Memory Conversation-History

**Kontext**: Live in Prod beobachtet, dass Follow-up-Fragen im selben Teams-Chat („Das Ganze bitte bereinigt ohne Gutschriften") den vorherigen Turn nicht mehr erreichten. Bot sprang auf Accounting-Ampel-Konvention zurück und halluzinierte andere Zeiträume (Q1 2026 statt 2025).

**Root-Cause-Kette (logs zeigten tail=0 trotz persistiertem Turn im Graph)**:
1. Race: `sessionLogger.log()` war fire-and-forget → Follow-up rannte los, bevor Turn 1 im Neon-Graph stand. Der Verbatim-Tail-Retriever fand nichts.
2. Prompt-Priorisierung: „Vor jeder fachlichen Antwort /memories/_rules lesen" zwang den Bot ins Memory-Read vor dem Kontext-Block-Lesen. Ampel-Konvention gewann.
3. Graph-Retrieval via `getSession(scope)` lieferte für manche Conversations auch nach Persist `tail=0` — exakte Ursache (Scope-Encoding, Tenant-Mismatch, oder anderer UserID-Pfad) noch nicht final isoliert.
4. Teams liefert für denselben Thread teils wechselnde `aadObjectId` (beobachtet: `328d16de-…` vs. `72e41d28-…`) — falls der Retriever künftig doch userId-gefiltert wird, ist das ein weiterer Stolperstein.

**Wirkung (Fix)**: Neue schlanke In-Memory-`ConversationHistoryStore` (per Session-Scope, Ringbuffer 10 Turns, 2 h TTL, LRU-Eviction, 500 Scopes cap). Der `TeamsBot` liest die History vor jeder Orchestrator-Invocation und hängt sie nach Erfolg an. Im Orchestrator werden `priorTurns` als **echte `messages[]`-Pairs** (user+assistant) vor der aktuellen User-Message injiziert — das ist der Standard-Weg für Chat-History und umgeht den Graph-Retriever komplett für Single-Chat-Follow-ups.

**Was der Graph-Retriever weiterhin tut** (nicht geopfert!):
- Cross-Chat-Kontext: Entity-Hits + FTS-Hits aus anderen Chats des Users
- Persistenz als Source-of-Truth über Restarts hinweg
- Fallback für Scenarios, wo In-Memory-History leer ist (Cold-Boot, Turn direkt nach Deploy)

**Live-Verifikation** (Teams-Probe 2026-04-19 12:04–12:05):
```
12:04:03  [teams] turn start  history=0     ← Turn 1 "Umsatz 2025"
12:04:37  [diagrams] rendered kind=vegalite 26857B
12:04:42  [teams] turn done   history=1 attach=1
12:05:08  [teams] turn start  history=1     ← Turn 2 sieht Turn 1 als messages[]
```
Folge-Turn referenziert jetzt 2025 korrekt statt Ampel/2026.

**Dateien**: `middleware/src/services/conversationHistory.ts` (neu), `middleware/src/services/orchestrator.ts` (`priorTurns` in `ChatTurnInput`, Injection in `chatInContext` + `chatStream`), `middleware/src/services/teamsBot.ts` (constructor nimmt Store, `turn start`+`turn done`-Logs mit `history=N`), `middleware/src/index.ts` (`new ConversationHistoryStore()` + Injection in `TeamsBot`), `middleware/test/conversationHistory.test.ts` (7 Tests — LRU nutzt monotonic counter statt `Date.now()`, sonst flaky bei <1 ms back-to-back Ops).

**Zwischen-Fixes, die wir auf dem Weg gemacht haben** (alle in Prod v26-v29 deployed, behalten):
- `sessionLogger.log` `await` statt fire-and-forget (orchestrator.ts)
- Prior-Context-Block **vor** stable system prompt (umgeht Prompt-Dominanz durch Memory-Regeln)
- Memory-Read-Regel: nur bei neuer Domäne, nicht bei Follow-ups
- `[context] built …` + `[context:inner] …` via `console.error` (stderr), weil Fly einige stdout-INFO-Lines droppt
- Tool-Use-Digest (unsichtbarer HTML-Kommentar) in persistierter assistantAnswer, damit Graph-basierte Fallback-Retrieval sieht „hier wurde ein Chart gerendert"

**Offen** (Follow-up-Tasks):
- Root-Cause `tail=0` im Graph-Retrieval isolieren: Neon-Query-Debugging, ob Scope-String mit Sonderzeichen (`:`, `@`, `.`) korrekt gespeichert/abgefragt wird. Aktuell nicht blockierend, weil In-Memory-History die Follow-up-Kohärenz trägt.
- Teams `aadObjectId`-Wechsel untersuchen (warum zwei IDs für dieselbe conv?).
- In-Memory-History ist per-Instance — bei Fly-Rolling-Restart oder Multi-Machine-Scale-out gehen die letzten Turns verloren bis Graph-Backfill sie zurückholt. Für byte5 mit `min_machines_running=1` irrelevant.

---

## 2026-04-19 — Fly-Deployment: Diagramm-Feature in Prod

**Kontext**: Nach lokaler Verifikation (compose + smoke) Rollout des vollen Kroki+Tigris-Stacks auf Fly.

**Wirkung**: Die Middleware erzeugt und liefert jetzt in Prod Adaptive-Card-Images in Teams + dem Web-Dev-UI — Mermaid/PlantUML/Graphviz/Vega-Lite, alle vier.

**Live-Stand**:
- `odoo-bot-kroki` Fly-App: shared-cpu-2x, 2 GB, flycast-only, Gateway für PlantUML/Graphviz/Vega-Lite.
- `odoo-bot-kroki-mermaid` Fly-App: shared-cpu-2x, 2 GB, flycast-only, Companion mit headless Chromium.
- Tigris-Bucket: `byte5-odoo-bot-diagrams-prod-2`, 90-Tage-Lifecycle-Rule aktiv.
- Middleware v23+ deployed, Log-Zeile `[middleware] render_diagram tool ready (kroki=http://odoo-bot-kroki.internal:8000, bucket=byte5-odoo-bot-diagrams-prod-2)`.

**Rabbit-Holes, die wir durchgelaufen sind** (für zukünftige Prod-Kroki-Deployments):
1. **Public IPs automatisch allokiert**: `fly deploy` setzt default-public-v4+v6, auch wenn `fly.toml` keinen `[[services.ports]]`-Block hat. Nachträglich via `fly ips release <addr>` entfernen. Für .flycast-only App ist das zwingend.
2. **`.flycast`-DNS scheitert ohne Port-Handler**: `[[services]]` + `internal_port` reicht, aber Flycast routet HTTP nur mit `[[services.ports]]` + `handlers`. Wir nutzen stattdessen `.internal` (Direkt-DNS zur Machine), reicht für Single-Org-Pattern, einfacher, schneller.
3. **6PN ist IPv6-only**: `KROKI_LISTEN=0.0.0.0:8000` (v4-only) führt zu ECONNRESET auf Fly. Fix: `KROKI_LISTEN=[::]:8000` (dual-stack).
4. **Kroki-Command-Timeout hardcoded 5s**: `KROKI_COMMAND_TIMEOUT` env-var setzt das hoch, erwartet aber **Zeit-Einheit** (`30s`, nicht `30000`). Sonst crasht der Gateway beim Boot.
5. **PlantUML/Vega-JVM-Warmup braucht Zeit**: auf shared-cpu-1x / 1 GB überschreitet der erste Call das interne 5s-Timeout. Fix: `shared-cpu-2x` + 2 GB + `KROKI_COMMAND_TIMEOUT=30s`.
6. **Chromium im Companion braucht RAM + CPU**: 512 MB produzierte crashpad/DBus-Errors und HttpClosedException. Fix: `shared-cpu-2x` + 2 GB.
7. **Mermaid Cold-Start**: Erster Call nach VM-Restart braucht >30s (Chromium-Launch). Zweiter und folgende < 1s. Mit `min_machines_running=1` trifft das max. einmal pro Deploy.
8. **Tigris-Bucket-Name-Reuse**: Nach `fly storage destroy` ist der Name für >1 min blockiert. Workaround: anderer Name (`…-prod-2`) statt warten.
9. **Tigris-Creds bei `fly storage create` in stdout**: Wenn Output in den Chat fließt, müssen die Creds rotiert werden. Saubere Rotation = destroy + wait + recreate mit anderem Namen + Secrets inline piped (Werte nie in stdout).
10. **Lifecycle-Script**: Scripts unter `middleware/scripts/` landen nicht im Runtime-Image (nur `dist/` wird kopiert). Die 90d-Rule wurde per inline-`.cjs` via `fly ssh sftp` + `node` angewendet. Sauberer Follow-up: `copy-build-assets.mjs` erweitern, damit das Script im Image liegt.

**Dateien**: `kroki/fly.kroki.toml`, `kroki/fly.kroki-mermaid.toml`, `docs/diagrams.md`.

**Offen**:
- Rate-Limit für `render_diagram` pro User/Turn (heute keins).
- Mermaid-Cold-Start-Warmup-Probe in der Kroki-Gateway-Boot-Sequenz (einmaliger HTTP-Probe nach Start, damit erster echter User-Call warm trifft).
- Monitoring/Alert auf Kroki-Apps-Health (aktuell nur Fly-native Checks).
- `GRAPH_TENANT_ID` → TurnContext (statt statisch) für Multi-Tenant-Cache-Keys.

---

## 2026-04-19 — Vega-Lite Charts zum Diagramm-Tool

**Kontext**: Nutzerfrage während lokalem Testing: "Haben wir auch eine echte Diagramm-Engine? Balken/Chart etc?" Mermaid kann `pie` und `xychart-beta`, aber für Business-Charts (Bar/Line/Pie/Scatter/Area aus Fach-Agent-Zahlen) fehlte ein produktionsreifer Renderer.

**Wirkung**:
- `ALLOWED_DIAGRAM_KINDS` um `vegalite` erweitert. Vega-Lite läuft **nativ im Haupt-Kroki-Container** (kein separater Companion nötig — `yuzutech/kroki-vega` existiert nicht als Public Image, die Funktionalität ist ins Gateway gebaut).
- Orchestrator-System-Prompt + Tool-Beschreibung erklären explizit wann Vega-Lite vs. Mermaid/Graphviz/PlantUML: Vega-Lite = Charts aus Zahlen (source = vollständiger Vega-Lite-JSON-Spec als String, `data.values` inline).
- `compose.yml`: `platform: linux/amd64` auf dem Kroki-Gateway, weil Vega-Lites intern gebundelte `vl2png`-Binary x86-only ist. Andere Kinds (JVM-basiert: PlantUML, Graphviz) sind davon unbetroffen. Auf amd64-Hosts (Fly) ein No-Op.
- Smoke-Script um Bar-Chart-Sample erweitert + `RUN_TAG`-Prefix, damit MinIO-Persistenz zwischen Runs keinen false-positive Cache-Hit erzeugt.

**Verifiziert**: E2E alle 4 Formate grün (Mermaid 469ms, Graphviz 152ms, PlantUML 550ms, Vega-Lite 852ms), 107/107 Tests grün.

**Dateien**: `compose.yml`, `middleware/src/diagrams/types.ts`, `middleware/src/tools/diagramTool.ts`, `middleware/src/services/orchestrator.ts`, `middleware/scripts/smoke-diagrams.ts`.

**Offen**:
- Für Fly-Deploy: `platform: linux/amd64` entfällt (Fly-Hosts sind amd64).
- Chart-Styling: Default-Themes reichen für erste Tests; wenn byte5-Branding gewünscht → Vega-Config-Object im System-Prompt vorgeben.

---

## 2026-04-19 — Web-Dev-UI rendert Diagramm-Attachments inline

**Kontext**: Frontend (Next.js :3000) zeigte beim Diagramm-Render nur die Markdown-Antwort, nicht das PNG — Orchestrator-Attachments wurden nur im Teams-Adapter angebunden.

**Wirkung**:
- `DiagramAttachment`-Type + `Message.attachments` in `web-ui/app/_lib/chatSessions.ts`.
- `done`-Event im Stream-Typ um `attachments` erweitert, `applyEvent`-done-Fall übernimmt sie.
- Neue `AttachmentGrid`-Komponente unter der Markdown: klickbare `<img>` (öffnet Originalgröße in neuem Tab), Badge mit Format + `cached`-Hinweis.
- Browser lädt Bilder direkt von `http://localhost:3979/diagrams/...` (cross-origin für `<img>` ohne CORS-Header unproblematisch).

**Offen**: Signed-URLs laufen nach 15min ab — nach Reload alter Sessions sind Bilder broken. Polish (Refresh-Endpunkt oder UI-Hinweis "Link abgelaufen") später.

**Dateien**: `web-ui/app/_lib/chatSessions.ts`, `web-ui/app/page.tsx`.

---

## 2026-04-19 — Diagramm-Rendering via Kroki + Tigris/MinIO

**Kontext**: Agents konnten bisher nur Text antworten. Für Flows/Org-Charts/Sequenzen war visuelle Darstellung nötig. Entscheidung: self-hosted Kroki als Multi-Format-Renderer, Tigris als Object-Storage (MinIO lokal), HMAC-signierte Middleware-Proxy-URLs für Teams-Adaptive-Card-Images — keine Redirects, weil Teams-Clients ihnen nicht folgen.

**Wirkung**:
- Neuer Orchestrator-Tool `render_diagram({kind, source, title?})` — kinds: `mermaid`, `plantuml`, `graphviz` (Allowlist).
- Content-addressed Cache-Key `{tenant}/{sha256(kind+source)}.png` → Re-Renders gleicher Quelle sind 0 Kroki-Calls.
- Signierte Proxy-URL `GET /diagrams/<key>?exp=…&sig=…` mit HMAC-SHA256, TTL 15 min, `timingSafeEqual`.
- Teams Adaptive Card erweitert: `Image`-Elemente unter dem Answer-Text, max 3 pro Card, `selectAction: OpenUrl` für Lightbox-Fallback.
- **Lokal lauffähig ohne Fly**: neues `compose.yml` im Repo-Root bringt Kroki-Gateway + Mermaid-Companion + MinIO + automatische Bucket-Provisionierung inkl. 90-Tage-Lifecycle-Rule.
- E2E-Smoke-Script `npm run smoke:diagrams` verifiziert Render + Cache + signed URL + Proxy-Fetch für alle drei Formate.

**Default-Ports lokal**: Kroki Gateway `127.0.0.1:8765`, MinIO API `127.0.0.1:9000`, MinIO Console `127.0.0.1:9001`. Port 8000 wird häufig von OrbStack/anderer Dev-Tooling belegt — deswegen 8765.

**Safety Rails**:
- `KROKI_SAFE_MODE=SECURE` blockiert `!include`, Remote-Refs, File-Access.
- Quelle-Cap 64 KB, PNG-Cap 900 KB (Teams-Grenze: 1 MB).
- Attachments verlassen den Orchestrator nur über `ChatTurnResult.attachments` — strukturiert statt URL-Scraping.
- Feature bleibt sauber deaktiviert, wenn nicht alle 7 Env-Vars gesetzt sind.

**Dateien geändert/neu**:
- `compose.yml` (neu, Repo-Root)
- `middleware/src/diagrams/` (neu: `types.ts`, `cacheKey.ts`, `signing.ts`, `krokiClient.ts`, `tigrisStore.ts`, `diagramService.ts`, `index.ts`)
- `middleware/src/routes/diagrams.ts` (neu)
- `middleware/src/tools/diagramTool.ts` (neu)
- `middleware/src/services/orchestrator.ts` — neue `diagramTool`-Option, `DiagramAttachment`-Typ, `drainAttachments()`, System-Prompt-Block, `buildToolsList` + `dispatchTool` erweitert
- `middleware/src/services/teamsBot.ts` — Attachments durchgereicht, Fallback-Answer wenn Text leer
- `middleware/src/services/teamsCard.ts` — `Image`-Elemente im Card-Body (bis zu 3)
- `middleware/src/config.ts` — 10 neue Env-Vars, `GRAPH_TENANT_ID` ergänzt
- `middleware/src/index.ts` — bedingte DiagramService + Router-Wire
- `middleware/scripts/smoke-diagrams.ts` (neu)
- `middleware/package.json` — `@aws-sdk/client-s3`, neues `smoke:diagrams`-Script
- `middleware/.env.example` — 7 neue Variablen + lokale Defaults
- `middleware/test/{diagramSigning,diagramService,diagramsRouter,diagramTool,teamsCardImage}.test.ts` (neu, 26 Tests)

**Secrets**:
- `DIAGRAM_URL_SECRET` — pro Env frisch via `openssl rand -hex 32`; lokal bereits in `.env` gesetzt, für Fly später write-only über `fly secrets set`.
- Kroki-Apps + Tigris-Bucket auf Fly noch nicht provisioniert — das passiert in einer separaten Deploy-Aufgabe (siehe Offen).

**Offen**:
- Deploy zweier Fly-Apps `odoo-bot-kroki` + `odoo-bot-kroki-mermaid` mit flycast-only Services.
- Tigris-Bucket via `fly storage create -a odoo-bot-middleware`, danach einmalig `PutBucketLifecycleConfiguration` (90 Tage).
- `tenantId` aus Teams-Activity in `TurnContextValue` aufnehmen, damit Cache-Keys pro AAD-Tenant getrennt sind (aktuell statisch `byte5`).
- Optional: Rate-Limit für `render_diagram` pro User/Turn.

---

## 2026-04-19 — Build-Asset-Fix für Graph-SQL-Migrations

**Kontext**: v20-Deploy crashte mit `ENOENT: … /app/dist/services/graph/migrations`. Ursache: `tsc` kopiert keine Non-TS-Assets, die drei SQL-Migrations-Files in `middleware/src/services/graph/migrations/` landeten nie im Docker-Image.

**Wirkung**: Build-Script erweitert, Docker-Context korrigiert. v21 (`deployment-01KPJE84…`) startet clean, Graph-Backfill liest 2 Scopes / 2 Files / 11 Turns / 1 Skip.

**Dateien geändert**:
- `middleware/scripts/copy-build-assets.mjs` — neu, kopiert Non-TS-Assets nach `dist/`
- `middleware/package.json` — `build`-Script: `tsc && node scripts/copy-build-assets.mjs`
- `Dockerfile` — `COPY middleware/scripts ./scripts` in Builder-Stage
- `.dockerignore` — Negation-Pattern `!middleware/scripts/copy-build-assets.mjs`

**Offen**: Pattern auf zukünftige Non-TS-Assets erweitern, wenn dazu kommen (JSON-Fixtures, `.md`-Templates, …). Aktuell nur SQL-Migrations.

---

## 2026-04-19 — Architektur-Migration: Managed Agents → Local Sub-Agents

**Kontext**: Alle drei Agents (Odoo Accounting, Odoo HR, Confluence Playbook) liefen über Anthropic Managed Agents. Delegation-Overhead + Credential-Plazierungs-Problem + fehlende echte Environment-Secrets führten zum Redesign: Sub-Agents laufen jetzt **direkt in der Middleware** als `LocalSubAgent` gegen die Messages-API.

**Wirkung**:
- Latenzen drastisch reduziert (60s statt vormals 165-195s für GuV-Query, bis zu 26ms für cached-UID Odoo-Folgecalls).
- Credentials verlassen Fly-Container nie — Odoo-Client + Confluence-Client halten Auth in-process.
- Neue Infrastruktur: `ChatSessionStore`, `EntityRefBus`, `turnContext`, `RunTraceCollector`, Neon-Postgres Knowledge Graph mit Backfill.
- Neue Endpoints: `/api/chat/sessions` für Dev-UI, `/api/dev/graph` + `/api/dev/memory` (nur lokal).
- `CLAUDE_AGENT_ID` + `CLAUDE_ENVIRONMENT_ID` aus dem Schema entfernt (waren früher required).

**Dateien geändert**: `middleware/src/services/localSubAgent.ts`, `odooClient.ts`, `odooCore.ts`, `odooToolkit.ts`, `confluenceClient.ts`, `confluenceCore.ts`, `confluenceToolkit.ts`, `knowledgeGraph.ts`, `inMemoryKnowledgeGraph.ts`, `graphBackfill.ts`, `chatSessionStore.ts`, `entityRefBus.ts`, `turnContext.ts`, `runTraceCollector.ts`, `sessionTranscriptParser.ts`, `skillLoader.ts`, `routes/chatSessions.ts`, `routes/devGraph.ts`, `routes/devMemory.ts`, `tools/knowledgeGraphTool.ts`, plus aktualisierte `config.ts`, `index.ts`, `orchestrator.ts`, `sessionLogger.ts`, `teamsBot.ts`.

**Offen**:
- Retrieval-Layer (Vector-Store + GraphRAG) — siehe `middleware-agent-handoff.md` §13.
- Dev-UI Integration mit Chat-Sessions-Endpoint.

---

## 2026-04-18 — Crashloop durch verpasste Schema-Sync (Lessons Learned)

**Kontext**: Während der Managed-Agents-Migration wurden `CLAUDE_AGENT_ID`/`CLAUDE_ENVIRONMENT_ID` aus dem Zod-Schema entfernt (neuer Code), aber die Machine hatte noch das alte Image deployed. Fly-Machine crashloopte mit `Invalid configuration: Required`, weil die Fly-Secrets diese Vars nie hatten — sie standen früher in `fly.toml [env]`, die bei der Umstellung entfernt wurden.

**Wirkung**: Production ~35 Min offline, Fly hat Machine nach mehreren Restarts in State `stopped` versetzt.

**Fix**: Neuer Deploy mit korrektem Schema. Manueller `fly machine start` nötig, weil Fly nach Crashloop nicht automatisch wieder anfährt.

**Lesson**: Schema-Änderungen MIT `.env.example`-Update + CHANGELOG in einem Schritt. Nicht splitten.

---

## 2026-04-18 — Security-Phase 2: Odoo-Migration auf Middleware-Proxy

**Kontext**: Odoo Accounting + HR liefen direkt mit Credentials im Agent-System-Prompt. Über neuen Middleware-Proxy abgelöst: `/api/internal/odoo/accounting/execute` und `/api/internal/odoo/hr/execute`.

**Wirkung**:
- Thin JSON-RPC-Passthrough mit Model/Method-Whitelist, HR-Red-Line-Field-Filter, Response-Cap 500kB, UID-Caching + Re-Auth-Retry.
- Canary: erst Accounting, dann HR. Beide Smoke-Tests erfolgreich.

**Dateien**: `docs/security-migration-plan.md` (Phase 2), `middleware/src/routes/internal.ts` (später konsolidiert in `localSubAgent` / `odooToolkit`).

**Offen**: Phase 2 durch Architektur-Wechsel auf Local Sub-Agents überholt — der Proxy lebt nicht mehr als separate HTTP-Route, sondern ist direkt der In-Process-Client. Dokumentations-Konsolidierung steht aus.

---

## 2026-04-18 — Security-Phase 1: Confluence-Proxy + Token-Rotation

**Kontext**: Atlassian-API-Token wurde beim Anlegen des Confluence-Agents versehentlich in `agent-config-confluence.yaml` geschrieben (System-Prompt). Token via Konversation an Claude API gelangt → als geleaked behandelt.

**Wirkung**:
- Alter Token revoked, neuer Token ausschließlich in Fly Secrets.
- Middleware-Route `/api/internal/confluence/*` mit server-side `space=HOME`-Scope, `expand`-Whitelist, Response-Cap 200kB, `timingSafeEqual` Token-Check.
- Skill `skills/confluence-playbook/SKILL.md` auf Proxy-Flow umgeschrieben.

**Offen**: Proxy-Architektur durch Phase 3 (Local Sub-Agents) weiterentwickelt — Confluence-Calls gehen jetzt direkt aus `ConfluenceClient` in-process, Proxy als HTTP-Surface nicht mehr benötigt.

---

## 2026-04-17 — Day-1: Initiale Produktions-Middleware

Siehe [`day-one-learnings-2026-04-17.md`](day-one-learnings-2026-04-17.md). Eingefroren — nicht anfassen.

Kurzform: Teams-Bot → Orchestrator → Managed Agents (Accounting, HR). Memory-Seed, Fly-Volumen, Dockerfile-Entrypoint mit `gosu` für Volume-Ownership.
