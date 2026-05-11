import type { MemoryStore } from '@omadia/plugin-api';
import { turnNodeId, type EntityRef, type KnowledgeGraph } from '@omadia/plugin-api';
import { isValidSessionId, type ChatSessionStore } from './chatSessionStore.js';
import type { RunTracePayload } from './runTraceCollector.js';

export interface SessionLogEntry {
  /** Scope identifier — Teams conversation id, 'http', etc. Becomes a safe dir name. */
  scope: string;
  userMessage: string;
  assistantAnswer: string;
  toolCalls?: number;
  iterations?: number;
  /**
   * Structured anchors for entities touched during this turn, captured by the
   * middleware proxies before response summarisation. Serialised as an HTML
   * comment inside the turn block so the Markdown stays human-readable while
   * a downstream graph-ingest has a deterministic JSON payload to parse.
   */
  entityRefs?: EntityRef[];
  /**
   * Stable identity of the human behind the turn — Teams AAD object id or the
   * HTTP `x-user-id` header. Propagated to the graph for per-user filtering.
   * Not written into the markdown transcript (privacy/readability).
   */
  userId?: string;
  /**
   * Agentic run-graph payload collected by the orchestrator. When present
   * (and a graph sink is configured) the logger fills in the canonical
   * turn id and calls ingestRun alongside ingestTurn.
   */
  runTrace?: RunTracePayload;
}

const USER_MSG_MAX = 1_500;
const ASSISTANT_MSG_MAX = 6_000;
const SCOPE_MAX_LEN = 80;

/**
 * Appends chronological Q&A transcripts to the memory store so future turns can
 * look up "what did we discuss before?". The middleware writes these itself — not
 * Claude — so the record survives mid-turn crashes and doesn't cost orchestrator
 * tokens. Claude reads them when a follow-up references prior discussion.
 *
 * Layout: /memories/sessions/<scope>/YYYY-MM-DD.md
 * One file per scope per day; turns are appended chronologically.
 */
export class SessionLogger {
  constructor(
    private readonly store: MemoryStore,
    /** Optional graph sink — when present, each successful log also ingests
     * Session / Turn / Entity nodes. Failures are swallowed so the markdown
     * transcript remains the guaranteed source of truth. */
    private readonly graph?: KnowledgeGraph,
    /** Optional chat-session store. When the scope looks like a chat-tab id
     * (ID_RE-valid, not prefixed with 'http-'/'teams-'), each completed turn
     * is mirrored into the store so a mid-stream reload still recovers the
     * assistant answer without needing the client to PUT. */
    private readonly chatSessionStore?: ChatSessionStore,
  ) {}

  async log(entry: SessionLogEntry): Promise<{ turnExternalId: string }> {
    const now = new Date();
    const iso = now.toISOString();
    const day = iso.slice(0, 10);
    // Millisecond-precision time so back-to-back turns have unique ids. Trade
    // a few characters of header noise for collision-free graph backfill.
    const time = iso.slice(11, 23);
    const scope = sanitizeScope(entry.scope);
    const entityRefs = dedupeEntityRefs(entry.entityRefs ?? []);
    const earlyTurnId = turnNodeId(scope, iso);

    const startedAt = now.getTime();

    try {
      const virtualPath = `/memories/sessions/${scope}/${day}.md`;
      const turn = renderTurn({
        time,
        userMessage: truncate(entry.userMessage, USER_MSG_MAX),
        assistantAnswer: truncate(entry.assistantAnswer, ASSISTANT_MSG_MAX),
        toolCalls: entry.toolCalls,
        iterations: entry.iterations,
        entityRefs,
      });

      const previous = (await this.store.fileExists(virtualPath))
        ? await this.store.readFile(virtualPath)
        : renderHeader(scope, day);

      await this.store.writeFile(virtualPath, previous + turn);
    } catch (err) {
      console.error(
        '[session-log] markdown write failed:',
        err instanceof Error ? err.message : err,
      );
      // Don't try graph ingest if the markdown write fell over — keeps the
      // two surfaces consistent (either both recorded the turn, or neither).
      return { turnExternalId: earlyTurnId };
    }

    // Server-side chat-session mirror. Silently skipped for non-chat scopes
    // (http-*, teams-*) or if no chat store is wired. This is the recovery
    // path for mid-stream reloads — the client's own PUT idempotency dedupes
    // when both paths land.
    if (this.chatSessionStore && isChatSessionScope(scope)) {
      try {
        await this.chatSessionStore.appendTurnFromServer(scope, {
          userMessage: entry.userMessage,
          assistantMessage: entry.assistantAnswer,
          ...(entry.toolCalls !== undefined && entry.iterations !== undefined
            ? {
                telemetry: {
                  tool_calls: entry.toolCalls,
                  iterations: entry.iterations,
                },
              }
            : {}),
          startedAt,
          finishedAt: Date.now(),
        });
      } catch (err) {
        console.error(
          '[session-log] chat-session mirror failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (this.graph) {
      const turnExternalId = turnNodeId(scope, iso);
      try {
        await this.graph.ingestTurn({
          scope,
          time: iso,
          userMessage: entry.userMessage,
          assistantAnswer: entry.assistantAnswer,
          toolCalls: entry.toolCalls,
          iterations: entry.iterations,
          entityRefs,
          ...(entry.userId ? { userId: entry.userId } : {}),
        });
      } catch (err) {
        console.error(
          '[session-log] graph ingest failed:',
          err instanceof Error ? err.message : err,
        );
        // Skip run-trace ingest if the turn write failed — keeps the graph
        // internally consistent (no Run pointing at a missing Turn).
        return { turnExternalId };
      }

      if (entry.runTrace) {
        try {
          await this.graph.ingestRun({
            ...entry.runTrace,
            turnId: turnExternalId,
          });
        } catch (err) {
          console.error(
            '[session-log] run-trace ingest failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }
      return { turnExternalId };
    }
    return { turnExternalId: turnNodeId(scope, iso) };
  }
}

function sanitizeScope(scope: string): string {
  if (!scope || scope.trim().length === 0) return 'unscoped';
  return scope
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SCOPE_MAX_LEN)
    .toLowerCase();
}

function truncate(value: string, max: number): string {
  const normalised = value.replace(/\r\n/g, '\n');
  if (normalised.length <= max) return normalised;
  return `${normalised.slice(0, max)}\n\n…[gekürzt, Original ${normalised.length} Zeichen]`;
}

function renderHeader(scope: string, day: string): string {
  return [
    `# Session-Transkript — ${scope} — ${day}`,
    '',
    'Chronologisches Protokoll der Q&A-Turns in diesem Scope. Wird von der',
    'Middleware geschrieben, nicht von Claude. Bei wiederkehrenden Themen oder',
    'Rückbezügen auf frühere Gespräche gezielt hier nachschlagen, statt den',
    'gesamten Sub-Agent-Roundtrip zu wiederholen.',
    '',
    '---',
    '',
    '',
  ].join('\n');
}

function renderTurn(args: {
  time: string;
  userMessage: string;
  assistantAnswer: string;
  toolCalls?: number;
  iterations?: number;
  entityRefs: EntityRef[];
}): string {
  const telemetry =
    args.toolCalls !== undefined || args.iterations !== undefined
      ? `\n*Telemetrie: tools=${args.toolCalls ?? '?'}, iterations=${args.iterations ?? '?'}*\n`
      : '';
  // Entity anchors ride as an HTML comment so humans reading the .md see a
  // clean transcript while a graph-ingest parser picks them up deterministically.
  // Shape: <!-- entities: [{"s":"<source>","m":"<model>","id":42,"n":"<name>"}, …] -->
  const entitiesComment =
    args.entityRefs.length > 0
      ? `\n<!-- entities: ${JSON.stringify(args.entityRefs.map(serialiseRef))} -->\n`
      : '';
  return [
    `### ${args.time}Z`,
    '',
    '**User:**',
    '',
    args.userMessage,
    '',
    '**Assistant:**',
    '',
    args.assistantAnswer,
    telemetry,
    entitiesComment,
    '',
    '---',
    '',
    '',
  ].join('\n');
}

function serialiseRef(ref: EntityRef): Record<string, unknown> {
  // Short keys to keep the inline comment compact; the ingest-side parser
  // maps them back onto the full EntityRef shape.
  const out: Record<string, unknown> = {
    s: ref.system,
    m: ref.model,
    id: ref.id,
  };
  if (ref.displayName) out['n'] = ref.displayName;
  return out;
}

/**
 * A scope is a chat-session id when it's ID_RE-valid and NOT one of the
 * reserved prefixes used by other surfaces (http-*, teams-*). This keeps
 * the server-side chat-session mirror from accidentally creating entries
 * for HTTP smoke tests or Teams conversations.
 */
function isChatSessionScope(scope: string): boolean {
  if (scope.startsWith('http-') || scope.startsWith('teams-')) return false;
  return isValidSessionId(scope);
}

function dedupeEntityRefs(refs: EntityRef[]): EntityRef[] {
  const seen = new Map<string, EntityRef>();
  for (const ref of refs) {
    const key = `${ref.system}|${ref.model}|${ref.id}`;
    const existing = seen.get(key);
    // Keep the first one that carries a displayName; otherwise whichever came first.
    if (!existing) {
      seen.set(key, ref);
    } else if (!existing.displayName && ref.displayName) {
      seen.set(key, ref);
    }
  }
  return [...seen.values()];
}
