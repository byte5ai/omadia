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
 * Privacy-Proxy receipt (Slice 1a/5) — what the `privacy.redact@1`
 * provider did with the outbound payload of an assistant turn. Mirrors
 * the backend's `PrivacyReceipt` from `@omadia/plugin-api` one-to-one.
 *
 * Rendered as a collapsible row under the assistant answer by
 * `<PrivacyReceiptCard>`. The receipt is PII-free by construction: it carries
 * counts, types, detector ids and a forensic SHA-256, but never the raw
 * detected values, spans, or token bindings. Optional — turns from a build
 * without the privacy-guard plugin simply omit the field.
 */
export interface PrivacyReceipt {
  receiptId: string;
  policyMode: 'pii-shield' | 'data-residency';
  routing: 'public-llm' | 'local-llm' | 'blocked';
  routingReason?: string;
  detections: readonly PrivacyDetection[];
  latencyMs: number;
  auditHash: string;
  /**
   * Slice 3.2.1 — per-detector run summary. One entry per detector
   * registered with the privacy-guard plugin, even if it never fired.
   * The card uses run-status to bump severity when a detector silently
   * fail-opened (skipped/timeout/error), so the user sees the failure
   * mode instead of a misleading "keine Erkennungen".
   */
  detectorRuns?: readonly PrivacyDetectorRun[];
  /**
   * Slice 3.2.1 debug-mode flag. When true, `detections[*].values` may
   * carry raw matched substrings — operator opted in via
   * `debug_show_values=on` in the privacy-guard plugin setup.
   */
  debug?: boolean;
}

export interface PrivacyDetection {
  type: string;
  count: number;
  action: 'redacted' | 'tokenized' | 'blocked' | 'passed';
  detector: string;
  confidenceMin: number;
  /**
   * Slice 3.2.1 — distinct raw matched substrings for this bucket.
   * ONLY present when the receipt is in debug mode AND the action is
   * `tokenized` (`redacted`/`blocked` are intentionally destructive).
   * The card renders this verbatim under each detection row.
   */
  values?: readonly string[];
}

export type PrivacyDetectorStatus = 'ok' | 'skipped' | 'timeout' | 'error';

export interface PrivacyDetectorRun {
  detector: string;
  status: PrivacyDetectorStatus;
  callCount: number;
  hitCount: number;
  latencyMs: number;
  reason?: string;
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

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolEvent[];
  /** OB-77 — nudges emitted during this turn. Rendered after tools. */
  nudges?: NudgeEvent[];
  telemetry?: { tool_calls: number; iterations: number };
  /** Image URLs returned by orchestrator tools (e.g. render_diagram). */
  attachments?: DiagramAttachment[];
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

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
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
    return parsed.filter(isSession);
  } catch {
    return [];
  }
}

function isSession(v: unknown): v is ChatSession {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s['id'] === 'string' &&
    typeof s['title'] === 'string' &&
    typeof s['createdAt'] === 'number' &&
    typeof s['updatedAt'] === 'number' &&
    Array.isArray(s['messages'])
  );
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
  return (await res.json()) as ChatSession;
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

  // Refs kept in sync with state so persistActive reads the latest snapshot
  // without forcing callers to resubscribe on every message delta.
  const sessionsRef = useRef(sessions);
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

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
