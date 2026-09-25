import type { MemoryStore } from '@omadia/plugin-api';
import type { DirectLineSessionState } from '@omadia/channel-sdk';

import { withSessionLock } from './chatSessionLock.js';
import { mergeServerProactiveMessages } from './chatSessionProactive.js';

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
  /**
   * #445 — sticky Direct-Line indicator as of this turn, so a reload restores
   * the banner instead of dropping it. Optional: legacy messages pre-date it.
   */
  directLineSession?: DirectLineSessionState;
  /**
   * #1071 — set only on messages the SERVER wrote into the session without a
   * user turn: a scheduled routine's output delivered to the web chat. The
   * marker is what lets a stale whole-document PUT from an open tab keep the
   * delivery (`mergeServerProactiveMessages`), keeps the message out of the
   * model's replayed tail (`chatSessionTailTurns`) and drives the UI badge.
   * Trusted only from the server's own copy — a client cannot mint one.
   */
  proactive?: ChatProactiveMarker;
}

export interface ChatProactiveMarker {
  deliveredAt: number;
  routineId?: string;
  routineName?: string;
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

/**
 * Issue #1087 — the newest `limit` COMPLETED turns of a persisted chat, oldest
 * first, in the pair shape the subscription-CLI agent replays into its prompt.
 *
 * Lives next to the message shape rather than at the call site because the
 * pairing rules are properties of that shape:
 *  - a session is a flat message list, so a turn is a user message plus the
 *    answer that follows it;
 *  - a trailing unanswered user message is dropped defensively: were it the
 *    turn IN FLIGHT, replaying it would hand the model the current question a
 *    second time. Neither writer actually stores the live question early — the
 *    web UI PUTs the session on create and after each turn (`StreamRunner`'s
 *    `finally`), `appendTurnFromServer` writes whole pairs — so the store
 *    usually lags by a whole turn rather than holding the question;
 *  - failed (`error`) and blank answers are dropped, so a broken prior turn
 *    cannot poison the next prompt. When two user messages arrive back to back
 *    the later one owns the answer.
 */
export function chatSessionTailTurns(
  messages: readonly ChatMessage[],
  limit: number,
): Array<{ userMessage: string; assistantAnswer: string }> {
  if (limit <= 0) return [];

  const turns: Array<{ userMessage: string; assistantAnswer: string }> = [];
  let pendingUser: string | undefined;

  for (const message of messages) {
    // #1071 — a routine's proactive delivery is not an answer to anything the
    // user asked. Skip it WITHOUT resetting `pendingUser`: were it paired, a
    // routine report landing after an unanswered question would be replayed
    // to the model as that question's answer.
    if (message.proactive) continue;
    if (message.role === 'user') {
      pendingUser = message.content;
      continue;
    }
    if (pendingUser === undefined) continue;
    if (
      message.error !== true &&
      pendingUser.trim().length > 0 &&
      message.content.trim().length > 0
    ) {
      turns.push({ userMessage: pendingUser, assistantAnswer: message.content });
    }
    pendingUser = undefined;
  }

  return turns.slice(-limit);
}

/** A completed turn the SessionLogger mirrors into the session. */
interface ServerTurn {
  userMessage: string;
  assistantMessage: string;
  telemetry?: { tool_calls: number; iterations: number };
  startedAt: number;
  finishedAt: number;
}

export class ChatSessionStore {
  constructor(private readonly store: MemoryStore) {}

  /** #1071 — module-wide per-session lock, see `chatSessionLock.ts`. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return withSessionLock(id, fn);
  }

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
    return this.withLock(id, async () => {
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
    });
  }

  /**
   * Drop the session's snapshot so the next turn re-captures from the
   * registry (US6 `force-invalidate drain` semantics, T026 — keep history,
   * re-bind to the current Agent config).
   */
  async clearSnapshot(id: string): Promise<void> {
    await this.withLock(id, async () => {
      const session = await this.get(id);
      if (!session) return;
      if (!session.snapshot) return;
      const { snapshot: _snapshot, ...rest } = session;
      await this.save({ ...rest, updatedAt: Date.now() });
    });
  }

  /**
   * Reset a session: keep id / title / createdAt, drop all messages, bump
   * updatedAt. Returns the updated session, or null when the session was
   * not found. KG / Memory are NOT touched — the agent simply enters its
   * next turn with an empty context window.
   */
  async resetMessages(id: string): Promise<ChatSession | null> {
    if (!ID_RE.test(id)) throw new InvalidSessionIdError(id);
    return this.withLock(id, async () => {
      const existing = await this.get(id);
      if (!existing) return null;
      const updated: ChatSession = {
        ...existing,
        messages: [],
        updatedAt: Date.now(),
      };
      await this.save(updated);
      return updated;
    });
  }

  /**
   * #1071 — persist a client PUT without dropping server-written proactive
   * messages the client has not seen yet. Returns the document as stored.
   */
  async saveFromClient(session: ChatSession): Promise<ChatSession> {
    if (!ID_RE.test(session.id)) throw new InvalidSessionIdError(session.id);
    return this.withLock(session.id, async () => {
      // A corrupt stored file must not turn every PUT into a 500 — before
      // #1071 a PUT overwrote (and so repaired) it. Fall back to that.
      let existing: ChatSession | null = null;
      try {
        existing = await this.get(session.id);
      } catch (err) {
        console.warn(
          `[chat-sessions] unreadable session ${session.id}, overwriting from client:`,
          err instanceof Error ? err.message : err,
        );
      }
      const merged = mergeServerProactiveMessages(existing, session);
      await this.save(merged);
      return merged;
    });
  }

  /**
   * #1071 — append a scheduled routine's output to an EXISTING session as an
   * assistant message. Never creates a session: a chat the user deleted stays
   * deleted, and the caller reports `not_found` as a delivery failure.
   */
  async appendProactiveMessage(
    id: string,
    message: { content: string; deliveredAt: number; routineId?: string; routineName?: string },
  ): Promise<'appended' | 'not_found'> {
    if (!ID_RE.test(id)) return 'not_found';
    return this.withLock(id, async () => {
      const existing = await this.get(id);
      if (!existing) return 'not_found';
      const proactive: ChatProactiveMarker = {
        deliveredAt: message.deliveredAt,
        ...(message.routineId !== undefined ? { routineId: message.routineId } : {}),
        ...(message.routineName !== undefined ? { routineName: message.routineName } : {}),
      };
      const appended: ChatMessage = {
        id: `proactive-${message.routineId ?? 'reminder'}-${String(message.deliveredAt)}`,
        role: 'assistant',
        content: message.content,
        startedAt: message.deliveredAt,
        finishedAt: message.deliveredAt,
        proactive,
      };
      await this.save({
        ...existing,
        messages: [...existing.messages, appended],
        updatedAt: Math.max(Date.now(), existing.updatedAt),
      });
      return 'appended';
    });
  }

  async delete(id: string): Promise<void> {
    const virtualPath = this.pathFor(id);
    await this.withLock(id, async () => {
      if (!(await this.store.fileExists(virtualPath))) return;
      await this.store.delete(virtualPath);
    });
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
    turn: ServerTurn,
  ): Promise<void> {
    if (!ID_RE.test(id)) return;
    await this.withLock(id, () => this.appendTurnUnlocked(id, turn));
  }

  private async appendTurnUnlocked(
    id: string,
    turn: ServerTurn,
  ): Promise<void> {
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
