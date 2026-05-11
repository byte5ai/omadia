# `agent-reference-maximum`

> **Reference-only-Plugin** — wird vom BuilderAgent als **PRIMÄRE**
> Pattern-Quelle verwendet (Catalog-Key `reference-maximum`). Nicht im
> Operator-Plugin-Catalog sichtbar (siehe `is_reference_only: true` im
> `manifest.yaml`).

Lauffähige, credential-lose Codebase, die ALLE auf der Plugin-API
verfügbaren Patterns in einer Stelle demonstriert.

Sekundär-Use-Case: Personal-Knowledge-Companion. User können kurze Notizen
schreiben (`add_note`), die im Plugin-Memory-Scope persistiert, automatisch
als PluginEntity-Nodes in den Knowledge-Graph ingested und als
note-card-Smart-Card gerendert werden.

## Pattern-Index

Siehe [INTEGRATION.md](./INTEGRATION.md) — strukturierter Pattern-Index für
den BuilderAgent. **Pflicht-Lektüre** vor jedem Code-Zitat aus diesem
Package; jeder Pattern-Block trägt Datei:Zeile-Refs, die ein CI-Bitrot-
Check (`npm run check:integration-md`) gegen den realen Code validiert.

## Geliefertes (OB-29 abgeschlossen)

| Etappe | Pattern-Erweiterung |
|---|---|
| 0 | Skelett + Catalog-Marker `is_reference_only: true` + CI-Bitrot |
| 1 | `ctx.subAgent.ask` (cross-agent delegation) |
| 2 | generic `ctx.knowledgeGraph.ingestEntities` (PluginEntity namespace) |
| 3 | `ctx.llm.complete` (host-paid mit Whitelist + Budget) |
| 4 | tool-emittiertes `_pendingUserChoice` (Smart-Card-Short-Circuit) |
| 5 | Rename + Builder-Prompt-Final-Routing (PRIMÄR-Reference) |

## Tools

- `add_note` (write) — Notiz speichern, KG-Ingest + Smart-Card
- `analyze_url` (write) — delegiert via `ctx.subAgent.ask` an seo-analyst
- `smart_extract_entities` (read) — LLM-NER via `ctx.llm.complete`
- `query_notes_by_person` (read) — emittiert `_pendingUserChoice` bei
  Mehrdeutigkeit

## Status

`is_reference_only: true` — nicht im Operator-Catalog. BuilderAgent
zugriff via `read_reference({ name: 'reference-maximum', file: '...' })`.
