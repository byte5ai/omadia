# 0245 — Coalesce consecutive manual Builder edits in draft history

## Status

Proposed

- **Date:** 2026-11-26
- **Related:** #1740, [ADR-0058](0058-builder-drafts-owner-scoped-and-installed-through-the-upload-ingest.md)

## Context and Problem Statement

Manual spec and slot saves can arrive once per keystroke. The owner-scoped draft
timeline needs to show those edits alongside Builder-agent actions without making
the timeline unreadable or coupling history to the editor's save cadence.

## Decision Drivers

- Save and record changes immediately, including from clients that save every keystroke.
- Keep manual and Builder-agent entries distinguishable.
- Keep spec values and slot source out of new history details.

## Considered Options

- One event per successful save.
- Debounce saves in the web editor.
- Persist the first event immediately and extend it for successive edits in the same burst.

## Decision Outcome

Use the third option. `builder_audit` records manual spec and slot saves as
`spec_edited` and `slot_edited`, respectively. Update the latest event in the
same owner's draft only when the next edit has the same action, targets the same
slot where applicable, and occurs within two seconds. The transaction sums spec
operations or replaces the slot byte count and advances the event timestamp.
An intervening history event starts a new burst. Builder-agent events keep their
append behaviour. The separate Postgres `admin_audit` remains append-only.

## Consequences

- Autosave behaviour stays the same and the first edit survives an interrupted session.
- The timeline shows editing bursts. It cannot reconstruct individual keystrokes.
