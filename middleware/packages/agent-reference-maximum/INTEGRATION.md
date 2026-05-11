# `agent-reference-maximum` — Pattern-Index für den BuilderAgent

Dieses Plugin demonstriert **ALLE** auf der Plugin-API verfügbaren Patterns
in einer credential-losen, lauffähigen Codebase. Lies dieses Dokument BEVOR
du Code aus diesem Package zitierst — es ist die kanonische Karte. Catalog-
Key: `reference-maximum`. Primäre Pattern-Quelle für komplexe Specs ab OB-29-5.

**OB-29 abgeschlossen** — alle Etappen 0..5 geliefert:

- 0 — Skelett + Catalog-Marker `is_reference_only: true`
- 1 — `ctx.subAgent.ask` (cross-agent delegation)
- 2 — generic `ctx.knowledgeGraph.ingestEntities` (PluginEntity namespace)
- 3 — `ctx.llm.complete` (host-paid LLM access mit Whitelist + Budget)
- 4 — tool-emittiertes `_pendingUserChoice` (Smart-Card-Short-Circuit)
- 5 — Rename + Builder-Prompt-Final-Routing (jetzt PRIMÄR-Reference)

## Patterns

### Pattern: Multi-Tool-Plugin mit Smart-Card-Attachment

**Datei**: `toolkit.ts:89` + `attachments.ts:8` + `plugin.ts:32`

**Wann verwenden**: Tool soll eine UI-Karte rendern (note-card, entity-card,
diagram, …).

**Kern-API**: `ctx.tools.register(spec, handler, { attachmentSink })`. Der
`attachmentSink`-Callback wird einmal am Turn-Ende aufgerufen und liefert das
gepufferte `NativeToolAttachment[]` zurück.

### Pattern: ctx.memory-CRUD scoped auf Plugin

**Datei**: `notesStore.ts:18`

**Wann verwenden**: Per-Agent persistente Daten ohne externe DB.

**Kern-API**: `ctx.memory.{readFile, writeFile, list, exists, delete}`. Pfade
sind relativ zum Plugin-Scope (`/memories/agents/<agentId>/`).

### Pattern: Background-Job (cron + AbortSignal)

**Datei**: `jobs/weeklyDigest.ts:11` + `plugin.ts:60`

**Wann verwenden**: Wiederkehrender Hintergrund-Task (Sync, Digest, Cleanup).

**Kern-API**: `ctx.jobs.register({ name, schedule: { cron|intervalMs },
timeoutMs, overlap }, async (signal) => { ... })`. Handler MUSS `signal`
respektieren, sonst läuft das Plugin-Deactivate ins Timeout.

### Pattern: Express-Route-Registrierung

**Datei**: `routes/healthRouter.ts:11` + `plugin.ts:58`

**Wann verwenden**: Plugin-eigener HTTP-Endpoint (Health, Webhook-Receiver,
Admin-UI-API).

**Kern-API**: `ctx.routes.register(prefix, router)`. Auth/CORS/Rate-Limit
sind Plugin-Verantwortung.

### Pattern: Service.provide (Plugin als Service-Provider)

**Datei**: `plugin.ts:72`

**Wann verwenden**: Andere Plugins sollen Daten von diesem hier konsumieren.

**Kern-API**: `ctx.services.provide(name, impl)`; Konsument-Plugin nutzt
`ctx.services.get<T>(name)`. dispose-Handle in `close()` aufrufen.

### Pattern: dispose-Symmetrie in close()

**Datei**: `plugin.ts:80`

**Wann verwenden**: Pflicht für jedes `ctx.tools.register`,
`ctx.routes.register`, `ctx.jobs.register`, `ctx.services.provide` — die
Disposes müssen in `close()` symmetrisch laufen, sonst leakt der Kernel.

### Pattern: Skill-Prompt-Partial

**Datei**: `skills/reference-expert.md` + `skills/disambiguate-policy.md`

**Wann verwenden**: Modell-Verhalten dokumentieren ohne Code-Touch.

## Plugin-API-Erweiterungen (OB-29-1..4)

### Pattern: Sub-Agent-Delegation aus Plugin-Tool

**Datei**: `toolkit.ts:108` + `plugin.ts:45`

**Wann verwenden**: Tool benötigt Domain-Wissen, das in einem anderen Agent
besser implementiert ist (z.B. SEO-Analyse, Confluence-Lookup, Odoo-
Accounting). Statt das Wissen zu duplizieren, delegiert der Tool-Handler
single-turn an den Ziel-Agent und verarbeitet dessen Antwort lokal weiter.

**Kern-API**:

```ts
const answer = await ctx.subAgent.ask(
  '@omadia/agent-seo-analyst',
  'Analysiere https://example.com aus SEO-Sicht. Top 3 Issues.',
);
// answer ist der finale Antwort-String des Sub-Agents (single-turn).
```

**Permission-Modell**: `manifest.yaml` muss `permissions.subAgents.calls`
mit der Whitelist deklarieren — sonst ist `ctx.subAgent` `undefined`.
Beispiel:

```yaml
permissions:
  subAgents:
    calls:
      - "@omadia/agent-seo-analyst"   # exakt
      - "de.byte5.agent.odoo-*"        # Wildcard, ein Segment tief
    calls_per_invocation: 3            # default 5
```

**Errors**:
- `UnknownSubAgentError` — Ziel-Agent ist im Host nicht registriert
- `SubAgentPermissionDeniedError` — Ziel nicht in Whitelist
- `SubAgentRecursionError` — `targetAgentId === ctx.agentId` (direkter Selbstaufruf)
- `SubAgentBudgetExceededError` — `calls_per_invocation` ausgeschöpft

**Lifecycle**: jede `ask()` ist single-turn — der Sub-Agent läuft seinen
internen Tool-Loop und liefert die finale Antwort zurück. Kein Session-
State zwischen Aufrufen, kein Turn-Forwarding.

### Pattern: Generic KG Entity-Ingest (PluginEntity)

**Datei**: `extractor.ts:42` + `toolkit.ts:122`

**Wann verwenden**: Plugin will Domänen-Entitäten in den Knowledge-Graph
schreiben — Personen, Topics, Notizen, Custom-Models — ohne in den
host-reservierten Namespaces (`'odoo'`, `'confluence'`) zu kollidieren.

**Kern-API**:

```ts
await ctx.knowledgeGraph.ingestEntities([
  { system: 'personal-notes', model: 'Person', id: 'john', displayName: 'John' },
  { system: 'personal-notes', model: 'Topic',  id: 'themef',  displayName: 'ThemeF' },
]);
// Schreibt 2 PluginEntity-Nodes mit external-id-Format
//   `<system>:<model>:<id>` (`personal-notes:Person:john` etc.).
```

**Permission-Modell**: `manifest.yaml` muss
`permissions.graph.entity_systems: [...]` deklarieren — ohne Eintrag ist
`ctx.knowledgeGraph` `undefined`. Reservierte System-Strings (`'odoo'`,
`'confluence'`) werden vom manifestLoader rausgestrippt.

```yaml
permissions:
  graph:
    reads: ["Turn", "Person", "Company", "Fact"]
    writes: []
    entity_systems:
      - "personal-notes"          # eigene Namespace
      - "meeting-notes"           # mehrere möglich
```

**Errors**:
- `KgEntityNamespaceError` — `ent.system` nicht in Whitelist
- `KgServiceUnavailableError` — kein `knowledgeGraph`-Provider registriert
  (in-memory oder Neon nicht installiert)

**Best-Effort-Pattern in `add_note`**: KG-Ingest läuft nach Memory-Write,
KG-Errors brechen den Tool-Flow NICHT. So bleibt das Plugin lauffähig
auch in Test-Setups ohne KG-Provider — die Notiz selbst wird immer
geschrieben, der KG-Eintrag ist optional.

**Read-Methoden**: `searchTurns`, `findEntityCapturedTurns`, `getNeighbors`,
`stats` werden ohne Namespace-Check durchgeschleust — Permission-Modell
für Reads landet in einer späteren Hardening-Etappe.

### Pattern: LLM-Service via ctx.llm.complete

**Datei**: `extractor.ts:142` + `toolkit.ts:224` + `plugin.ts:72`

**Wann verwenden**: Plugin-Tool braucht ein-shot-LLM-Reasoning für
NER, Klassifikation, Rephrasing, oder leichte Zusammenfassungen — aber
KEIN Tool-Loop (für Tool-Loops verwendet man `ctx.subAgent.ask`).

**Kern-API**:

```ts
const r = await ctx.llm.complete({
  model: 'claude-haiku-4-5-20251001',
  system: 'Du bist ein NER-Extractor. Liefere AUSSCHLIESSLICH JSON …',
  messages: [{ role: 'user', content: noteBody }],
  maxTokens: 512,        // wird gegen manifest-cap geclampt
});
// r.text ist die concatenated text-Antwort des Modells.
// r.inputTokens / r.outputTokens für Cost-Tracking.
```

**Permission-Modell**: `manifest.yaml`:

```yaml
permissions:
  llm:
    models_allowed:
      - "claude-haiku-4-5*"      # Glob-Match auf Anthropic-Versions-Suffix
      - "claude-sonnet-4-6"      # Exakt
    calls_per_invocation: 2      # default 5
    max_tokens_per_call: 1024    # default 4096; silent-clamp, kein Throw
```

**Wer pays**: der Host. Plugins bringen KEINE eigenen API-Keys mit. Die
manifest-deklarierten Limits + Whitelist sind die Cost-Bremse.

**Errors**:
- `LlmServiceUnavailableError` — Host hat keinen `'llm'`-Provider registriert
  (kein `ANTHROPIC_API_KEY` beim Boot)
- `LlmModelNotAllowedError` — `req.model` nicht in Whitelist
- `LlmBudgetExceededError` — `calls_per_invocation` ausgeschöpft

**Streaming + Caching**: v1 ist Promise-basiert (kein AsyncIterator).
`cache_control` auf Message-Blocks wird unverändert durchgeschleust —
Plugin entscheidet selbst.

**Robust-Parsing**: bei JSON-Mode-Antworten kann das Modell Markdown-Fences
oder Prosa drumherum schreiben. `extractor.ts:parseLlmExtractionPayload`
zeigt das robuste-{...}-Find-Pattern, das in jedem LLM-Plugin auftaucht.

### Pattern: Tool-emittiertes _pendingUserChoice (Smart-Card-Short-Circuit)

**Datei**: `toolkit.ts:253` + `plugin.ts:86`

**Wann verwenden**: Tool stößt auf Mehrdeutigkeit, die der Tool selbst nicht
auflösen kann (mehrere Treffer, ambiger User-Input). Statt zu raten,
short-circuitet der Turn und der Channel rendert eine Smart-Card mit
Buttons; ein Klick fired einen frischen Turn mit dem gewählten value als
userMessage.

**Kern-API**: das Tool returnt einen JSON-String mit `_pendingUserChoice`-
Schlüssel, der Orchestrator parst ihn und treibt den Short-Circuit:

```ts
return JSON.stringify({
  ok: true,
  _pendingUserChoice: {
    question: 'Welcher John?',
    rationale: 'Mehrere Treffer; bitte exakte Notiz auswählen.',
    options: [
      { label: 'John Doe',   value: 'note:n1' },
      { label: 'Jane Doe', value: 'note:n2' },
    ],
  },
});
```

**Validation**: der Orchestrator (`parseToolEmittedChoice`) prüft
defensive: question muss non-empty string sein, options muss ≥1 valider
Eintrag (`{label: string, value: string}`). Malformed payloads werden
silent ignoriert — der Tool-Result fließt dann als Plain-Text in den
nächsten Model-Turn.

**Symmetrie zu `ask_user_choice`**: das Built-in-Tool `ask_user_choice`
(orchestrator-internal) und das Plugin-Pattern hier laufen am Ende durch
denselben Short-Circuit. Channel-Adapter (Teams, web-ui) rendern beide
identisch — kein neuer Render-Pfad nötig.

**Wichtig — kein Mix mit Errors**: ein Tool-Result mit `is_error: true`
wird vom Parser ignoriert. Wenn dein Tool failed, gib eine echte
Fehler-Antwort zurück; das `_pendingUserChoice`-Pattern ist ausschließlich
für ok-Antworten.

**Submission-Order Tiebreak**: bei mehreren Tools im selben Batch, die
alle `_pendingUserChoice` emittieren, gewinnt der erste in
Submission-Order. Plugin-Code sollte sich nicht darauf verlassen — bei
Mehrfach-Choices kommt nur eine durch.

## Plugin-API-Erweiterungen aus OB-29 (alle erledigt)

- ✅ **OB-29-1 — Sub-Agent-Delegation aus Plugin**: `ctx.subAgent.ask`
  + `permissions.subAgents.calls` Whitelist + Self-Recursion-Guard +
  Per-Invocation-Budget. Pattern-Block oben.
- ✅ **OB-29-2 — Generic KG Entity-Ingest**: `EntityIngest.system: string`,
  `'PluginEntity'` GraphNodeType, `permissions.graph.entity_systems`
  Namespace-Whitelist + reservierte `'odoo'`/`'confluence'`-Strip.
  Pattern-Block oben.
- ✅ **OB-29-3 — LLM-Service-Pattern**: `ctx.llm.complete` mit
  `permissions.llm.{models_allowed, calls_per_invocation,
  max_tokens_per_call}`. Host pays — Plugins bringen keine eigenen
  API-Keys mit. Pattern-Block oben.
- ✅ **OB-29-4 — Tool-emittiertes `_pendingUserChoice`**: Plugin-Tool-
  Result-Shape `{ ok: true, _pendingUserChoice: { question, options } }`
  triggert orchestrator-seitigen Short-Circuit ohne neue Plugin-API-
  Surface. Pattern-Block oben.

## Backlog für Future-Etappen

- **Sub-Agent-Indirect-Loop-Detection** (A→B→A via AsyncLocalStorage) —
  niedrige Priorität, heutige `LocalSubAgent.maxIterations` ist
  ausreichender Backstop.
- **Streaming `LlmAccessor.complete_streaming`** — bei konkretem
  Use-Case (heute alle Plugin-Tools sind non-streaming).
- **Per-Plugin-Cost-Tracking + Operator-Audit-Endpoint** — wenn
  Multi-Tenant-Setups mit Per-Plan-Budgets aufkommen.
