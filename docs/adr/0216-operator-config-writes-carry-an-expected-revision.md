# 0216 — Operator config writes carry an expected revision; a stale write returns 409

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (decision after recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

Agent configuration is written by replace-style requests: `PUT /api/v1/operator/agents/:slug/identity`
replaces every authored field with the request body. Two operators, or one operator in two
browser tabs, read the same state, both edit, both save, and the second save silently
replaces the first one's change (#1889: a short description saved in tab A was wiped by an
accent-colour save in tab B). The identity row already has a monotonic `revision` (it is the
Teams manifest version), but no write checked it. How does an operator write find out that
the state it was based on is no longer the stored one?

## Decision Drivers

- No silent loss of another operator's saved change.
- The check must be atomic with the write, not a read-then-write window.
- Existing API clients (scripts, the desktop app, older web UIs) must not break overnight.
- The refusal must be machine-readable, so the UI can show a localized message (ADR-0159),
  and follow the JSON error shape of ADR-0104.

## Considered Options

- **A — expected revision in the body, 409 on mismatch, absent = no check**
- **B — expected revision required on every write**
- **C — HTTP `If-Match` with an ETag**
- **D — last write wins (status quo), only warn in the UI**

## Decision Outcome

Chosen option: **A**.

- A replace-style operator config write carries `expected_revision`: the revision the
  client's form was read at. The store compares it with the stored revision inside the same
  statement that writes (`ON CONFLICT … DO UPDATE … WHERE revision = $expected`), so a write
  landing in between is caught too.
- A mismatch is refused with **409** and the body
  `{ error: 'identity_revision_conflict', code: 'operator_agents.identity_revision_conflict',
  message, expected_revision, current_revision }`. `error` is what this router's clients
  already branch on (`parseOperatorAgentErrorCode`), `code`/`message` is the ADR-0104 shape.
  Nothing is written and nothing is rebuilt.
- A write whose content equals the stored content is accepted whatever revision it names:
  it cannot lose anything.
- An agent without an identity row projects `revision: 0` (a stored row starts at 1). A
  write with `expected_revision: 0` means "no row may exist yet": if one does, or a
  concurrent first save inserts it first, the write is refused with the same 409 (the
  upsert's `WHERE revision = 0` never matches a stored row). A revision above 0 for an
  agent without a row is refused too. The Teams manifest keeps its own fallback of 1
  (`resolveAgentIdentity`); only the operator projection uses 0.
- **Clients that send no `expected_revision` are accepted unchecked**, for backwards
  compatibility of API clients. The web UI always sends it.
- **Adopted now:** `PUT /:slug/identity` (agent identity, persona, quality). The revision it
  checks is the identity row's `revision`, which avatar upload/removal also bump; the web UI
  moves its baseline along only for its own avatar write, so an avatar change from elsewhere
  also surfaces as a conflict on the next save.
- **Follow later:** the other replace-style agent config writes (`PUT /:slug/plugins`,
  `/bindings`, `/model-policy`, `/context-memory`, `/fast-lane`, `/agent-to-agent`,
  `/availability`). They have no revision column yet; adopting this rule there means a
  revision (or `updated_at`-based token) per resource and the same 409 contract.

### Consequences

- 🟢 **Good:** a stale tab can no longer overwrite a newer identity; the operator sees a
  localized "changed elsewhere, reload" message and keeps the edit on screen until reloading.
- 🟢 **Good:** no new column or migration; the existing Teams revision is the token.
- 🔴 **Bad:** API clients that omit the field keep last-write-wins semantics until a later
  ADR makes the field required.
- 🔴 **Bad:** an avatar change from elsewhere also counts as a conflict for a field save,
  although the two touch different fields (accepted: one token per row keeps it simple).
- ⚪ **Neutral:** the other agent config writes listed above follow in their own changes.

## Pros and Cons of the Options

### A — expected revision in the body, absent = no check

- 🟢 Fixes the UI path now, breaks no API client.
- 🔴 Unchecked writes stay possible for clients that do not send it.

### B — required on every write

- 🟢 No unchecked path.
- 🔴 Breaks every existing script and older client at once.

### C — `If-Match` / ETag

- 🟢 HTTP-native.
- 🔴 The routes and the UI client have no ETag handling anywhere; a body field matches how
  every other field of these routes travels.

### D — last write wins

- 🔴 The data loss reported in #1889 stays.

## More Information

- Issue #1889; implementation in `middleware/src/platform/agentIdentityStore.ts`
  (`AgentIdentityRevisionConflictError`), `middleware/src/routes/operatorAgents.ts`
  (`PUT /:slug/identity`), `web-ui/app/operator/agents/[slug]/_components/AgentIdentity.tsx`.
- ADR-0104 (JSON error shape), ADR-0159 (localized UI text).
