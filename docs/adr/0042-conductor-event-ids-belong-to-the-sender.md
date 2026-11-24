# 0042 — Conductor event ids belong to the sender; the catalog only suggests

## Status

Accepted

- **Date:** 2026-11-24
- **Deciders:** Maintainers, from issue #1713; PR #2211. Reverses the rule in
  `specs/005-omadia-conductor/spec.md` FR-003, which the PR amends with an explicit carve-out.

## Context and Problem Statement

Conductor workflows start on `event` and `webhook` triggers that name an event id. Template
validation (`POST /conductors/templates/:id/{resolve,instantiate}`) passed the live event
catalog as `KnownRefs`, and FR-003 said validation MUST reject an unknown event. On an
install without an event-emitting plugin that catalog is empty, so the bundled
"notify and escalate on incident" template could not be instantiated at all, while the same
graph published fine through `POST /conductors`, which validates without `KnownRefs`.

The catalog was never the set of legal ids: `POST /conductors/emit` accepts any id, and an
inbound webhook endpoint (#437) carries an operator-chosen id that no plugin manifest
declares. Which rule should bind validation — the catalog, or the sender?

## Decision Drivers

- A shipped template must be usable on a fresh install.
- Every surface that publishes a graph should judge an event reference the same way.
- A trigger that can never fire is worse than a refusal; it must not pass silently.
- Plugins and operators emit events the kernel cannot enumerate in advance.

## Considered Options

- **A — The sender owns the id; the catalog is a suggestion list.** An id outside the
  catalog is a warning, a missing id stays an error.
- **B — Keep the catalog strict** and seed a placeholder event so the template validates.
- **C — Strict only when the catalog is non-empty.**

## Decision Outcome

Chosen option: **A**, because it matches how events actually reach the Conductor and makes
all publishing surfaces agree.

- `validate()` in `@omadia/conductor-core` reports an id no known ref matches as the
  non-blocking warning **`unmatched_event_ref`**. A **missing** `eventId` on an
  `event`/`webhook` trigger stays the hard error `unknown_event_ref`.
- `resolve` answers `200 { graph, warnings? }`, `instantiate` `201 { workflow, version,
  warnings? }`, the same envelope `POST /conductors` uses.
- Ref-slot values are trimmed before publish, so a pasted `" my.incident"` cannot create a
  trigger whose id never equals an emitted one.
- The suggestion list is the plugin catalog **plus** the inbound endpoints' event ids
  (`knownEventIds()`; `GET /events/catalog` adds `endpointEvents`). A failed endpoint read
  degrades to the plugin catalog.
- The event slot in the UI is free text with suggestions, like the designer's trigger field.

### Consequences

- 🟢 **Good:** Templates with event slots work on every install; the designer, the template
  routes and `POST /conductors` give the same verdict.
- 🟢 **Good:** Webhook-endpoint ids are first-class suggestions instead of invisible values.
- 🔴 **Bad:** A typo in an event id publishes; the operator sees only a warning, and the
  workflow waits for an event nobody sends.
- ⚪ **Neutral:** FR-003 now carries the carve-out, so the rule is not re-added from the spec.

## Pros and Cons of the Options

### A — Sender owns the id

- 🟢 Reflects `emit` and webhook endpoints as they are.
- 🔴 Typos surface only as warnings.

### B — Strict catalog with a placeholder

- 🟢 Typos are refused.
- 🔴 A fake event in the catalog; endpoint ids still refused; surfaces still disagree.

### C — Strict when non-empty

- 🔴 Validation depends on which plugins happen to be installed; installing one plugin
  breaks templates that worked before.

## More Information

- PR #2211, issue #1713, webhook endpoints #437.
- `middleware/packages/conductor-core/src/validate.ts`, `src/conductor/templateRoutes.ts`.
- Related: [ADR-0028](0028-channel-triggered-workflows-start-only-for-the-addressed-agent.md)
  (which agent a channel trigger starts — unchanged).
