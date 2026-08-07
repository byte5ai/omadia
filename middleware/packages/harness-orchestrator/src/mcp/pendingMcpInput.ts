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

/** Who a CLAIMED record belongs to. Both components participate in the key. */
export interface PendingMcpInputOwner {
  readonly userId: string | null;
  readonly sessionId: string | null;
}

/** The only valid replay lookup key. All three components participate. */
export interface PendingMcpInputKey extends PendingMcpInputOwner {
  readonly correlationId: string;
}

/** Outcome of a {@link PendingMcpInputStore.put}. `callTool` maps each to a
 *  different model-facing string, so neither is silently indistinguishable from
 *  success. */
export type PutPendingMcpInputResult = 'stored' | 'replay_capped';

/**
 * Two-phase by necessity: PARK is performed by the `McpManager`, CLAIM by the
 * orchestrator.
 *
 * ## Why the owner is bound at claim time, not at park time
 *
 * `McpManager.callTool` is reached through the published
 * `NativeToolHandler = (input: unknown) => Promise<string>` contract, so it has
 * no turn parameter.
 *
 * HISTORICAL NOTE (W3-A): it could not read the turn identity from ambient
 * context either, because the streaming path established `turnContext` with
 * `AsyncLocalStorage.enterWith` inside an async generator — a binding that does
 * not survive the generator's first suspension, leaving
 * `turnContext.current()` empty inside every tool handler on a `chatStream`
 * turn. That defect is FIXED: the entry point now uses
 * `turnContext.runGenerator`, and `test/orchestrator/turnContextPropagation.test.ts`
 * pins the context as populated on both paths.
 *
 * The two-phase design is deliberately KEPT anyway. Claim-time binding does not
 * depend on ambient context being correct at park time, so it stays robust
 * against a future dispatch surface that legitimately has no turn scope (the
 * standalone `ToolDispatchService`, a public endpoint). Reading the owner from
 * ambient context would be a regression in robustness, not a simplification.
 *
 * So the manager parks with no owner and returns a sentinel that CARRIES the
 * correlation id. The orchestrator — which does hold the turn's `input`
 * reliably on both paths — reads that sentinel out of the batch's tool results
 * and claims the record, binding it to `{userId, sessionId}` at that moment.
 * The linkage is the tool result itself, exactly the mechanism
 * `extractToolEmittedChoice` already uses for plugin-emitted choice cards.
 *
 * The security property is unchanged: a record can only ever be REPLAYED via
 * `take()` with the full triple, and it only acquires an owner from the turn
 * that actually made the call. An unclaimed record is replayable by nobody.
 */
export interface PendingMcpInputStore {
  /** Park a record. Unclaimed and ownerless until the orchestrator claims it. */
  put(record: PendingMcpInput): PutPendingMcpInputResult;
  /**
   * Bind a parked record to `owner` and return it for rendering. Idempotent:
   * a second claim of the same correlation id misses, which is what makes the
   * first sentinel in a batch the winner.
   *
   * The keyed record deliberately SURVIVES this call — the replay happens in a
   * later turn and must still be able to `take()` it.
   */
  claim(
    correlationId: string,
    owner: PendingMcpInputOwner,
  ): PendingMcpInput | undefined;
  /** Discard a parked record outright (a losing sibling in the same batch). */
  drop(correlationId: string): void;
  /** Single-use consume for replay. A second `take` of the same key misses. */
  take(key: PendingMcpInputKey): PendingMcpInput | undefined;
  /** Test/ops introspection. Never used for control flow. */
  size(): number;
}

interface Entry {
  readonly record: PendingMcpInput;
  readonly expiresAt: number;
  /** `undefined` until the orchestrator claims it. An unclaimed record cannot
   *  be replayed by anyone, because `take` needs a matching owner. */
  owner?: PendingMcpInputOwner;
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
function serializeOwner(owner: PendingMcpInputOwner): string {
  return JSON.stringify([owner.userId, owner.sessionId]);
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
  /** correlationId → entry. The id is a random UUID, so it is unguessable; the
   *  owner bound at claim time is what makes a LEAKED id unusable elsewhere. */
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options?: InMemoryPendingMcpInputStoreOptions) {
    this.ttlMs = options?.ttlMs ?? PENDING_MCP_INPUT_TTL_MS;
    this.maxEntries = options?.maxEntries ?? PENDING_MCP_INPUT_MAX_ENTRIES;
    this.now = options?.now ?? Date.now;
  }

  put(record: PendingMcpInput): PutPendingMcpInputResult {
    // `replayDepth: n` means "answering this card produces replay n+1". With a
    // max of 1 that permits the original call's card (0) and refuses a card
    // raised BY the replay (1) — the ping-pong cap.
    if (record.replayDepth >= MCP_INPUT_MAX_REPLAY_DEPTH) return 'replay_capped';
    this.sweep();
    this.entries.set(record.correlationId, {
      record,
      expiresAt: this.now() + this.ttlMs,
    });
    this.evictOverflow();
    return 'stored';
  }

  claim(
    correlationId: string,
    owner: PendingMcpInputOwner,
  ): PendingMcpInput | undefined {
    const entry = this.entries.get(correlationId);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(correlationId);
      return undefined;
    }
    // Already claimed → miss. This is what makes the FIRST sentinel in a batch
    // the winner, and what stops a replayed sentinel from re-carding.
    //
    // Trust-on-first-claim, deliberately. A review pass asked why this does not
    // also compare the record's own `userId`/`sessionId` the way `take()` does:
    // because a parked record HAS none. `PendingMcpInput` carries no owner
    // fields at all — binding one here IS how it acquires them, which is the
    // whole point of the two-phase design (see the interface doc: `callTool` is
    // reached through a published handler contract with no turn parameter, and
    // reading turn identity from ambient context at park time is exactly the
    // robustness regression that design avoids). There is nothing to compare
    // against, so the protection has to come from elsewhere, and it does: the
    // correlation id is a random UUID that is only ever learned from the tool
    // result of the call that parked it, inside the same turn's batch, so no
    // other turn can present it; and the security property that actually
    // matters — REPLAY — is enforced by `take()` on the full triple.
    if (entry.owner !== undefined) return undefined;
    entry.owner = owner;
    // NOTE: the record is intentionally NOT removed. Claiming renders the card;
    // `take()` in a later turn consumes it.
    return entry.record;
  }

  drop(correlationId: string): void {
    this.entries.delete(correlationId);
  }

  take(key: PendingMcpInputKey): PendingMcpInput | undefined {
    const entry = this.entries.get(key.correlationId);
    if (entry === undefined) return undefined;
    // An UNCLAIMED record has no owner and is therefore replayable by nobody —
    // do not consume it here, or a guessed id could burn someone else's card.
    if (entry.owner === undefined) return undefined;
    // The full triple. A mismatch is a miss and must NOT consume the record:
    // otherwise a wrong-owner attempt would destroy the rightful owner's card.
    if (serializeOwner(entry.owner) !== serializeOwner(key)) return undefined;
    this.entries.delete(key.correlationId);
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

// ── process-shared wiring ───────────────────────────────────────────────────
//
// The `McpManager` (constructed in the kernel's `index.ts`) WRITES parked
// records; the Orchestrator (built from `OrchestratorDeps` in this package's
// `plugin.ts`) READS them. Neither can reach the other's construction site, so
// the single instance lives here — the same module-singleton shape
// `mcpGrantPolicy.ts` already uses for the dispatch guard.
//
// Not a hidden global with surprise lifetime: the store is process-local by
// design (see `InMemoryPendingMcpInputStore`), so "one per process" is exactly
// the correct scope, and both readers go through these two accessors.

let sharedStore: PendingMcpInputStore | undefined;
let sharedReplayer: McpInputReplayer | undefined;

/** The process-wide store. Created on first access so both sides get the same
 *  instance regardless of which one runs first. */
export function sharedPendingMcpInputStore(): PendingMcpInputStore {
  sharedStore ??= new InMemoryPendingMcpInputStore();
  return sharedStore;
}

/**
 * Register the replayer. Called by the kernel once the `McpManager` and the
 * server registry exist — those are the only things that can perform a replay.
 */
export function setSharedMcpInputReplayer(replayer: McpInputReplayer): void {
  sharedReplayer = replayer;
}

/** The registered replayer, or `undefined` when the kernel wired none — in
 *  which case the orchestrator leaves the whole MRTR path inert. */
export function sharedMcpInputReplayer(): McpInputReplayer | undefined {
  return sharedReplayer;
}

/** Test seam: drop both, so a suite cannot leak state into the next one. */
export function resetSharedMcpInputWiring(): void {
  sharedStore = undefined;
  sharedReplayer = undefined;
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
export const MCP_INPUT_REQUIRED_SENTINEL_PREFIX = '[mcp_input_required:';

/**
 * The sentinel embeds the correlation id, which is what lets the orchestrator
 * link a parked record to THIS turn without any ambient context — see
 * {@link PendingMcpInputStore}. Same idea as the `_pendingUserChoice` payload
 * plugins emit in their tool-result strings.
 */
export function mcpInputRequiredSentinel(record: PendingMcpInput): string {
  const fieldNames = record.inputRequests.map((f) => f.name).join(', ');
  return (
    `${MCP_INPUT_REQUIRED_SENTINEL_PREFIX}${record.correlationId}] ` +
    `Der MCP-Server "${record.serverName}" braucht für "${record.toolName}" noch ` +
    `Eingaben vom User (${fieldNames}). Der Turn endet hier: der User bekommt ein ` +
    'Eingabe-Formular und die Antwort wird im nächsten Turn automatisch an den ' +
    'Server übermittelt. Ruf das Tool NICHT erneut auf und erfinde keine Werte.'
  );
}

/**
 * Pull the correlation id back out of a tool-result string.
 *
 * Deliberately anchored at the START of the string: the sentinel is the WHOLE
 * result the manager returned, so a server that merely echoes the prefix inside
 * its own output text cannot forge a card. Returns `undefined` for anything
 * else, so an ordinary tool result stays an ordinary tool result.
 */
export function parseMcpInputSentinel(result: string): string | undefined {
  if (!result.startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX)) return undefined;
  const end = result.indexOf(']', MCP_INPUT_REQUIRED_SENTINEL_PREFIX.length);
  if (end === -1) return undefined;
  const id = result.slice(MCP_INPUT_REQUIRED_SENTINEL_PREFIX.length, end).trim();
  return id.length > 0 && id.length <= NAME_MAX ? id : undefined;
}

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
 * W2-1 (#544) — claim the card for THIS turn out of the batch's tool results.
 *
 * Scans in submission order and claims the FIRST sentinel; every later one in
 * the same batch is dropped, so a model that fired several MCP calls gets
 * exactly one card and no orphaned records linger. Deterministic with the
 * dispatch order, matching `extractToolEmittedChoice`'s documented rule.
 *
 * `results` carries the model-facing strings the orchestrator already holds — no
 * ambient context is consulted, which is the whole point (see
 * {@link PendingMcpInputStore}).
 */
export function claimMcpInputFromResults(
  store: PendingMcpInputStore,
  results: readonly string[],
  owner: PendingMcpInputOwner,
): PendingMcpInput | undefined {
  let claimed: PendingMcpInput | undefined;
  for (const result of results) {
    const correlationId = parseMcpInputSentinel(result);
    if (correlationId === undefined) continue;
    if (claimed === undefined) {
      claimed = store.claim(correlationId, owner);
      if (claimed !== undefined) continue;
    }
    // Either a later sibling, or a sentinel whose record is already claimed /
    // expired. Nothing will ever render it, so do not leave it parked.
    store.drop(correlationId);
  }
  return claimed;
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
