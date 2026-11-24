# `agent-reference-maximum`

> **Reference-only-Plugin** — wird vom Plugin Builder als **PRIMÄRE**
> Pattern-Quelle verwendet (Catalog-Key `reference-maximum`). Nicht im
> Operator-Plugin-Catalog sichtbar (siehe `is_reference_only: true` im
> `manifest.yaml`).

Lauffähiges, credential-loses **Capability-Plugin** (Kind `integration`, spec
2042 §5.10, ADR-0014), das die Patterns der Plugin-API an einer Stelle zeigt —
in derselben Form wie die Boilerplates des Plugin Builders: `toolkit.ts`
(Zod-Tools) + `registerTools.ts` (`ctx.tools.register`) + `plugin.ts`
(`activate(ctx) → { close() }`). Keine Persona, keine `AGENT.md`, keine
`prompt_partial`-Skills; die frühere Rolle steht als Agent-Vorlage im Manifest
(`agent_templates:`, `knowledge-companion` auf Englisch und
`knowledge-companion-de` auf Deutsch).

Die Plugin-Id behält ihr historisches `agent-`-Präfix, weil installierte
Instanzen sie referenzieren.

## Pattern-Index

Siehe [INTEGRATION.md](./INTEGRATION.md) — strukturierter Pattern-Index für
den Plugin Builder. **Pflicht-Lektüre** vor jedem Code-Zitat aus diesem
Package; jeder Pattern-Block trägt Datei:Zeile-Refs, die ein CI-Bitrot-
Check (`npm run check:integration-md`) gegen den realen Code validiert.

## Tools

- `add_note` (write) — Notiz speichern, KG-Ingest + Smart-Card
- `smart_extract_entities` (read) — LLM-NER via `ctx.llm.complete`
- `query_notes_by_person` (read) — emittiert `_pendingUserChoice` bei
  Mehrdeutigkeit

## Status

`is_reference_only: true` — nicht im Operator-Catalog. Plugin-Builder-Zugriff
via `read_reference({ name: 'reference-maximum', file: '...' })`.
