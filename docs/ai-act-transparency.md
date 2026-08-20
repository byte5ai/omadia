# KI-Kennzeichnung und Provenienz (EU AI Act Art. 50)

> **Bindende Regel für dieses Dokument: keine Aussage, die nicht durch Code gedeckt ist.**
> Eine zu weit formulierte Zusage auf einer öffentlichen Seite ist schlechter als eine
> benannte Lücke. Jede Aussage unten trägt die Codestelle, aus der sie stammt. Wo etwas
> fehlt oder schwächer ist als man erwarten würde, steht das ausdrücklich da.

Dieses Dokument beschreibt, **was omadia tatsächlich markiert und was nicht**. Es ist die
Quelle für den Produktabschnitt der Transparenzseite (`omadia.ai/ai-transparency`) und die
Grundlage, auf der ein Betreiber seine eigene Lage einschätzen kann.

Umgesetzt in Epic #642: #643 (Carrier), #644 (Per-Turn-Auflösung), #645 (Office), #646
(PNG), #647 (API-/MCP-Envelope), #648 (Sichtbarkeit der Konfiguration), #650/#684
(Run-Trace).

---

## 1. Wo die Kennzeichnung ansetzt

omadia beantwortet Turns über Kanäle, die als Plugins angebunden sind. Der Typ eines
Kanals ist in `ChannelKind` festgelegt (`middleware/packages/plugin-api/src/knowledgeGraph.ts:1173`):

```ts
export type ChannelKind = 'teams' | 'telegram' | 'slack' | 'email' | 'web';
```

Die Kennzeichnung sitzt **nicht** im Kanal, sondern im Ausgangs-Contract, den jeder Kanal
gemeinsam benutzt. Damit gilt sie für jeden Kanal, auch für solche, die es heute noch
nicht gibt.

Zwei Träger, bewusst doppelt
(`middleware/packages/harness-channel-sdk/src/aiDisclosure.ts`):

| Träger | Feld | Wofür |
|---|---|---|
| strukturiert | `SemanticAnswer.aiDisclosure` | Kanäle mit eigener Oberfläche (Badge, Footer) |
| im Text gefaltet | `SemanticAnswer.text` | Kanäle ohne Provenienz-Slot (Teams, Telegram, Slack, WhatsApp) |

`text` ist das einzige Feld, das jeder Connector rendern **muss**
(`middleware/packages/harness-channel-sdk/src/outgoing.ts:33`: *"The assistant's prose
response. Connectors MUST render this."*). Deshalb reist die Kennzeichnung dort mit — ein
Kanal, der die strukturierte Variante ignoriert, zeigt sie trotzdem an.

Das strukturierte Feld liegt an **jedem** Turn an. Die Textzeile wird nur beim **ersten
Turn eines Scopes** eingefaltet (`shouldFold`, `DisclosureSeenStore`) — sonst stünde sie
unter jeder einzelnen Antwort. Fail-safe ist bewusst asymmetrisch: wenn der Scope
unbekannt ist, kein Speicher existiert oder der Speicher wirft, wird **gefaltet**. Eine
fehlende Kennzeichnung ist eine Lücke, eine doppelte nur Rauschen.

## 2. Warum die Kennzeichnung im Ausgangs-Contract sitzt und nicht im System-Prompt

Das ist die zentrale Design-Entscheidung des Epics, und sie ist keine Geschmacksfrage.

Eine Anweisung im System-Prompt kann das Modell ignorieren, und die Persona-Konfiguration
des Betreibers überschreibt sie ohnehin. Ein Betreiber, der seinem Assistenten einen
menschlich klingenden Namen und eine Persona gibt, hätte damit die Kennzeichnung faktisch
abgeschaltet, ohne das je zu entscheiden.

Deshalb wird die Kennzeichnung **hinter dem Modell** berechnet, im Ausgangs-Contract. Der
Code sagt das ausdrücklich: `resolveTurnDisclosure`
(`middleware/packages/harness-orchestrator/src/orchestrator.ts`) liest *nichts* aus
`assistantIdentity`, dem Persona-Override oder dem System-Prompt.

## 3. Was maschinenlesbar markiert wird

Überall dort, wo das Ausgabeformat einen echten Metadaten-Slot hat, setzt omadia
zusätzlich zur Textzeile eine maschinenlesbare Markierung.

| Artefakt | Markierung | Codestelle |
|---|---|---|
| `.docx` | Custom Properties `AIGenerated` / `Generator` / `ProvenanceStandard`, dazu `description`, `keywords`, `category` | `packages/harness-plugin-office/src/provenance.ts` (#645) |
| `.xlsx` | nur Core Properties `description`, `keywords`, `category` | dito |
| PNG-Diagramme | `iTXt`-Chunk mit Schlüssel `Provenance`, Wert `{"AIGenerated":true,"Generator":"Omadia","ProvenanceStandard":"EU AI Act Art. 50"}` | `packages/harness-diagrams/src/pngTextChunk.ts` (#646) |
| Public Chat API | Response-Header `X-AI-Generated: true` und `provenance: { aiGenerated: true }` am NDJSON-`done`-Event | `packages/harness-channel-sdk/src/provenance.ts` (#647) |
| Public MCP Server | `_meta`-Schlüssel `omadia.ai/provenance` am `tools/call`-Ergebnis | dito, `src/mcp/publicMcpServer.ts:516` |

Zwei Eigenschaften dieser Markierungen sind absichtlich so gebaut und sollten nicht als
Nachlässigkeit gelesen werden:

**Sie sind statisch.** Kein Zeitstempel, keine Turn-ID, keine Modell-ID im Artefakt. Beide
Office-Pipelines und der Diagramm-Store sind content-adressiert: der Storage-Key ist der
sha256 der Bytes. Ein Wert, der sich pro Render ändert, macht jede Datei einzigartig und
zerstört die Deduplizierung. Turn-bezogene Provenienz liegt deshalb im API-Envelope und im
Audit-Pfad, nie in der Datei
(`packages/harness-plugin-office/src/provenance.ts`, Kommentarblock "Invariant").

**Der Header wird gesetzt, bevor der Turn läuft.** Auf der Chat-API ist der Stream zum
Zeitpunkt eines Fehlers längst ein committetes 200. Ein Header, der erst am Ende gesetzt
würde, fehlte genau bei den Antworten, die schiefgehen. Er wird deshalb bei
`flushHeaders()` gesetzt und überlebt jeden Fehlerpfad.

## 4. Was **nicht** maschinenlesbar markiert wird

Fließtext in Teams, Slack, Telegram und WhatsApp trägt **keine** maschinenlesbare
Markierung. Diese Wire-Formate bieten keinen Provenienz-Slot, und für reinen Text gibt es
keinen robusten, interoperablen Standard, den ein Empfänger auch auswerten würde. Diese
Kanäle bekommen die Textzeile — sichtbar für Menschen, nicht auswertbar für Maschinen.

Das ist eine Grenze des Ökosystems, keine Entscheidung von omadia, aber die Folge ist
dieselbe: wer eine maschinenlesbare Provenienz braucht, bekommt sie auf diesen Kanälen
nicht.

## 5. Was der Betreiber konfigurieren kann

omadia wird selbst gehostet. Die Abstufung der Kennzeichnung ist die Entscheidung des
Betreibers, und der Code lässt sie zu. Setup-Felder des Orchestrator-Plugins
(`packages/harness-orchestrator/src/plugin.ts`, `resolveAiDisclosureSetup`):

| Feld | Wirkung |
|---|---|
| `ai_disclosure_level` | globale Stufe: `standard`, `concise`, `off` |
| `ai_disclosure_level_overrides` | pro Kanal, Format `"telegram=concise,web=off"` |
| `ai_disclosure_locale` | Sprache der Kennzeichnung, normalisiert auf `de` / `en` |
| `ai_disclosure_assistant_name` | Name, der in die Standardformulierung eingewoben wird |
| `ai_disclosure_operator_note` | wörtlicher Zusatz, **hinter** der Kennzeichnungszeile |

Auslieferungszustand ist `standard` und aktiv (`DEFAULT_AI_DISCLOSURE_POLICY`). Zwei
Eigenschaften sichern das ab:

- **`off` ist nur über explizite Betreiber-Konfiguration erreichbar.** Ein Turn kann sich
  nicht selbst stummschalten: `applyAiDisclosure` verwirft ein `off`, dessen `source`
  nicht `operator` ist, und fällt auf den Auslieferungszustand zurück.
- **Der Betreiber-Zusatz kann die Kennzeichnung nur ergänzen, nie ersetzen.** Er wird
  hinter der Kennzeichnungszeile in einem eigenen Absatz ausgegeben; bei `off` existiert
  gar kein Träger, an dem er hängen könnte.

Seit #648 ist die aufgelöste Haltung ablesbar: `GET /health` meldet sie pro Kanal, das
Operator-Dashboard weist auf eine Abweichung vom Auslieferungszustand hin, und beim Boot
wird gewarnt — aber nur, wenn tatsächlich abgewichen wird.

## 6. Grenzen, ausdrücklich benannt

**`.xlsx` ist gröber abgedeckt als `.docx`.** exceljs bietet keine verlässliche
Unterstützung für benutzerdefinierte OOXML-Properties, deshalb trägt `.xlsx` nur die
Core-Properties. Ein Parser kann bei `.docx` auf `AIGenerated === "true"` verzweigen, bei
`.xlsx` muss er den Freitext der `category` auswerten
(`packages/harness-plugin-office/README.md`, Abschnitt "Known limitation").

**Connectoren sind Plugins.** Der Core legt den Contract fest und faltet die Zeile in
`text` — das Feld, das laut Contract jeder Connector rendern muss. Erzwingen kann der Core
das Rendering nicht. Ein fremder Connector, der `text` verändert oder eigene Felder
bevorzugt, liegt außerhalb dessen, was der Core garantieren kann.

**Zwei Provenienz-Vokabulare.** Office und PNG benutzen `AIGenerated` / `Generator` /
`ProvenanceStandard`; der API-/MCP-Envelope benutzt `aiGenerated`. Beide sind bewusst so
gewählt und dokumentiert, aber ein Konsument muss beide kennen. Eine Vereinheitlichung
gibt es nicht.

**Per-Kanal-Overrides greifen heute nicht überall.** Nur `teams`, `slack` und `telegram`
liefern pro Turn einen `channelKind` (`orchestratorDispatcher.toChannelKind` ist die
einzige Stelle, die ihn setzt). Ein Override für `email` oder `web` wird angenommen und
angezeigt, wirkt aber nicht — diese Turns benutzen die globale Stufe. `/health` und das
Operator-Dashboard weisen seit #648 ausdrücklich darauf hin.

**Der Run-Trace ist Telemetrie, kein Provenienz-Record.** Er ist nicht pro Turn garantiert:
der Graph-Sink ist optional, und `ingestRun` verweigert den Schreibvorgang, wenn kein
User-Cluster-Knoten existiert — der Normalfall für jeden Kanal außer dem Browser-Login. Ein
fehlender Trace heißt "nicht aufgezeichnet", nie "diesen Turn gab es nicht". Entschieden
und begründet in #684; jeder Ausfall wird seitdem gezählt und protokolliert.

**Seit #757 gibt es daneben einen persistierten Per-Turn-Receipt** (`turn_receipts`,
Migration `0039`): der PII-freie Privacy-Receipt jedes abgeschlossenen Turns wird auf dem
Postgres-Backend synchron gespeichert — ohne Graph-Sink, ohne User-Cluster-Vorbedingung —
und ist unter `/api/v1/operator/receipts` (auth-gated) sowie im Operator-UI abrufbar.
Fehlschläge werden gezählt und protokolliert, nie still verworfen. **Seit #758 ist der
Record hash-verkettet und checkpoint-signiert** (Migration `0041`: `entry_hash` über
`prev_hash` verkettet, Ed25519-Checkpoints mit Schlüssel außerhalb der DB, optionaler
externer Anker) — eine nachträgliche Änderung bricht die Kette sichtbar. **Seit #761
existiert die Verifikations-Fläche**: `GET /api/v1/operator/provenance/verify`,
signierter JSONL-Export, ein **Offline-Verifier ohne jede Abhängigkeit** (ein Auditor
prüft den Export mit dem out-of-band erhaltenen Public Key, ohne unserem Server zu
vertrauen — `middleware/scripts/verify-audit-export.mjs`), und die Chain-Status-Karte
unter `/operator/receipts`. Mechanik, Tamper-Demo und die Grenzen (Detektion statt
Prävention; Zeitanker = Checkpoint-Kadenz; Pre-Chain-Ära) stehen in
`docs/provenance-verification.md`. Die Aussage „kryptographisch nachweisbar" ist damit
**durch Code gedeckt** — die Übernahme in öffentliche Texte (Marketing-Site, Sales)
bleibt ein bewusster, eigener Schritt nach diesem Dokumentprinzip.

**C2PA ist offen.** Im Code existiert keine C2PA-Implementierung. Für Bilder wäre das der
naheliegende nächste Schritt; heute ist es keine Zusage, sondern ein offener Punkt.

---

## 7. Textbausteine für die Transparenzseite

> Diese beiden Blöcke sind der Produktabschnitt für `omadia.ai/ai-transparency`. Sie sagen
> dasselbe in DE und EN. **Vor der Veröffentlichung ist eine interne Freigabe nötig** —
> der Text ist hier fertig, aber damit nicht live.

### Deutsch

```text
KI-Kennzeichnung in omadia

Jede Antwort, die omadia erzeugt, ist als KI-generiert gekennzeichnet. Die
Kennzeichnung schreibt nicht das Sprachmodell. Die Plattform setzt sie, nachdem
das Modell fertig ist. Ein Modell kann eine Anweisung im Prompt ignorieren, eine
Persona kann sie überschreiben. Beides greift hier nicht, weil die Kennzeichnung
hinter dem Modell entsteht.

Wo das Ausgabeformat einen Metadaten-Slot hat, setzen wir zusätzlich eine
maschinenlesbare Markierung: in Word-Dokumenten als Dokument-Eigenschaften, in
Excel-Dateien gröber über die Core-Properties, in erzeugten Diagrammen als
iTXt-Feld im PNG, in der öffentlichen API als Response-Header und als Feld in der
Antwort, im MCP-Server als Metadatum am Ergebnis.

Was wir nicht markieren, sagen wir genauso deutlich. Fließtext in Teams, Slack,
Telegram und WhatsApp trägt nur die sichtbare Kennzeichnung für Menschen. Diese
Formate bieten keinen Slot für Provenienz, und für reinen Text gibt es keinen
Standard, den ein Empfänger auch auswerten würde. Bei Excel-Dateien ist die
Markierung gröber als bei Word. C2PA für Bilder haben wir nicht umgesetzt.

omadia wird selbst gehostet. Der Betreiber kann die Kennzeichnung pro Kanal
abstufen und abschalten. Das ist seine Entscheidung, nicht unsere, und wir machen
sie sichtbar statt sie zu verstecken: die aufgelöste Einstellung steht im
Health-Endpunkt, weicht sie vom Auslieferungszustand ab, weist das
Betreiber-Dashboard darauf hin. Im Auslieferungszustand ist die Kennzeichnung
aktiv und vollständig.

Mehr zu omadia: omadia.ai
```

### English

```text
AI marking in omadia

Every answer omadia produces is marked as AI-generated. The marking is not written
by the language model. The platform adds it after the model has finished. A model
can ignore an instruction in a prompt and a persona can override one. Neither
applies here, because the marking is produced behind the model.

Where the output format has a metadata slot, we add a machine-readable marker as
well: document properties in Word files, coarser core properties in Excel files,
an iTXt field in generated PNG diagrams, a response header and a field in the
answer on the public API, and a metadata entry on the result in the MCP server.

We are equally clear about what we do not mark. Message text in Teams, Slack,
Telegram and WhatsApp carries only the human-readable marking. Those formats have
no slot for provenance, and for plain text there is no standard a recipient would
actually read. Excel files are marked more coarsely than Word files. We have not
implemented C2PA for images.

omadia is self-hosted. The operator can reduce the marking per channel or switch
it off. That is their decision rather than ours, and we make it visible instead of
hiding it: the resolved setting is reported by the health endpoint, and the
operator dashboard flags any deviation from the delivered state. As delivered, the
marking is active and complete.

More about omadia: omadia.ai
```

---

## 8. Wo der Code steht

| Thema | Pfad | Status |
|---|---|---|
| Carrier + Policy + Textkomposition (#643) | `middleware/packages/harness-channel-sdk/src/aiDisclosure.ts` | auf `main` |
| Per-Turn-Auflösung (#644) | `middleware/packages/harness-orchestrator/src/orchestrator.ts` | auf `main` |
| Setup-Felder (#644) | `middleware/packages/harness-orchestrator/src/plugin.ts` | auf `main` |
| Office-Provenienz (#645) | `middleware/packages/harness-plugin-office/src/provenance.ts` | auf `main` |
| PNG-Provenienz (#646) | `middleware/packages/harness-diagrams/src/pngTextChunk.ts` | auf `main` |
| Envelope-Provenienz (#647) | `middleware/packages/harness-channel-sdk/src/provenance.ts` | auf `main` |
| Haltung pro Kanal, `/health` + Dashboard (#648) | `middleware/packages/harness-orchestrator/src/aiDisclosurePosture.ts`, `middleware/src/health/disclosureHealth.ts` | auf `main` (PR #686, `79a68336`) |
| Run-Trace als Telemetrie (#684) | `middleware/packages/harness-orchestrator/src/runTraceObservability.ts` | auf `main` (PR #685, `e859da9d`) |

Jeder oben genannte Pfad existiert auf `main`, und jede Aussage dieses Dokuments ist
gegen diesen Stand verifiziert. Es gibt keine Vorwärtsverweise mehr.
