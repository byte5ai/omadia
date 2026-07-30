/**
 * Mid-call user input for MCP tools — MRTR `resultType: "input_required"`
 * (issue #544, W2-1).
 *
 * ## What MRTR asks for, and what we actually do
 *
 * The MCP "mid-request tool result" shape lets a server answer a `tools/call`
 * with `resultType: "input_required"` plus a list of `inputRequests`, meaning
 * "I cannot finish without more information from the human". The spec imagines
 * the client collecting that input and **retrying the original request**, with
 * the server-side call still logically in flight.
 *
 * omadia cannot do that today, and this module is deliberately explicit about
 * it. There is no per-turn suspend/resume store anywhere in the orchestrator:
 * `turnContext` is an `AsyncLocalStorage` whose lifetime *is* the turn, and
 * parking a turn mid-tool-loop would hold an HTTP/Teams connection open past
 * every proxy and channel idle timeout. So W2-1 rides the pattern that already
 * exists for `ask_user_choice`: the turn **ends**, the channel renders a card,
 * and the user's answer arrives as a *fresh turn* which replays the call.
 *
 * ### Accepted cost (say this out loud in review)
 *
 * The replay is a NEW `tools/call` in a LATER turn, against a possibly
 * reconnected transport — the pooled client may have been dropped and rebuilt
 * in between. For a stateless HTTP server that is indistinguishable from the
 * retry MRTR describes. For a **stdio server holding process state** tied to
 * the original in-flight call, it is not: that state may be gone, and the
 * server sees a fresh call rather than a continuation. Servers that need true
 * continuation semantics are out of scope until omadia has a real turn
 * suspend/resume store.
 *
 * ## Security: the store key is not a detail
 *
 * A parked record is replayed with whatever free text the human typed, back
 * into a named MCP server. Keying it on `sessionScope` alone would be a
 * cross-user hole: `resolveScope` returns the literal `'http-default'` for
 * unscoped HTTP turns, so every such caller would share one key (issue #445).
 * The key is therefore the triple `{userId, sessionId, correlationId}`, and a
 * lookup that differs in ANY component misses. See {@link serializeKey}.
 */

/** How long a parked record stays replayable. Hard ceiling — a record past it
 *  is unreachable even if the user eventually answers the card. */
export const PENDING_MCP_INPUT_TTL_MS = 15 * 60_000;

/** Hard cap on parked records, so a server that spams `input_required` cannot
 *  grow the map without bound. Oldest-first eviction. */
export const PENDING_MCP_INPUT_MAX_ENTRIES = 500;

/** Maximum number of fields a single card will render. A server asking for
 *  more is treated as malformed rather than rendered partially. */
export const MCP_INPUT_REQUEST_MAX_FIELDS = 8;

/**
 * How many times one logical call may bounce through the card.
 *
 * `0` is the original call, `1` is the replay. A replay that comes back
 * `input_required` AGAIN is refused: the pair (model, server) would otherwise
 * be able to ping-pong the user indefinitely, one turn per round, with the
 * user paying for every turn.
 */
export const MCP_INPUT_MAX_REPLAY_DEPTH = 1;

const NAME_MAX = 64;
const LABEL_MAX = 120;
const DESCRIPTION_MAX = 500;
const PROMPT_MAX = 500;
const RESPONSE_VALUE_MAX = 4_000;

/** One field the server wants filled in. Free text by construction — this is
 *  NOT the 2-4 button shape `ask_user_choice` uses, which is exactly why the
 *  channel payload is a sibling of `pendingUserChoice` and not a reuse. */
export interface McpInputField {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  /** Render masked. Advisory: the value still crosses the wire to the server. */
  readonly secret?: boolean;
  readonly required?: boolean;
}

/** A tool call parked mid-flight, waiting for the human to fill in fields. */
export interface PendingMcpInput {
  readonly correlationId: string;
  readonly serverId: string;
  /**
   * Operator-configured display name of the asking server.
   *
   * MANDATORY on the card, not decoration. An MCP server can now make omadia
   * render an arbitrary free-text prompt; without attribution a hostile server
   * could phish credentials through a card the user reads as omadia's own UI.
   * The card names who is asking.
   */
  readonly serverName: string;
  readonly toolName: string;
  /** The arguments of the ORIGINAL call, replayed verbatim alongside the
   *  collected `inputResponses`. */
  readonly originalArgs: Record<string, unknown>;
  readonly inputRequests: readonly McpInputField[];
  /** Server-supplied prose shown above the fields, when it sent any. */
  readonly prompt?: string;
  /** See {@link MCP_INPUT_MAX_REPLAY_DEPTH}. */
  readonly replayDepth: number;
}

/** The only valid lookup key. All three components participate. */
export interface PendingMcpInputKey {
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string;
}

/** Outcome of a {@link PendingMcpInputStore.put}. `callTool` maps each to a
 *  different model-facing string, so none of them is silently indistinguishable
 *  from success. */
export type PutPendingMcpInputResult =
  | 'stored'
  | 'already_pending'
  | 'replay_capped';

export interface PendingMcpInputStore {
  /**
   * Park a record. `turnId` (null outside a turn) additionally files it in the
   * per-turn slot the orchestrator drains to short-circuit — first write per
   * turn wins, mirroring `AskUserChoiceTool`'s first-call-wins guard.
   */
  put(
    key: PendingMcpInputKey,
    record: PendingMcpInput,
    turnId: string | null,
  ): PutPendingMcpInputResult;
  /**
   * The record parked during `turnId`, if any. Clears the TURN SLOT only — the
   * keyed record deliberately survives, because the replay happens in the NEXT
   * turn and must still be able to `take()` it.
   */
  takePending(turnId: string | null): PendingMcpInput | undefined;
  /** Single-use consume for replay. A second `take` of the same key misses. */
  take(key: PendingMcpInputKey): PendingMcpInput | undefined;
  /** Test/ops introspection. Never used for control flow. */
  size(): number;
}

interface Entry {
  readonly record: PendingMcpInput;
  readonly expiresAt: number;
  readonly serializedKey: string;
}

/**
 * Unambiguous key serialization. `JSON.stringify` of a fixed-arity tuple, so no
 * separator can be forged from inside a component: a `userId` containing the
 * delimiter cannot make itself look like a different `{userId, sessionId}` pair
 * the way a naive `${a}:${b}:${c}` join would allow.
 *
 * `null` and the string `'null'` also stay distinct, which matters because an
 * unauthenticated turn legitimately has `userId === null`.
 */
function serializeKey(key: PendingMcpInputKey): string {
  return JSON.stringify([key.userId, key.sessionId, key.correlationId]);
}

export interface InMemoryPendingMcpInputStoreOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  /** Injectable clock — TTL expiry is tested by advancing this, not by sleeping. */
  readonly now?: () => number;
}

/**
 * Process-local store. Single-process by design: a parked record is only
 * meaningful to the instance that will serve the user's next turn, and omadia
 * runs one middleware process per machine with sticky sessions. A multi-node
 * deployment would need this behind the session store — noted, not built.
 */
export class InMemoryPendingMcpInputStore implements PendingMcpInputStore {
  private readonly entries = new Map<string, Entry>();
  /** turnId → serialized key parked during that turn. */
  private readonly turnSlots = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options?: InMemoryPendingMcpInputStoreOptions) {
    this.ttlMs = options?.ttlMs ?? PENDING_MCP_INPUT_TTL_MS;
    this.maxEntries = options?.maxEntries ?? PENDING_MCP_INPUT_MAX_ENTRIES;
    this.now = options?.now ?? Date.now;
  }

  put(
    key: PendingMcpInputKey,
    record: PendingMcpInput,
    turnId: string | null,
  ): PutPendingMcpInputResult {
    // `replayDepth: n` means "answering this card produces replay n+1". With a
    // max of 1 that permits the original call's card (0) and refuses a card
    // raised BY the replay (1) — the ping-pong cap.
    if (record.replayDepth >= MCP_INPUT_MAX_REPLAY_DEPTH) return 'replay_capped';
    this.sweep();
    const slotId = turnId !== null && turnId !== '' ? turnId : null;
    // First-call-wins per turn. Two `input_required` results inside one tool
    // batch would otherwise race, and only one card can be rendered anyway.
    if (slotId !== null && this.turnSlots.has(slotId)) return 'already_pending';
    const serializedKey = serializeKey(key);
    this.entries.set(serializedKey, {
      record,
      expiresAt: this.now() + this.ttlMs,
      serializedKey,
    });
    if (slotId !== null) this.turnSlots.set(slotId, serializedKey);
    this.evictOverflow();
    return 'stored';
  }

  takePending(turnId: string | null): PendingMcpInput | undefined {
    if (turnId === null || turnId === '') return undefined;
    const serializedKey = this.turnSlots.get(turnId);
    if (serializedKey === undefined) return undefined;
    this.turnSlots.delete(turnId);
    const entry = this.entries.get(serializedKey);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(serializedKey);
      return undefined;
    }
    // NOTE: the keyed record is intentionally NOT removed here. Draining the
    // turn slot renders the card; `take()` in the next turn consumes it.
    return entry.record;
  }

  take(key: PendingMcpInputKey): PendingMcpInput | undefined {
    const serializedKey = serializeKey(key);
    const entry = this.entries.get(serializedKey);
    if (entry === undefined) return undefined;
    this.entries.delete(serializedKey);
    if (entry.expiresAt <= this.now()) return undefined;
    return entry.record;
  }

  size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(k);
    }
    for (const [turnId, serializedKey] of this.turnSlots) {
      if (!this.entries.has(serializedKey)) this.turnSlots.delete(turnId);
    }
  }

  /** Map insertion order is oldest-first, so the first keys are the stalest. */
  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }
}

// ── parsing a server's `inputRequests` ──────────────────────────────────────

/** Why a server's `input_required` result could not be turned into a card. */
export type McpInputParseFailure =
  | 'not_an_array'
  | 'empty'
  | 'too_many_fields'
  | 'field_without_name'
  | 'duplicate_field_name';

export type McpInputParseOutcome =
  | { readonly ok: true; readonly fields: readonly McpInputField[] }
  | { readonly ok: false; readonly reason: McpInputParseFailure };

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Validate a server's `inputRequests` into renderable fields.
 *
 * Deliberately lenient about EXTRA keys (the MRTR shape is still settling and
 * SDK 1.29.0 does not model it) and strict about the two things the card
 * genuinely cannot work without: it must be a non-empty array, and every entry
 * must carry a usable field name. A failure is reported, never papered over —
 * `callTool` turns it into a plain error string so a malformed server degrades
 * to an ordinary tool error instead of a broken card.
 *
 * `name` accepts `name`, `id`, or `key`; `label` accepts `label` or `title`.
 * Servers in the wild use all of these and none of them is normative yet.
 */
export function parseMcpInputRequests(raw: unknown): McpInputParseOutcome {
  if (!Array.isArray(raw)) return { ok: false, reason: 'not_an_array' };
  if (raw.length === 0) return { ok: false, reason: 'empty' };
  if (raw.length > MCP_INPUT_REQUEST_MAX_FIELDS) {
    return { ok: false, reason: 'too_many_fields' };
  }
  const fields: McpInputField[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'field_without_name' };
    }
    const shape = item as Record<string, unknown>;
    const name =
      clamp(shape['name'], NAME_MAX) ??
      clamp(shape['id'], NAME_MAX) ??
      clamp(shape['key'], NAME_MAX);
    if (name === undefined) return { ok: false, reason: 'field_without_name' };
    if (seen.has(name)) return { ok: false, reason: 'duplicate_field_name' };
    seen.add(name);
    const label = clamp(shape['label'], LABEL_MAX) ?? clamp(shape['title'], LABEL_MAX);
    const description = clamp(shape['description'], DESCRIPTION_MAX);
    fields.push({
      name,
      ...(label !== undefined ? { label } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(shape['secret'] === true || shape['sensitive'] === true
        ? { secret: true }
        : {}),
      // Absent `required` means required: a server that bothered to block on a
      // field is asking for it. Only an explicit `false` makes it optional.
      ...(shape['required'] === false ? {} : { required: true }),
    });
  }
  return { ok: true, fields };
}

/** Pull the server's prose prompt out of an `input_required` result, if any. */
export function extractMcpInputPrompt(res: unknown): string | undefined {
  if (res === null || typeof res !== 'object') return undefined;
  const shape = res as Record<string, unknown>;
  return (
    clamp(shape['message'], PROMPT_MAX) ??
    clamp(shape['prompt'], PROMPT_MAX) ??
    undefined
  );
}

// ── model-facing sentinels ──────────────────────────────────────────────────

/**
 * Marker the model sees in place of a result when a call parks.
 *
 * It lands in the message log, so the model can and will read it — hence the
 * explicit instruction not to re-call. Combined with the store's
 * first-call-wins guard, a model that re-calls anyway gets
 * {@link MCP_INPUT_ALREADY_PENDING_SENTINEL} rather than a second card.
 */
export const MCP_INPUT_REQUIRED_SENTINEL_PREFIX = '[mcp_input_required]';

export function mcpInputRequiredSentinel(record: PendingMcpInput): string {
  const fieldNames = record.inputRequests.map((f) => f.name).join(', ');
  return (
    `${MCP_INPUT_REQUIRED_SENTINEL_PREFIX} Der MCP-Server "${record.serverName}" ` +
    `braucht für "${record.toolName}" noch Eingaben vom User (${fieldNames}). ` +
    'Der Turn endet hier: der User bekommt ein Eingabe-Formular und die Antwort ' +
    'wird im nächsten Turn automatisch an den Server übermittelt. ' +
    'Ruf das Tool NICHT erneut auf und erfinde keine Werte.'
  );
}

/** Second `input_required` inside one turn — the first card already won. */
export const MCP_INPUT_ALREADY_PENDING_SENTINEL =
  `${MCP_INPUT_REQUIRED_SENTINEL_PREFIX} In diesem Turn wartet bereits eine ` +
  'User-Eingabe für einen MCP-Server. Nur die erste zählt. Ruf keine weiteren ' +
  'Tools auf und warte auf die Antwort des Users.';

/** The bounce cap tripped — tell the model plainly, do not park again. */
export function mcpInputReplayCappedError(record: PendingMcpInput): string {
  return (
    `Error: MCP tool "${record.toolName}" on "${record.serverName}" asked for ` +
    'user input again after it had already been answered once. Aborted to avoid ' +
    'an endless input loop — report this to the user instead of retrying.'
  );
}

/** Malformed `inputRequests` — an ordinary tool error, not a card. */
export function mcpInputMalformedError(
  serverName: string,
  toolName: string,
  reason: McpInputParseFailure,
): string {
  return (
    `Error: MCP tool "${toolName}" on "${serverName}" returned ` +
    `resultType "input_required" with unusable inputRequests (${reason}). ` +
    'Treat this as a failed tool call.'
  );
}

/** No store wired — the deployment cannot park input at all. Deterministic
 *  degradation instead of a silently swallowed result. */
export function mcpInputUnsupportedError(
  serverName: string,
  toolName: string,
): string {
  return (
    `Error: MCP tool "${toolName}" on "${serverName}" requires mid-call user ` +
    'input, which is not enabled on this deployment. Treat this as a failed ' +
    'tool call.'
  );
}

// ── reply envelope (card answer → next turn) ────────────────────────────────

/**
 * Prefix of the synthetic user message the card submits.
 *
 * The card cannot smuggle a side channel to the orchestrator: a click on
 * `ask_user_choice` simply fires a fresh user turn, and this rides the same
 * road. The envelope is machine-readable so the orchestrator can resolve the
 * correlation id and drive a FORCED tool call itself, rather than hoping the
 * model chooses to re-call the tool with the right arguments.
 *
 * The orchestrator strips the envelope before anything is persisted or shown,
 * so it never appears in the session log or the UI.
 */
export const MCP_INPUT_REPLY_PREFIX = '__mcp_input_reply__';

export interface McpInputReply {
  readonly correlationId: string;
  readonly inputResponses: Record<string, string>;
}

export function formatMcpInputReply(reply: McpInputReply): string {
  return `${MCP_INPUT_REPLY_PREFIX} ${JSON.stringify(reply)}`;
}

/**
 * Parse the envelope out of a user message. Returns `undefined` for any
 * ordinary message — including one that merely starts with the prefix but
 * carries no valid payload, so a user who types the literal prefix gets a
 * normal turn rather than an error.
 */
export function parseMcpInputReply(
  userMessage: string,
): McpInputReply | undefined {
  const trimmed = userMessage.trim();
  if (!trimmed.startsWith(MCP_INPUT_REPLY_PREFIX)) return undefined;
  const payload = trimmed.slice(MCP_INPUT_REPLY_PREFIX.length).trim();
  if (payload.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const shape = parsed as Record<string, unknown>;
  const correlationId = clamp(shape['correlationId'], NAME_MAX);
  if (correlationId === undefined) return undefined;
  const rawResponses = shape['inputResponses'];
  if (
    rawResponses === null ||
    typeof rawResponses !== 'object' ||
    Array.isArray(rawResponses)
  ) {
    return undefined;
  }
  const inputResponses: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawResponses as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    inputResponses[k.slice(0, NAME_MAX)] = v.slice(0, RESPONSE_VALUE_MAX);
  }
  return { correlationId, inputResponses };
}

/**
 * Human-readable stand-in for the envelope, used as the turn's `userMessage`
 * everywhere the raw envelope would otherwise be persisted or displayed
 * (session log, memory, chat transcript, privacy receipt).
 *
 * Field NAMES only. The values are what the user typed for a third-party MCP
 * server and may be secrets (the card renders `secret` fields masked), so they
 * must not land in a log — and the orchestrator does not need them again: the
 * replay already happened.
 */
export function mcpInputReplyLabel(reply: McpInputReply): string {
  const names = Object.keys(reply.inputResponses);
  return names.length > 0
    ? `[Eingaben übermittelt: ${names.join(', ')}]`
    : '[Eingaben übermittelt]';
}

/**
 * Executes the replay. Implemented outside the orchestrator (which holds no
 * `McpManager`) and injected, the same way the sticky Direct Line store is —
 * see `OrchestratorDeps`.
 */
export interface McpInputReplayer {
  /**
   * Re-call `record.toolName` with `{...record.originalArgs, inputResponses}`.
   * Returns the model-facing result string, or `undefined` when the server is
   * no longer registered (the record is then dropped).
   */
  replay(
    record: PendingMcpInput,
    inputResponses: Record<string, string>,
  ): Promise<string | undefined>;
}
