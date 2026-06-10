# Plan: Plugin-driven canvas context actions

Status: proposal (2026-06-10) · Owner: Omadia UI · Depends on: PR
`fix/ui-orchestrator-skeleton-fallback` (canvas_publish_rows producer tool)

## Goal

When the user right-clicks a rendered canvas element (a table row, a list
item, a cell, a container), the context menu must offer **actions that the
installed plugins actually support for that kind of data** — not a single
hard-coded "Show details". Examples:

- a course row (Dynamics `ud_tutorial`) → "Details anzeigen", "Teilnehmer
  anzeigen", "Auslastung auswerten"
- a product row (Odoo `product.template`) → "Produktdetails", "Auswertung
  Umsatz", "Lagerbestand"
- an invoice row (Papierkram) → "Beleg öffnen", "Zahlungen anzeigen"

The actions are **generated from plugin metadata**, resolved per data class,
and surfaced deterministically — no guessing from free-form names.

## Current state (what already exists)

- **Data class on the wire.** `tableColumn.dataClass` and the `dataClass`
  trait already ride the canvas tree (`canvas-tree.schema.json` `$defs`).
  Today the composer rarely sets it; the producer tool
  (`canvas_publish_rows`) does not forward it yet.
- **Write capabilities.** `packages/plugin-api/src/writeCapabilities.ts`
  already defines a per-`dataClass` capability contract
  (`WriteCapability { dataClass, operation, targetSchema }`) and a
  deterministic Tier-2 derivation (`deriveMutabilityCapabilities`). This is
  the proven pattern to copy: **declare in manifest → resolve at boot →
  derive deterministically**.
- **TargetRef.** `surface-events` + `IncomingTurn.target` already carry a
  `TargetRef` (`{ kind: 'element', elementId }`), so a context action can
  point at the exact clicked element. The client already sends it.
- **Producer tool.** The new `canvas_publish_rows` lets a Tier-3 turn write
  structured rows into a skeleton; a context action is just a **pre-seeded
  follow-up turn** that targets one row and asks for a specific view.

So the missing piece is **a read-side capability**: a plugin declaring "for
data class X I can render view Y", surfaced to the client as a menu.

## Design

### 1. Manifest: `canvasActions` capability (additive)

New optional manifest block, mirroring the `permissions`/`writeCapabilities`
style. Each entry binds a **data class** to an **offerable action**:

```yaml
# manifest.yaml (e.g. integration-dynamics-crm)
canvasActions:
  - dataClass: "dynamics.ud_tutorial"      # course
    label: "Teilnehmer anzeigen"
    actionId: "course.participants"
    intent: "Zeige die Teilnehmerliste zu diesem Kurs als Tabelle."
    renderHint: "panes"                      # table | panes | tabs | chart
  - dataClass: "dynamics.ud_tutorial"
    label: "Auslastung auswerten"
    actionId: "course.utilization"
    intent: "Werte die Auslastung dieses Kurses aus (gebucht vs. Kapazität)."
    renderHint: "chart"
  - dataClass: "odoo.product.template"
    label: "Auswertung Umsatz"
    actionId: "product.revenue"
    intent: "Zeige die Umsatzauswertung zu diesem Produkt."
    renderHint: "chart"
```

Types live in `plugin-api/src/canvasActions.ts` (new):
`CanvasAction { dataClass, label, actionId, intent, renderHint? }`.
Parsed by the manifest loader into the catalog entry, exactly like
`permissions_summary` / write capabilities.

### 2. Boot: build the data-class → actions index

In `platform/pluginContext.ts` (or a small dedicated resolver), compute at
boot a `Map<dataClass, CanvasAction[]>` from every **active** plugin's
manifest — same lifecycle as the canvas-output allow-set and the LLM
permissions. Publish it as a kernel service
`canvasActionRegistry@1` (read-only), so the ui-orchestrator can resolve it
per dispatch without importing the installed registry.

Deduplicate by `(dataClass, actionId)`; later: per-tenant / per-role
filtering (reuse the email whitelist plumbing).

### 3. Wire: carry actions to the client

Two options — recommend **(a)** for v1 (no per-row server round-trip):

**(a) Eager, per data class.** Extend the producer tool + composer so every
data-carrying container stamps its `dataClass`. Add a new handshake/info
field (or extend `surface_snapshot`) carrying the resolved
`dataClass → CanvasAction[]` map for the data classes present in the tree.
The client renders the menu purely client-side from that map. One lookup,
zero latency on right-click.

**(b) Lazy, per element.** A new client→server message
`context_actions_request { target }` answered by
`context_actions { actions }`. More flexible (row-specific actions, live
permission checks) but adds a round-trip on every right-click. Defer to v2.

New protocol additions (v1, option a):

- `canvas-tree.schema.json`: encourage `dataClass` on containers/columns
  (already allowed; make the composer set it, and `canvas_publish_rows`
  forward it).
- `surface-events.schema.json`: optional `contextActions` map on
  `surface_snapshot` (`{ [dataClass]: CanvasAction[] }`).
- client `ipc.ts` / `protocol.ts`: surface the map into `CanvasState`.

### 4. Client: data-class-aware menu

`PrimitiveNode` already raises `onRowMenu` with the row + its container id.
Extend the payload with the element's `dataClass` (read from the column /
container trait). `App` looks the class up in
`canvas.contextActions[dataClass]` and renders one `lume-row-menu-item` per
action. Selecting one dispatches a turn:

```ts
window.omadiaCanvas.sendTurn({
  type: 'turn',
  turnId: crypto.randomUUID(),
  text: action.intent,
  action: { type: action.actionId, payload: { row: menu.cells } },
  target: { kind: 'element', elementId: menu.tableId },
});
```

Fallback when no plugin declares actions for the class: the current generic
"Details anzeigen" stays as a built-in.

### 5. Server: honour the action on the follow-up turn

The dispatched turn already flows through the canvas orchestrator
(skeleton → `[canvas-context]` → `canvas_publish_rows`). The `action.type`
(= `actionId`) and `renderHint` ride `IncomingTurn.metadata.action`; the
composer uses `renderHint` to pick the skeleton shape (panes/tabs/chart),
closing the loop with the detail-view rendering this PR added client-side.

## Build sequence

1. **Types + manifest parsing** — `plugin-api/src/canvasActions.ts`,
   manifest-loader parse, catalog field. (no behaviour change)
2. **Boot registry** — `canvasActionRegistry@1` service from active manifests;
   unit test the dedupe + data-class index.
3. **dataClass plumbing** — composer sets `dataClass`; `canvas_publish_rows`
   forwards it; `surface_snapshot.contextActions` populated from the registry.
4. **Client menu** — data-class lookup in `App`, action dispatch, generic
   fallback. Renderer already supports panes/tabs/chart.
5. **renderHint → skeleton** — composer picks layout from the action's
   `renderHint`; improves the detail-view quality gap (see Risks).
6. **Pilot manifests** — add `canvasActions` to dynamics-crm (course) +
   odoo (product) and validate the three example menus end-to-end.

## Risks / open questions

- **Composer quality for non-table layouts.** The Haiku composer currently
  emits schema-invalid trees for pane/tabs/chart skeletons and falls back to
  the static skeleton (observed in this PR's E2E). `renderHint` + few-shot
  examples in the composer system prompt, or pinning the composer to Sonnet
  for non-table hints (the manifest already allows `claude-sonnet-4-*`),
  is likely required before step 5 lands cleanly.
- **Privacy.** Participant lists are PII. The current local bypass
  (`_privacy_mode: bypass` on ui-orchestrator) is a test-only shortcut — the
  real path must let canvas sentinels through the privacy boundary
  structurally (canvas-output capability), not by disabling masking.
- **Layer-2 view persistence.** The client Back button is view-only today
  (in-memory history). Persisting/restoring views across reconnects +
  sessions is the separate Layer-2 task referenced in the concept; the
  `dataClass → actions` map should be re-derivable on resync so restored
  views keep their context menus.
- **TargetRef granularity.** v1 targets the container (table) + row key via
  payload. Cell-level / multi-select actions reuse the existing
  `TargetRef` selection shapes (`incoming.ts`) when needed.
```
