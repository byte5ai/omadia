# Spec — Chat surface routes via the multi-orchestrator registry

**Phase A.** Closes the full-access bug observed after the US1–US9 deploy:
the Web-UI chat at `/chat` and the kernel `/api/chat` endpoint bypass the
registry and always serve the legacy default `chatAgent@1` bundle — every
plugin, every permission, no per-Agent isolation. The fallback Agent
auto-seeded by onboarding (`slug=fallback`) exists in DB but receives
zero traffic.

**Goal.** Every chat turn is served by an Agent the operator chose
explicitly (per-session pin) or by the platform's fallback Agent. The
default `chatAgent@1` bundle stops being a routing target; it remains as
the construction template (still produced by the orchestrator plugin's
`activate()` because the kernel late-resolves it for `attachOrchestrator`)
but no inbound traffic lands there.

---

## Functional requirements

- **FR-A1** — A chat session SHALL persist its bound Agent slug. The
  binding is captured at the first turn (US6 `captureSnapshot` semantics)
  and pinned for the session's life.
- **FR-A2** — `/api/chat` and `/api/chat/stream` SHALL accept an optional
  `agentSlug` field in the request body. When present + the session has
  no snapshot yet, it becomes the pinned slug. When the session already
  has a snapshot, the request's `agentSlug` MUST equal the pinned slug or
  the request is rejected `409 agent_mismatch`.
- **FR-A3** — When no `agentSlug` is sent AND the session has no
  snapshot, the platform's `fallback_agent_id` is used. When fallback is
  `null`, the request is rejected `412 no_fallback`.
- **FR-A4** — The Web-UI chat header SHALL show the bound Agent slug for
  the active session and, before the first turn, expose an Agent picker
  (dropdown of enabled Agents from `GET /api/v1/operator/agents` filtered
  to `status=enabled`).
- **FR-A5** — The picker SHALL highlight the fallback Agent and let the
  operator override it for the session being created.
- **FR-A6** — A session whose bound Agent is later deleted SHALL surface
  `agent_unavailable` on the next turn rather than silently falling back.
  Operator decides via UI: drop the session, re-snapshot to a different
  Agent, or wait for the Agent to be re-enabled.
- **FR-A7** — Existing sessions without a `snapshot` field (pre-Phase-A
  data) SHALL be migrated lazily on first turn: pin to the fallback
  Agent, persist, continue.

## Non-functional

- Backward compatibility: every existing endpoint signature unchanged
  except `/api/chat` + `/api/chat/stream` (one new optional body field).
  Channel plugins (Teams, Telegram in private byte5 repo) keep working;
  their consumption of `channelResolver@1` is still deferred.
- No new DB tables. Reuses `chatSession.snapshot.agentSlug` (US6).
- No migration of existing chat-session JSON files — lazy upgrade per
  FR-A7.

## Success criteria

- **SC-A1** — Sending `POST /api/chat` with no `agentSlug` to a fresh
  session pins the session to the fallback Agent; the response answer
  comes from the fallback's Orchestrator (verified by logged `agentId`).
- **SC-A2** — Sending `POST /api/chat` with `agentSlug=other` to a fresh
  session pins to `other`; the second call must include `agentSlug=other`
  or `agentSlug=undefined` (re-uses pinned), else 409.
- **SC-A3** — Web-UI: creating a new chat lets the operator pick from a
  dropdown of enabled Agents; selection persists and is shown in the chat
  header.
- **SC-A4** — Deleting an Agent that has live sessions leaves the
  session in `agent_unavailable` state. Operator can use the existing
  US6 force-invalidate (drain → re-snapshot) from the operator/agents
  page to recover.

---

## Tasks (TA01–TA09)

### TA01 — Chat router: per-Agent ChatAgent resolution

`middleware/src/routes/chat.ts`

- Replace `orchestrator: ChatAgent` parameter with
  `resolveChatAgent: (slug: string) => ChatAgent | undefined` +
  `getDefaultSlug: () => string | undefined`.
- Add `agentSlug?: string` to `ChatRequestSchema` (regex matching
  agent-slug rules: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`).
- New flow per request:
  1. Load session (if `sessionId` present) via `chatSessionStore.get(id)`.
  2. Resolve effective slug:
     - if `session.snapshot?.agentSlug` exists → use it. Reject 409
       when request's `agentSlug` is present + different.
     - else if request's `agentSlug` → that.
     - else → fallback slug from registry's `platformSettings.fallbackAgentId`
       (look up via store or registry helper). Reject 412 when null.
  3. Resolve `ChatAgent` via `resolveChatAgent(effectiveSlug)`. Reject
     503 `agent_unavailable` when undefined.
  4. If session exists + has no snapshot, capture one via
     `chatSessionStore.captureSnapshot(id, source)` where `source()`
     returns `registry.snapshotForAgent(effectiveSlug)`.
  5. Call `chatAgent.chat(...)` as today.

### TA02 — Index mount: wire the resolver

`middleware/src/index.ts`

- Build the `resolveChatAgent` adapter from the live registry +
  legacy `chatAgentBundle.agent` fallback (for the very first boot
  before any agents exist):
  ```ts
  const resolveChatAgent = (slug: string): ChatAgent | undefined => {
    const entry = registry?.get(slug);
    if (entry) return entry.built.bundle.agent;
    // legacy boot: only the default exists, no registry agents yet
    if (slug === 'default' || !registry) return chatAgentBundle.agent;
    return undefined;
  };
  const getDefaultSlug = (): string | undefined => {
    const fallbackId = registry?.currentSnapshot()?.platformSettings.fallbackAgentId;
    if (!fallbackId) return registry ? undefined : 'default';
    const fb = registry.list().find((a) => a.agent.id === fallbackId);
    return fb?.agent.slug;
  };
  ```
- Pass both into `createChatRouter`.

### TA03 — Registry helper: `slugForFallback`

`middleware/packages/harness-orchestrator/src/registry/index.ts`

- Add `slugForFallback(): string | undefined` returning the slug of
  the Agent referenced by `platformSettings.fallbackAgentId`, or
  `undefined` if unset / Agent missing. Avoids exposing internal
  Map shape to callers.

### TA04 — Operator endpoint: list-enabled

`middleware/src/routes/operatorAgents.ts`

- Add `GET /enabled` that returns only `status=enabled` agents with
  fields `{ slug, name, description, privacy_profile, is_fallback }`.
  Used by the chat-picker — never reveals full plugin/binding
  metadata to non-operator users (the existing `GET /` requires the
  full operator scope; future role split may gate `/` tighter than
  `/enabled`).

### TA05 — Chat client: agentSlug on requests

`web-ui/app/_lib/chat.ts` (or equivalent — currently chat fetches
live in the chat page components)

- New typed wrapper: `sendChatTurn({ sessionId, agentSlug?, message })`
  posts to `/bot-api/chat` with the optional slug.
- New: `listEnabledAgents()` calls `GET /api/v1/operator/agents/enabled`.

### TA06 — Chat UI: Agent picker

`web-ui/app/chat/...` (locate the chat-tab/header component)

- Header gets a small `<AgentPicker>` component:
  - Before first turn: dropdown of enabled Agents (with fallback
    highlighted as default selection).
  - After first turn: read-only label "Agent: `<slug>`" + tooltip
    "Pinned at <capturedAt>". No way to change mid-session — operator
    must drain (US6) from `/operator/agents` page.
- On chat submit, include the selected `agentSlug` only on the FIRST
  turn of a session. Subsequent turns omit it (pinning is server-side).

### TA07 — Empty-config UX

Web-UI: when `listEnabledAgents()` returns `{ agents: [] }` AND the
fallback is unset, the chat page shows a "No Agents configured yet"
empty state with a CTA "Open Operator → Agents to create one". Avoids
the user staring at a broken chat that 412s every turn.

### TA08 — Agent-unavailable recovery flow

`web-ui/app/chat/...`

- When a turn returns `503 agent_unavailable`, the chat surfaces a
  banner: "This session's Agent (<slug>) was deleted or disabled.
  Options: [Re-snapshot to fallback] · [Delete session]". The first
  button calls `clearSnapshot(sessionId)` via a new endpoint
  `POST /api/chat/sessions/:id/re-snapshot`; the second hits the
  existing delete.

### TA09 — Tests

- `middleware/test/chatRouter.test.ts` — unit: cover the four
  routing branches (snapshot pinned, request's slug, fallback,
  no-fallback → 412).
- `middleware/test/chatRouterAgentMismatch.test.ts` — request's
  slug ≠ pinned snapshot → 409.
- Web-UI: existing chat-flow tests run unchanged because `agentSlug`
  is optional + default behaviour is "use fallback".

---

## Files

**New:**
- `middleware/test/chatRouter.test.ts`
- `middleware/test/chatRouterAgentMismatch.test.ts`
- `web-ui/app/_lib/chat.ts` (or extend the existing chat lib file)
- `web-ui/app/chat/_components/AgentPicker.tsx`

**Modified:**
- `middleware/src/routes/chat.ts` — TA01
- `middleware/src/index.ts` — TA02 mount
- `middleware/packages/harness-orchestrator/src/registry/index.ts` — TA03 helper
- `middleware/src/routes/operatorAgents.ts` — TA04 `/enabled` endpoint
- `web-ui/app/_lib/agents.ts` — TA05 `listEnabledAgents`
- `web-ui/app/chat/page.tsx` + chat header — TA06 picker integration
- `web-ui/app/chat/_components/Composer.tsx` (or similar) — TA08 banner

---

## Out of scope (intentionally deferred)

- Channel plugins (Teams/Telegram in byte5 private repo) still consume
  `chatAgent@1` directly. Their migration to `channelResolver@1` is a
  separate ticket against the byte5-plugins repo and not blocked by
  this spec.
- Per-Agent plugin activation. This spec routes traffic to per-Agent
  Orchestrator instances but the per-Agent `PluginContext` work
  remains deferred (see HANDOFF-2026-05-26-feature-complete.md).
- Plugin-config editing per Agent (Phase C in the analysis).
- Plugin-multi-select with metadata (Phase B).

---

## Risk

- **Lazy snapshot of legacy sessions (FR-A7)** could surprise an
  operator: sessions started against the default `chatAgent` before
  Phase A may have used plugins/permissions not in the fallback's
  scope. On their next turn they pin to fallback, losing access. The
  banner pattern from TA08 covers the inverse case (deleted Agent);
  for legacy migration, a separate UI hint on the first
  post-Phase-A turn would soften the blow but is non-blocking.
- The chat router stops accepting an immutable `ChatAgent` singleton
  — every call now goes through the resolver function. Any future
  caller that imported `createChatRouter` and passed a bare agent
  will need an adapter shim. Grep for callers before the rollout;
  today there's only the kernel mount site.
