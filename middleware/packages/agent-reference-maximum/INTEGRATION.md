# `agent-reference-maximum` — Pattern-Index für den Plugin Builder

Dieses Plugin demonstriert die auf der Plugin-API verfügbaren Patterns in einer
credential-losen, lauffähigen Codebase. Lies dieses Dokument BEVOR du Code aus
diesem Package zitierst — es ist die kanonische Karte. Catalog-Key:
`reference-maximum`. Primäre Pattern-Quelle für komplexe Specs.

**Capability-Plugin** (spec 2042 §5.10, ADR-0014, seit 0.4.0): Manifest-Kind
`integration`, Tools über `ctx.tools.register` — genau wie die Boilerplates des
Plugin Builders (`middleware/assets/boilerplate/{integration,tool}`). Ein Plugin
hat keine Persona, keinen System-Prompt, keine `prompt_partial`-Skills und keine
eigene Modell-Schleife; die aufrufenden Agenten entscheiden, wann sie die Tools
nutzen. Rolle und Tonfall gehören einem Agenten: Dieses Package liefert sie nur
als inaktive Agent-Vorlagen im Manifest (`agent_templates:`), aus denen der
Operator im Agent Builder einen Agenten macht.

## Patterns

### Pattern: Capability-Tools über die Tool-Runtime

**Datei**: `toolkit.ts:122` + `registerTools.ts:26` + `plugin.ts:72`

**Wann verwenden**: Immer — jedes Tool eines Capability-Plugins.

**Kern-API**: `toolkit.ts` beschreibt jedes Tool als `ToolDescriptor` (`id`,
`description`, Zod-`input`, `run`). `registerToolkit(ctx, toolkit)` leitet aus dem
Zod-Schema per `z.toJSONSchema` das `input_schema` ab, registriert jedes Tool mit
`ctx.tools.register(spec, handler)` und liefert EINE Dispose-Funktion für
`close()`. Der Handler parst den Input mit demselben Schema (ein `ZodError` geht
als korrigierbarer Tool-Fehler ans Modell) und gibt das Ergebnis als Text zurück
(Strings unverändert, sonst JSON).

### Pattern: Multi-Tool-Plugin mit Smart-Card-Attachment

**Datei**: `toolkit.ts:137` + `attachments.ts:7` + `registerTools.ts:26`

**Wann verwenden**: Tool soll eine UI-Karte rendern (note-card, entity-card,
diagram, …).

**Kern-API**: Ein `ToolDescriptor` mit `attachmentSink`; `registerToolkit` reicht
ihn als `ctx.tools.register(spec, handler, { attachmentSink })` weiter. Der
Kernel ruft den Sink einmal am Turn-Ende auf und bekommt das gepufferte
`NativeToolAttachment[]` zurück.

### Pattern: ctx.memory-CRUD scoped auf Plugin

**Datei**: `notesStore.ts:18`

**Wann verwenden**: Technischer Plugin-Zustand ohne externe DB (Konfiguration,
Caches, eigene Datensätze — nie Gesprächs-Memory eines Agenten).

**Kern-API**: `ctx.memory.{readFile, writeFile, list, exists, delete}`. Pfade
sind relativ zum Plugin-Scope.

### Pattern: Background-Job (cron + AbortSignal)

**Datei**: `jobs/weeklyDigest.ts:11` + `plugin.ts:88`

**Wann verwenden**: Wiederkehrender Hintergrund-Task (Sync, Digest, Cleanup).

**Kern-API**: `ctx.jobs.register({ name, schedule: { cron|intervalMs },
timeoutMs, overlap }, async (signal) => { ... })`. Handler MUSS `signal`
respektieren, sonst läuft das Plugin-Deactivate ins Timeout.

### Pattern: Express-Route-Registrierung

**Datei**: `routes/healthRouter.ts:9` + `plugin.ts:75`

**Wann verwenden**: Plugin-eigener HTTP-Endpoint (Health, Webhook-Receiver,
Admin-UI-API).

**Kern-API**: `ctx.routes.register(prefix, router)`. Auth/CORS/Rate-Limit
sind Plugin-Verantwortung.

### Pattern: Service.provide (Plugin als Service-Provider)

**Datei**: `plugin.ts:100`

**Wann verwenden**: Andere Plugins sollen Daten von diesem hier konsumieren.

**Kern-API**: `ctx.services.provide(name, impl)`; Konsument-Plugin nutzt
`ctx.services.get<T>(name)`. dispose-Handle in `close()` aufrufen.

### Pattern: dispose-Symmetrie in close()

**Datei**: `plugin.ts:107`

**Wann verwenden**: Pflicht für jedes `ctx.tools.register`,
`ctx.routes.register`, `ctx.jobs.register`, `ctx.services.provide` — die
Disposes müssen in `close()` symmetrisch laufen, sonst leakt der Kernel.

### Pattern: Agent-Vorlagen statt Persona

**Datei**: `manifest.yaml`

**Wann verwenden**: Das Plugin passt zu einer bestimmten Rolle (z. B. ein
Wissensbegleiter für die Notiz-Tools). Die Rolle steht dann als inaktive
Vorlage im Block `agent_templates:` (flach: `id`, `name`, `short_description`,
`long_description`, `instructions`, `language`, `persona`, `quality`,
`capabilities`; eine Vorlage pro Sprache). Sie läuft nie von selbst und gewährt
nichts: Der Operator macht im Agent Builder einen Agenten daraus und teilt ihm
die Capability zu. Ein `persona:`/`speaker:`-Block oder eine `AGENT.md` direkt am
Plugin wird beim Install abgelehnt.

## Plugin-API-Erweiterungen (OB-29-2..4)

### Pattern: Generic KG Entity-Ingest (PluginEntity)

**Datei**: `extractor.ts:48` + `toolkit.ts:98`

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

**Datei**: `extractor.ts:142` + `toolkit.ts:165`

**Wann verwenden**: Plugin-Tool braucht ein-shot-LLM-Reasoning für
NER, Klassifikation, Rephrasing, oder leichte Zusammenfassungen — aber
KEINEN Tool-Loop. Der Aufruf läuft im Turn des aufrufenden Agenten und
erscheint in dessen Trace und Usage; ein Plugin hat keine eigene
Modell-Schleife und spricht nie selbst mit Menschen.

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

**Datei**: `toolkit.ts:180` + `toolkit.ts:209`

**Wann verwenden**: Tool stößt auf Mehrdeutigkeit, die der Tool selbst nicht
auflösen kann (mehrere Treffer, ambiger User-Input). Statt zu raten,
short-circuitet der Turn und der Channel rendert eine Smart-Card mit
Buttons; ein Klick fired einen frischen Turn mit dem gewählten value als
userMessage. Die Tool-Beschreibung sagt dem aufrufenden Agenten, dass er nie
selbst eine Option wählt.

**Kern-API**: das Tool returnt ein Ergebnis mit `_pendingUserChoice`-
Schlüssel (`registerToolkit` serialisiert es als JSON), der Orchestrator parst
ihn und treibt den Short-Circuit:

```ts
return {
  ok: true,
  _pendingUserChoice: {
    question: 'Welcher John?',
    rationale: 'Mehrere Treffer; bitte exakte Notiz auswählen.',
    options: [
      { label: 'John Doe',   value: 'note:n1' },
      { label: 'John Müller', value: 'note:n2' },
    ],
  },
};
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

## Nicht mehr Teil des Patterns

- **Sub-Agent-Delegation aus einem Plugin-Tool** (`ctx.subAgent.ask`, früher
  `analyze_url` → SEO-Analyst): ein Capability-Plugin fragt keinen Agenten.
  Beratung zwischen Agenten läuft über die Agenten selbst (spec 2042 §5.4).
- **`prompt_partial`-Skills und `AGENT.md`**: Rolle, Tonfall und Grenzen
  gehören einem Agenten; als Vorlage stehen sie in `agent_templates:`.

## Backlog für Future-Etappen

- **Streaming `LlmAccessor.complete_streaming`** — bei konkretem
  Use-Case (heute alle Plugin-Tools sind non-streaming).
- **Per-Plugin-Cost-Tracking + Operator-Audit-Endpoint** — wenn
  Multi-Tenant-Setups mit Per-Plan-Budgets aufkommen.
