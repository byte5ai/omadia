# 0236 — Declined preview turns are marked in the transcript

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** W21 cluster lead
- **Related:** [ADR-0059](0059-builder-preview-in-process-with-captured-tools.md), [ADR-0159](0159-web-ui-i18n-plain-json-catalogs-and-ratchets.md)

## Context and Problem Statement

The Plugin Builder preview runs a neutral draft agent. Displaying the internal model refusal exception exposed its runtime label. The persisted user message had no outcome and re-entered the model context on subsequent turns.

## Decision Outcome

A model refusal stores the user's preview entry with `status: declined` and streams `turn_declined` before the normal completion frame. The operator UI renders a localized system notice from that outcome, both live and on replay. Later turns omit declined entries from their model input. Existing entries without a status remain readable and eligible for context.

Each preview runs in its own turn context with session scope `builder-preview:<draftId>`. Telemetry retains its per-draft preview source, and the Builder usage group counts each draft once across its build and preview calls.

## Considered Options

- Persist a localized assistant reply containing the failure text. This would encode UI language and attribution in stored content.
- Persist a language-independent terminal outcome and render it at delivery. Chosen to preserve the distinction between a system notice and an agent's reply.

## More Information

Issues #1741 and #1810.
