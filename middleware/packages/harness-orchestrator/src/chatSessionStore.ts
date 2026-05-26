import type { MemoryStore } from '@omadia/plugin-api';

/**
 * Persisted chat sessions for the dev-UI chat tab. Each session is a
 * self-contained JSON document under `/memories/chat-sessions/<id>.json`,
 * stored via the same MemoryStore that backs the rest of the /memories
 * namespace. This keeps chat history on the same persistence surface as the
 * session transcripts the SessionLogger writes — but with richer structure
 * (tool-trace events, telemetry, streaming markers) that a markdown
 * transcript can't carry.
 *
 * ID contract: caller-supplied, restricted to `[A-Za-z0-9_-]{1,80}`. The
 * frontend generates UUIDs and uses the same id as the orchestrator scope,
 * so the knowledge graph correlates chat tabs 1:1 with Session nodes.
 */

const DIR = '/memories/chat-sessions';
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * A single observable event from a sub-agent's inner tool loop, captured by
 * the orchestrator's observer callback and mirrored into the chat UI. Persist
 * these so reloading a session still shows the full trace of what a long
 * domain-tool call actually did.
 */
export interface ChatSubAgentEvent {
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

export interface ChatToolEvent {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  durationMs?: number;
  isError?: boolean;
  /** Wall-clock start timestamp, set when the orchestrator emits `tool_use`. */
  startedAt?: number;
  /** Heartbeat-updated elapsed timer while the tool is in flight. */
  liveElapsedMs?: number;
  /** Ordered stream of inner sub-agent events captured during this tool call. */
  subEvents?: ChatSubAgentEvent[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools?: ChatToolEvent[];
  telemetry?: { tool_calls: number; iterations: number };
  error?: boolean;
  startedAt: number;
  finishedAt?: number;
}

/**
 * Per-session config snapshot (US6 / T024).
 *
 * Captured at session start and pinned for the session's entire lifetime so
 * a mid-flight reload (US5) cannot mutate the tool / plugin / memory-scope
 * surface a turn is reasoning over. The session's `agentSlug` is the
 * routing key — even if the registry rebuilds the Agent, the session keeps
 * the snapshot's view until a `force-invalidate` (T026) flips it.
 *
 * The snapshot stores **ids only**, not live object references — sessions
 * are serialised to JSON on disk, so the data must round-trip. The actual
 * `Orchestrator` instance is resolved lazily from the registry on each
 * turn using `agentSlug`; the snapshot's tool / plugin lists are the
 * authoritative view of what the session is allowed to see (US8 will
 * wire memory-scope enforcement against this list).
 */
export interface SessionConfigSnapshot {
  agentSlug: string;
  pluginIds: string[];
  toolIds: string[];
  memoryScope: string[];
  capturedAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** US6 — captured at session start; immutable until a force-invalidate
   *  (drain or kill) replaces or clears it. Optional because legacy sessions
   *  pre-date this field. */
  snapshot?: SessionConfigSnapshot;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export class InvalidSessionIdError extends Error {
  constructor(id: string) {
    super(`invalid chat session id: ${id}`);
    this.name = 'InvalidSessionIdError';
  }
}

export class ChatSessionStore {
  constructor(private readonly store: MemoryStore) {}

  /** Summary of all persisted sessions, newest `updatedAt` first. */
  async list(): Promise<ChatSessionSummary[]> {
    if (!(await this.store.directoryExists(DIR))) return [];

    const entries = await this.store.list(DIR);
    const summaries: ChatSessionSummary[] = [];

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (!entry.virtualPath.endsWith('.json')) continue;
      try {
        const raw = await this.store.readFile(entry.virtualPath);
        const parsed = JSON.parse(raw) as ChatSession;
        summaries.push({
          id: parsed.id,
          title: parsed.title,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        });
      } catch (err) {
        // Unreadable/corrupt file — skip but log so a dev notices. Never throw;
        // the UI should still load the rest.
        console.warn(
          `[chat-sessions] skip unreadable file ${entry.virtualPath}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  async get(id: string): Promise<ChatSession | null> {
    const virtualPath = this.pathFor(id);
    if (!(await this.store.fileExists(virtualPath))) return null;
    const raw = await this.store.readFile(virtualPath);
    return JSON.parse(raw) as ChatSession;
  }

  async save(session: ChatSession): Promise<void> {
    if (!ID_RE.test(session.id)) throw new InvalidSessionIdError(session.id);
    const virtualPath = this.pathFor(session.id);
    await this.store.writeFile(virtualPath, JSON.stringify(session, null, 2));
  }

  /**
   * Capture-on-first-use (US6 / T024). Returns the session's existing
   * snapshot if one is set; otherwise asks `source()` for a fresh snapshot,
   * persists it, and returns it. The session's other fields are unchanged.
   *
   * Returns `null` when the session does not exist — the caller decides
   * whether to lazy-create or to refuse the turn.
   *
   * `source()` is async because most snapshot sources will read the live
   * registry, which is in-memory but the wider tool/plugin enumeration may
   * involve async lookups (US8 memory-scope resolution).
   */
  async captureSnapshot(
    id: string,
    source: () => Promise<SessionConfigSnapshot>,
  ): Promise<SessionConfigSnapshot | null> {
    const session = await this.get(id);
    if (!session) return null;
    if (session.snapshot) return session.snapshot;
    const snap = await source();
    const updated: ChatSession = {
      ...session,
      snapshot: snap,
      updatedAt: Date.now(),
    };
    await this.save(updated);
    return snap;
  }

  /**
   * Drop the session's snapshot so the next turn re-captures from the
   * registry (US6 `force-invalidate drain` semantics, T026 — keep history,
   * re-bind to the current Agent config).
   */
  async clearSnapshot(id: string): Promise<void> {
    const session = await this.get(id);
    if (!session) return;
    if (!session.snapshot) return;
    const { snapshot: _snapshot, ...rest } = session;
    await this.save({ ...rest, updatedAt: Date.now() });
  }

  /**
   * Reset a session: keep id / title / createdAt, drop all messages, bump
   * updatedAt. Returns the updated session, or null when the session was
   * not found. KG / Memory are NOT touched — the agent simply enters its
   * next turn with an empty context window.
   */
  async resetMessages(id: string): Promise<ChatSession | null> {
    if (!ID_RE.test(id)) throw new InvalidSessionIdError(id);
    const existing = await this.get(id);
    if (!existing) return null;
    const updated: ChatSession = {
      ...existing,
      messages: [],
      updatedAt: Date.now(),
    };
    await this.save(updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const virtualPath = this.pathFor(id);
    if (!(await this.store.fileExists(virtualPath))) return;
    await this.store.delete(virtualPath);
  }

  /**
   * Server-side turn append. Called by the SessionLogger after a completed
   * turn so a mid-stream client reload still recovers the assistant answer.
   * Semantics:
   * - If the session doesn't exist yet, create it with a title derived from
   *   the first user message.
   * - If the last two messages already match this turn (user + assistant,
   *   identical content), skip — the client's own PUT has already landed.
   * - Otherwise append the user+assistant pair and bump updatedAt.
   */
  async appendTurnFromServer(
    id: string,
    turn: {
      userMessage: string;
      assistantMessage: string;
      telemetry?: { tool_calls: number; iterations: number };
      startedAt: number;
      finishedAt: number;
    },
  ): Promise<void> {
    if (!ID_RE.test(id)) return;
    const now = Date.now();
    const existing = await this.get(id);

    const userMsg: ChatMessage = {
      id: `srv-u-${String(turn.startedAt)}`,
      role: 'user',
      content: turn.userMessage,
      startedAt: turn.startedAt,
      finishedAt: turn.startedAt,
    };
    const assistantMsg: ChatMessage = {
      id: `srv-a-${String(turn.finishedAt)}`,
      role: 'assistant',
      content: turn.assistantMessage,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      ...(turn.telemetry ? { telemetry: turn.telemetry } : {}),
    };

    if (!existing) {
      const session: ChatSession = {
        id,
        title: deriveTitle(turn.userMessage),
        createdAt: now,
        updatedAt: now,
        messages: [userMsg, assistantMsg],
      };
      await this.save(session);
      return;
    }

    // Idempotency: if the client has already PUT this exact pair, don't dupe.
    const tail = existing.messages.slice(-2);
    const alreadyPersisted =
      tail.length === 2 &&
      tail[0]?.role === 'user' &&
      tail[0]?.content === turn.userMessage &&
      tail[1]?.role === 'assistant' &&
      tail[1]?.content === turn.assistantMessage;
    if (alreadyPersisted) return;

    const updated: ChatSession = {
      ...existing,
      updatedAt: now,
      messages: [...existing.messages, userMsg, assistantMsg],
    };
    await this.save(updated);
  }

  private pathFor(id: string): string {
    if (!ID_RE.test(id)) throw new InvalidSessionIdError(id);
    return `${DIR}/${id}.json`;
  }
}

export function isValidSessionId(id: string): boolean {
  return ID_RE.test(id);
}

const TITLE_MAX = 60;

function deriveTitle(firstUserMessage: string): string {
  const single = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (single.length === 0) return 'Neuer Chat';
  return single.length > TITLE_MAX
    ? `${single.slice(0, TITLE_MAX - 1)}…`
    : single;
}
