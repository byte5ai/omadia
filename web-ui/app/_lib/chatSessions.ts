'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Persisted chat-tab sessions. Each tab is a self-contained session —
 * tab-id === session-id === orchestrator scope, so the knowledge graph
 * correlates every tab with exactly one Session node.
 *
 * Storage is hybrid:
 *   - localStorage: fast sync cache, available offline, source of truth
 *     while the app is running.
 *   - backend (`/bot-api/chat/sessions`): durable store. On mount we merge
 *     local + remote by `updatedAt` (whole-session last-write-wins). After
 *     each turn we PUT the active session so the backend stays in sync.
 */

/**
 * One observable step inside a sub-agent's inner tool loop, surfaced by the
 * orchestrator so the UI can render a nested trace under the parent tool
 * call. Kind discriminates which of the three shapes is valid.
 */
export interface SubAgentEvent {
  kind: 'iteration' | 'tool_use' | 'tool_result';
  at: number;
  id?: string;
  name?: string;
  input?: unknown;
  output?: string;
  durationMs?: number;
  isError?: boolean;
  iteration?: number;
}

export interface ToolEvent {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  durationMs?: number;
  isError?: boolean;
  /** Set when the `tool_use` event arrives; enables live elapsed display. */
  startedAt?: number;
  /** Last heartbeat's elapsed — only used while the tool is in flight. */
  liveElapsedMs?: number;
  /** Ordered stream of inner sub-agent events for nested rendering. */
  subEvents?: SubAgentEvent[];
  /** Server-resolved agent metadata for pill rendering. Set when `name`
   *  resolves to a built-in or Builder-uploaded agent; absent for helper
   *  tools (memory, ask_user_choice, render_diagram, …). */
  agent?: {
    id: string;
    label: string;
    tone: 'cyan' | 'navy' | 'magenta' | 'warning';
  };
}

/**
 * Image / media attachment emitted by an orchestrator tool. Currently only
 * `render_diagram` produces these; the shape mirrors the backend's
 * `DiagramAttachment` type one-to-one so the `done` event can be stored as-is.
 */
export interface DiagramAttachment {
  kind: 'image';
  url: string;
  altText: string;
  diagramKind: string;
  cacheHit: boolean;
}

/**
 * Downloadable file emitted by an orchestrator tool (e.g.
 * `@omadia/plugin-office`'s `create_xlsx` / `create_docx`). Mirrors the
 * backend's `OutgoingFileAttachment` so the `done` event stores as-is. The UI
 * renders it as a download link rather than an inline image.
 */
export interface OutgoingFileAttachment {
  kind: 'file';
  url: string;
  altText: string;
  mediaType: string;
  sizeBytes?: number;
  producer?: string;
}

/**
 * Smart-Card clarification request emitted by the orchestrator when the
 * `ask_user_choice` tool fires. The UI renders this as buttons under the
 * message; a click submits a fresh user turn with the chosen `value`.
 * Mirrors the backend's `PendingUserChoice` type.
 */
export interface PendingUserChoice {
  question: string;
  rationale?: string;
  options: Array<{ label: string; value: string }>;
}

/**
 * Non-blocking 1-click refinement options attached below an answer. Each
 * click submits `prompt` as a fresh user message. Mirrors the backend's
 * `FollowUpOption[]`.
 */
export interface FollowUpOption {
  label: string;
  prompt: string;
}

/**
 * Palaia capture-disclosure (OB-81) — what the orchestrator persisted into
 * the knowledge graph for an assistant turn. Mirrors the backend's
 * `CaptureDisclosure` (plugin-api/knowledgeGraph.ts) one-to-one. Rendered as
 * a collapsible row under the answer so the user can audit what landed in
 * Palaia. Optional — pre-OB-71 turns and turns from a `capture_level=off`
 * workspace simply omit the field.
 */
export interface CaptureDisclosure {
  persisted: boolean;
  reasons: readonly string[];
  entryType: 'memory' | 'process' | 'task' | null;
  visibility: string | null;
  significance: number | null;
  embedded: boolean;
  privacyBlocksStripped: number;
  hintTagsProcessed: number;
  graphRefs?: {
    sessionId: string;
    turnId: string;
    entityNodeIds: readonly string[];
  };
}

/**
 * Privacy Shield v4 receipt — the per-turn report from the `privacy.redact@1`
 * provider's Data-Plane Boundary. Mirrors the backend `PrivacyReceipt` from
 * `@omadia/plugin-api` one-to-one.
 *
 * Rendered as a collapsible row under the assistant answer by
 * `<PrivacyReceiptCard>`. PII-free by construction — counts and verb names
 * only, never a value. Optional — turns from a build without the
 * privacy-guard plugin, or turns that interned no tool result, omit it.
 */
export interface PrivacyReceipt {
  /** Tool results interned behind the data-plane boundary this turn. */
  datasetsInterned: number;
  /** Fields classified `sensitive-masked` across interned datasets. */
  fieldsMasked: number;
  /** Fields classified `safe-cleartext` across interned datasets. */
  fieldsCleartext: number;
  /** Verb names the LLM composed and the server executed this turn. */
  verbsExecuted: readonly string[];
  /** Whether the gated pseudonym-projection layer was released this turn. */
  pseudonymProjectionUsed: boolean;
  /**
   * Personal-identity values that reached the model because the requester
   * named them in their own message. A transparency notice, not a leak.
   * `0` / absent when the user named no one.
   */
  identityValuesOnWire?: number;
  /**
   * Slice 2.5 — tools whose raw results bypassed the data-plane boundary
   * this turn (operator set the originating plugin's `_privacy_mode` to
   * `bypass`). Surfaced as a dedicated "not masked" section in the card.
   * Absent / empty when no bypass fired. PII-free.
   */
  bypassedTools?: readonly BypassedToolEntry[];
}

/** Slice 2.5 — one entry in `PrivacyReceipt.bypassedTools`. */
export interface BypassedToolEntry {
  toolName: string;
  pluginId: string;
  reason: 'operator_setting';
  bytes: number;
}

/**
 * OB-77 (Palaia Phase 8) — Per-turn nudge collected from `'nudge'`
 * stream events. Rendered as a consolidated list under the tool trace
 * (NOT inside individual tool rows) so the operator sees coaching
 * regardless of which tool collapses by default.
 */
export interface NudgeEvent {
  /** tool_use_id the nudge fired against. */
  id: string;
  /** Provider id, e.g. `palaia.process-promote`. */
  nudgeId: string;
  text: string;
  cta?: {
    label: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Slice 4a — Palaia-Excerpt suggestion. Mirrors `PalaiaExcerpt` in
 * `@omadia/plugin-api` 1:1; declared locally so the web-ui bundle
 * doesn't need to pull the backend type-graph in. Backend-side shape
 * lives in `middleware/packages/plugin-api/src/palaiaExcerpt.ts`.
 */
export interface PalaiaExcerpt {
  suggestedKind: 'decision' | 'insight' | 'preference' | 'reference';
  suggestedSummary: string;
  suggestedRationale?: string;
  excerpts: readonly string[];
  source: 'llm' | 'hint' | 'fallback';
}

/** #133 (E9) — one PlanStep in the live plan snapshot streamed via a
 *  `turn_annotation` (channel `plan`) event. Mirrors the middleware's
 *  PlanSnapshot shape (the stream payload crosses the boundary as `unknown`). */
export interface PlanStepSnapshot {
  stepExternalId: string;
  order: number;
  goal: string;
  /** pending | in_progress | done | failed | skipped */
  status: string;
}

export interface PlanSnapshot {
  planExternalId: string;
  steps: PlanStepSnapshot[];
}

/** Cross-session recall probe — payload of the `kg_recall` turn_annotation.
 *  Mirrors the middleware's `RecalledContext` (crosses the boundary as
 *  `unknown`). Surfaces what the per-turn probe pulled from PRIOR sessions. */
export interface RecalledPlanSnapshot {
  planId: string;
  scope: string;
  strategy?: string;
  createdAt?: string;
  openStepGoals: string[];
  doneCount: number;
  totalCount: number;
}

export interface RecalledProcessSnapshot {
  id: string;
  title: string;
  scope: string;
  stepCount: number;
  score: number;
}

export interface RecalledInsightSnapshot {
  mkId: string;
  kind: string;
  summary: string;
  score: number;
}

export interface RecalledContextSnapshot {
  plans: RecalledPlanSnapshot[];
  processes: RecalledProcessSnapshot[];
  insights: RecalledInsightSnapshot[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** #133 (E9) — live plan DAG for this turn, streamed in as a `plan`
   *  annotation: present from the first event and re-emitted on every step
   *  change + replan. Persisted, so a reloaded session keeps the plan. */
  plan?: PlanSnapshot;
  /** Cross-session recall probe — plans/processes/insights the per-turn probe
   *  pulled from PRIOR sessions, streamed in as a `kg_recall` annotation
   *  before the answer. Persisted with the turn. */
  recalledContext?: RecalledContextSnapshot;
  /** KG-persisted Turn external_id (e.g. `turn:<sessionId>:<ts>`). Set
   *  from the orchestrator's `done` event when session-logging succeeded.
   *  Drives the save-as-memory affordance — without it there's no
   *  DERIVED_FROM anchor for a new MemorableKnowledge. */
  turnId?: string;
  /** Slice 4a — pre-classified suggestion from the Palaia-Excerpt-
   *  Extractor for this turn. Undefined when the extractor wasn't
   *  installed, the Haiku call failed, or the JSON couldn't be parsed
   *  — the save-as-memory modal then falls back to its 240-char
   *  prefill on the cleaned assistant answer. */
  palaiaExcerpt?: PalaiaExcerpt;
  /** Slice 4c — when this turn was auto-promoted (significance gate
   *  passed AND `KG_ACL_AUTO_PROMOTE=true`), carries the resulting MK
   *  external_id. The UI then renders an inline "Saved by Palaia"
   *  banner in place of the manual save-as-memory button. Cleared by
   *  the user's Discard action to allow re-saving. */
  autoPromotedMkId?: string;
  tools?: ToolEvent[];
  /** OB-77 — nudges emitted during this turn. Rendered after tools. */
  nudges?: NudgeEvent[];
  telemetry?: { tool_calls: number; iterations: number };
  /** Image URLs returned by orchestrator tools (e.g. render_diagram). */
  attachments?: DiagramAttachment[];
  /** Downloadable files returned by orchestrator tools (e.g. create_xlsx). */
  fileAttachments?: OutgoingFileAttachment[];
  /**
   * Set when the turn ended with an `ask_user_choice` Smart-Card request.
   * Cleared once the user clicks an option (or types a fresh message) so
   * the buttons disappear on re-renders of the conversation history.
   */
  pendingUserChoice?: PendingUserChoice;
  /**
   * Refinement buttons attached below the answer (from `suggest_follow_ups`).
   * Cleared once the user commits to a follow-up or types a fresh message,
   * so old messages don't keep offering stale refinements.
   */
  followUpOptions?: FollowUpOption[];
  /**
   * Palaia capture-disclosure for this turn — what the orchestrator
   * persisted into the knowledge graph. Rendered as an expandable row by
   * `<CaptureDisclosure>`. Undefined when the capture-pipeline is inactive
   * or the turn was emitted by a pre-OB-71 build.
   */
  captureDisclosure?: CaptureDisclosure;
  /**
   * Privacy-Proxy receipt for this turn — what the `privacy.redact@1`
   * provider did to the outbound payload (detected, masked, routed).
   * Rendered as an expandable row by `<PrivacyReceiptCard>`. Undefined
   * when no privacy-guard plugin is installed.
   */
  privacyReceipt?: PrivacyReceipt;
  /**
   * Privacy Shield v4 — real values in `content` that the LLM never saw,
   * resolved server-side behind the data-plane boundary. `<Markdown>`
   * highlights their occurrences in violet so the asker sees what was
   * protected. Undefined when the turn produced no server-materialized
   * answer or it exposed no masked field.
   */
  maskedValues?: readonly string[];
  error?: boolean;
  startedAt: number;
  finishedAt?: number;
  streaming?: boolean;
  /**
   * Theme E0+E1 liveness pulse — last `heartbeat` event from the route.
   * Drives the "Stream live · phase · iter · last activity" status row
   * shown under the assistant text while the turn is in flight.
   */
  liveness?: {
    sinceLastActivityMs: number;
    iteration: number;
    toolCallsThisIter: number;
    phase?: 'thinking' | 'streaming' | 'tool_running' | 'idle';
    tokensThisIter?: number;
  };
  /**
   * Theme E1 — last `tokensPerSec` from `stream_token_chunk`. Updates
   * sub-second so the rate display does not lag the 2s heartbeat.
   */
  tokensPerSec?: number;
  /**
   * Theme E1 — last `iteration_usage` snapshot. Drives the 🟢 cache-hit
   * indicator (when cacheReadInputTokens > 0).
   */
  lastUsage?: {
    inputTokens: number;
    cacheReadInputTokens: number;
  };
}

/**
 * Phase A — pinned Agent for the session. Mirrors the server-side
 * `SessionConfigSnapshot` (US6) but only carries the routing key the
 * picker needs. Backend persists the full snapshot; we read just the
 * slug to drive the read-only label after pinning.
 */
export interface SessionAgentSnapshot {
  agentSlug: string;
  capturedAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  snapshot?: SessionAgentSnapshot;
}

interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const LS_SESSIONS = 'odoo-bot-chat-sessions';
const LS_ACTIVE = 'odoo-bot-chat-active-id';
const LEGACY_SCOPE_KEY = 'odoo-bot-scope';
const TITLE_MAX = 60;

export function newSessionId(): string {
  const rnd = globalThis.crypto?.randomUUID?.();
  if (rnd) return rnd;
  const ts = Date.now().toString(36);
  const suffix = Math.random().toString(36).slice(2, 10);
  return `id-${ts}-${suffix}`;
}

export function deriveTitle(firstUserMessage: string | undefined): string {
  if (!firstUserMessage) return 'Neuer Chat';
  const single = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (single.length === 0) return 'Neuer Chat';
  return single.length > TITLE_MAX ? `${single.slice(0, TITLE_MAX - 1)}…` : single;
}

function emptySession(title = 'Neuer Chat'): ChatSession {
  const now = Date.now();
  return {
    id: newSessionId(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/**
 * Strip client-only flags before sending to the backend. `streaming` is UI
 * state, not persistent truth — if the tab closes mid-stream, the reloaded
 * view shouldn't re-animate dots forever.
 */
function sanitizeForPersist(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: session.messages.map((m) => {
      const {
        streaming: _streaming,
        liveness: _liveness,
        tokensPerSec: _tokensPerSec,
        lastUsage: _lastUsage,
        ...rest
      } = m;
      return rest;
    }),
  };
}

function readLocalSessions(): ChatSession[] {
  try {
    const raw = window.localStorage.getItem(LS_SESSIONS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Coerce rather than just filter: sessions persisted by an OLDER schema
    // (e.g. a message without `content`) used to pass the top-level guard yet
    // crash the render on `message.content.length`. Normalising on read keeps
    // stale localStorage from taking the whole app down with the browser's
    // cryptic "This page couldn't load" page (there's no SSR error to log).
    return parsed
      .map(coerceSession)
      .filter((s): s is ChatSession => s !== null);
  } catch {
    return [];
  }
}

/**
 * Coerce an untrusted value (old localStorage, a backend response from a
 * different build) into a render-safe ChatSession, or null when it lacks the
 * identity fields. Every field the UI reads with `.length` / `.map` / `for…of`
 * is guaranteed present with a safe default. The complement of the optimistic
 * `as ChatSession` casts that previously trusted these inputs blindly.
 */
export function coerceSession(v: unknown): ChatSession | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  if (typeof s['id'] !== 'string') return null;
  const now = Date.now();
  const messages = Array.isArray(s['messages'])
    ? (s['messages'] as unknown[])
        .map(coerceMessage)
        .filter((m): m is Message => m !== null)
    : [];
  const session: ChatSession = {
    id: s['id'],
    title: typeof s['title'] === 'string' ? s['title'] : 'Neuer Chat',
    createdAt: typeof s['createdAt'] === 'number' ? s['createdAt'] : now,
    updatedAt: typeof s['updatedAt'] === 'number' ? s['updatedAt'] : now,
    messages,
  };
  const snapshot = s['snapshot'];
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    typeof (snapshot as Record<string, unknown>)['agentSlug'] === 'string'
  ) {
    session.snapshot = snapshot as SessionAgentSnapshot;
  }
  return session;
}

/**
 * Coerce an untrusted message into a render-safe shape. Drops entries without
 * an id; defaults `content` to '' and the array-typed fields the UI iterates
 * (`tools`, `nudges`, …) to [] when a stale/foreign payload carries a non-array
 * there. Unknown extra fields are preserved.
 */
function coerceMessage(v: unknown): Message | null {
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  if (typeof m['id'] !== 'string') return null;
  const arrayFields = [
    'tools',
    'nudges',
    'attachments',
    'fileAttachments',
    'followUpOptions',
    'maskedValues',
  ] as const;
  const arrayDefaults: Record<string, unknown[]> = {};
  for (const key of arrayFields) {
    if (m[key] !== undefined && !Array.isArray(m[key])) arrayDefaults[key] = [];
  }
  return {
    ...(m as unknown as Message),
    id: m['id'],
    role: m['role'] === 'assistant' ? 'assistant' : 'user',
    content: typeof m['content'] === 'string' ? m['content'] : '',
    startedAt: typeof m['startedAt'] === 'number' ? m['startedAt'] : Date.now(),
    ...arrayDefaults,
  };
}

function writeLocalSessions(sessions: ChatSession[]): void {
  try {
    window.localStorage.setItem(
      LS_SESSIONS,
      JSON.stringify(sessions.map(sanitizeForPersist)),
    );
  } catch (err) {
    console.warn('[chat-sessions] localStorage write failed:', err);
  }
}

async function fetchRemoteSummaries(): Promise<SessionSummary[]> {
  const res = await fetch('/bot-api/chat/sessions');
  if (!res.ok) throw new Error(`GET sessions: HTTP ${String(res.status)}`);
  const body = (await res.json()) as { sessions: SessionSummary[] };
  return body.sessions;
}

async function fetchRemoteSession(id: string): Promise<ChatSession | null> {
  const res = await fetch(`/bot-api/chat/sessions/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET session: HTTP ${String(res.status)}`);
  // Coerce: a session persisted by a different build can arrive with a
  // drifted message shape; normalising here keeps it from crashing the render.
  return coerceSession(await res.json());
}

async function putRemoteSession(session: ChatSession): Promise<void> {
  const payload = sanitizeForPersist(session);
  const res = await fetch(`/bot-api/chat/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PUT session: HTTP ${String(res.status)} ${text}`);
  }
}

async function deleteRemoteSession(id: string): Promise<void> {
  const res = await fetch(`/bot-api/chat/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE session: HTTP ${String(res.status)}`);
  }
}

export interface UseChatSessionsResult {
  sessions: ChatSession[];
  activeId: string;
  activeSession: ChatSession;
  hydrating: boolean;
  createSession(): ChatSession;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  setActive(id: string): void;
  clearMessages(id: string): Promise<void>;
  mutateActive(mutator: (session: ChatSession) => ChatSession): void;
  persistActive(): Promise<void>;
}

/**
 * Owns session state for the chat page. Hydrates from localStorage, then
 * reconciles with the backend. All mutations are optimistic; backend writes
 * are fire-and-forget with error logging.
 */
export function useChatSessions(): UseChatSessionsResult {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [hydrating, setHydrating] = useState(true);

  // Debounced localStorage writes. Streaming a long answer triggers many
  // state updates; we don't need to serialize on every keystroke.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hydrating) return;
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      writeLocalSessions(sessions);
    }, 250);
    return () => {
      if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    };
  }, [sessions, hydrating]);

  useEffect(() => {
    if (hydrating) return;
    try {
      window.localStorage.setItem(LS_ACTIVE, activeId);
    } catch {
      /* quota/privacy mode — ignore */
    }
  }, [activeId, hydrating]);

  // Hydrate once on mount: local → merge with remote summaries → fetch any
  // remote-only / remote-newer full sessions.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const local = readLocalSessions();
      const legacyScope = (() => {
        try {
          const v = window.localStorage.getItem(LEGACY_SCOPE_KEY);
          return typeof v === 'string' && v.length > 0 ? v : null;
        } catch {
          return null;
        }
      })();

      // Show local data immediately so the UI is responsive during the
      // backend round-trip.
      if (local.length > 0) {
        setSessions(local);
        const storedActive = (() => {
          try {
            return window.localStorage.getItem(LS_ACTIVE) ?? '';
          } catch {
            return '';
          }
        })();
        const initialActive =
          local.find((s) => s.id === storedActive)?.id ?? local[0]?.id ?? '';
        setActiveId(initialActive);
      }

      let remoteSummaries: SessionSummary[] = [];
      try {
        remoteSummaries = await fetchRemoteSummaries();
      } catch (err) {
        console.warn(
          '[chat-sessions] remote list failed, using local only:',
          err instanceof Error ? err.message : err,
        );
      }
      if (cancelled) return;

      const localById = new Map(local.map((s) => [s.id, s]));
      const remoteById = new Map(remoteSummaries.map((s) => [s.id, s]));

      // For every ID on either side, decide which source wins and fetch full
      // bodies where needed.
      const allIds = new Set<string>([...localById.keys(), ...remoteById.keys()]);
      const merged: ChatSession[] = [];

      for (const id of allIds) {
        const l = localById.get(id);
        const r = remoteById.get(id);
        if (l && r) {
          if (r.updatedAt > l.updatedAt) {
            try {
              const remote = await fetchRemoteSession(id);
              merged.push(remote ?? l);
            } catch {
              merged.push(l);
            }
          } else {
            merged.push(l);
            // Backend is behind — push our copy once (don't block hydration).
            if (l.updatedAt > r.updatedAt) {
              putRemoteSession(l).catch((err: unknown) => {
                console.warn(
                  '[chat-sessions] backend catch-up put failed:',
                  err instanceof Error ? err.message : err,
                );
              });
            }
          }
        } else if (r) {
          try {
            const remote = await fetchRemoteSession(id);
            if (remote) merged.push(remote);
          } catch (err) {
            console.warn(
              `[chat-sessions] failed to fetch remote-only session ${id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        } else if (l) {
          merged.push(l);
          putRemoteSession(l).catch((err: unknown) => {
            console.warn(
              '[chat-sessions] initial put of local session failed:',
              err instanceof Error ? err.message : err,
            );
          });
        }
      }

      if (cancelled) return;

      if (merged.length === 0) {
        const initial = emptySession(
          legacyScope ? `Legacy-Scope: ${legacyScope}` : 'Neuer Chat',
        );
        setSessions([initial]);
        setActiveId(initial.id);
        putRemoteSession(initial).catch(() => {
          /* first-run offline — the debounced local write still captures it */
        });
      } else {
        merged.sort((a, b) => b.updatedAt - a.updatedAt);
        setSessions(merged);
        const storedActive = (() => {
          try {
            return window.localStorage.getItem(LS_ACTIVE) ?? '';
          } catch {
            return '';
          }
        })();
        const nextActive =
          merged.find((s) => s.id === storedActive)?.id ?? merged[0]?.id ?? '';
        setActiveId(nextActive);
      }

      setHydrating(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const createSession = useCallback((): ChatSession => {
    const s = emptySession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    putRemoteSession(s).catch((err: unknown) => {
      console.warn(
        '[chat-sessions] create PUT failed:',
        err instanceof Error ? err.message : err,
      );
    });
    return s;
  }, []);

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (next.length === 0) {
          const fresh = emptySession();
          setActiveId(fresh.id);
          putRemoteSession(fresh).catch(() => {
            /* ignore */
          });
          return [fresh];
        }
        setActiveId((current) => {
          if (current !== id) return current;
          return next[0]?.id ?? '';
        });
        return next;
      });
      try {
        await deleteRemoteSession(id);
      } catch (err) {
        console.warn(
          '[chat-sessions] delete backend failed:',
          err instanceof Error ? err.message : err,
        );
      }
    },
    [],
  );

  const renameSession = useCallback(
    async (id: string, title: string): Promise<void> => {
      const trimmed = title.trim().length === 0 ? 'Neuer Chat' : title.trim();
      let updated: ChatSession | undefined;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          updated = { ...s, title: trimmed, updatedAt: Date.now() };
          return updated;
        }),
      );
      if (updated) {
        try {
          await putRemoteSession(updated);
        } catch (err) {
          console.warn(
            '[chat-sessions] rename PUT failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }
    },
    [],
  );

  const clearMessages = useCallback(
    async (id: string): Promise<void> => {
      let updated: ChatSession | undefined;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          updated = { ...s, messages: [], updatedAt: Date.now() };
          return updated;
        }),
      );
      if (updated) {
        try {
          await putRemoteSession(updated);
        } catch (err) {
          console.warn(
            '[chat-sessions] clear PUT failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }
    },
    [],
  );

  const mutateActive = useCallback(
    (mutator: (session: ChatSession) => ChatSession): void => {
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? mutator(s) : s)),
      );
    },
    [activeId],
  );

  // Refs kept in sync with state so persistActive reads the latest snapshot
  // without forcing callers to resubscribe on every message delta. Declared —
  // and synced — *before* persistActive so the React-Compiler `immutability`
  // rule sees the `.current` writes happen before the useCallback closes over
  // the refs. Initialised with throwaway literals (identical to the `useState`
  // initial values); the effects below own the actual sync.
  const sessionsRef = useRef<ChatSession[]>([]);
  const activeIdRef = useRef<string>('');
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const persistActive = useCallback(async (): Promise<void> => {
    const snapshot = sessionsRef.current.find((s) => s.id === activeIdRef.current);
    if (!snapshot) return;
    try {
      await putRemoteSession(snapshot);
    } catch (err) {
      console.warn(
        '[chat-sessions] persistActive failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }, []);

  // Always return *some* active session so the caller doesn't have to guard.
  // Build an ephemeral empty one during the brief hydrating window.
  const activeSession =
    sessions.find((s) => s.id === activeId) ??
    (sessions[0] as ChatSession | undefined) ??
    emptySession();

  return {
    sessions,
    activeId: activeSession.id,
    activeSession,
    hydrating,
    createSession,
    deleteSession,
    renameSession,
    setActive: setActiveId,
    clearMessages,
    mutateActive,
    persistActive,
  };
}
