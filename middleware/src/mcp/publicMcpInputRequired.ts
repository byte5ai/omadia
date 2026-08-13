/**
 * MRTR as a SERVER — `resultType: "input_required"` on the public MCP endpoint
 * (issue #544, server half).
 *
 * The client half shipped in PR #550: when a remote MCP server answers a
 * `tools/call` with `resultType: "input_required"`, `McpManager` parks the call
 * and omadia renders an input card. Nothing in omadia's OWN MCP server path ever
 * produced that shape, so the endpoint could only ever answer with a result or
 * an error. A tool that needed one more value from the human had exactly two
 * options, both bad: fail with a message no machine can act on, or guess.
 *
 * This module is the missing direction. A dispatched tool signals "I need these
 * fields" in-band, and the endpoint renders it as MRTR so an ordinary MCP client
 * (Claude Desktop, an agent framework) can collect the values and retry.
 *
 * ## Why in-band, and not a new dispatch return type
 *
 * `ToolDispatchResult` is `{ content: string; isError?: boolean }` and is shared
 * by every dispatch surface — chat, routines, sub-agents, this endpoint. Adding
 * a third variant would force every one of those call sites to grow a branch for
 * a case only this endpoint can render. So the signal rides the result string as
 * a JSON sentinel, exactly the convention `_pendingUserChoice` already uses for
 * plugin-emitted choice cards (see `parseToolEmittedChoice`). A surface that
 * does not understand it shows the tool's own `message` and is no worse off than
 * before.
 *
 * ## Why the retry needs no server-side state
 *
 * MRTR has the CLIENT retry the original request with `inputResponses` added, so
 * the arguments come back from the caller. That is what lets this work on a
 * deliberately stateless endpoint (see `README.md`): omadia parks nothing, holds
 * no correlation id, and any instance behind the load balancer can serve the
 * retry. The retry is an ordinary `tools/call` whose arguments happen to carry
 * one more key — `inputResponses`, the SAME key `REPLAY_ARG_KEY` uses on the
 * client half, so the two directions speak one vocabulary.
 *
 * Consequence worth stating: a tool that asks for input must be able to finish
 * from `{...originalArgs, inputResponses}` alone. Anything it cached in memory
 * during the first call is gone. That is a real constraint, and it is the same
 * one the client half documents for stdio servers.
 *
 * ## Trust boundary
 *
 * The `message` and the field `label`/`description` values are authored by the
 * TOOL, and reach a human through the caller's UI. They are clamped by
 * {@link parseMcpInputRequests} (max 8 fields, names ≤64, labels ≤120), which is
 * the same validation the client half applies to a remote server's request —
 * deliberately, so neither direction is the lenient one.
 */

import {
  MCP_RESULT_TYPE_INPUT_REQUIRED,
  REPLAY_ARG_KEY,
  parseMcpInputRequests,
  type McpInputField,
  type McpInputParseFailure,
} from '@omadia/orchestrator';

/**
 * The in-band key a dispatched tool sets to ask for more input.
 *
 * Sibling of `_pendingUserChoice`. Distinct on purpose: a choice is 2–4 buttons
 * the orchestrator renders in a chat channel, an input request is free-text
 * fields an external MCP client renders. Reusing one key for both would make the
 * endpoint guess which shape it was handed.
 */
export const PENDING_INPUT_REQUEST_KEY = '_pendingInputRequest';

/** Longest tool-authored prompt echoed to the caller. Matches the client half's
 *  `PROMPT_MAX`, so a request omadia SENDS and one it RECEIVES clamp alike. */
const MESSAGE_MAX = 500;

/** A tool's request for mid-call input, after validation. */
export interface ToolEmittedInputRequest {
  /** Tool-authored prose shown above the fields. Absent when it sent none. */
  readonly message?: string;
  readonly inputRequests: readonly McpInputField[];
}

/**
 * Why a sentinel-looking result was NOT rendered as `input_required`.
 *
 * Surfaced rather than swallowed: a tool that emits a malformed request has a
 * bug, and silently shipping its raw JSON to the caller as a "result" is how
 * that bug stays invisible. `unusable` carries the specific
 * {@link McpInputParseFailure} so the audit line names it.
 */
export type InputRequestRejection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unusable'; readonly reason: McpInputParseFailure };

export type ParseInputRequestOutcome =
  | { readonly ok: true; readonly request: ToolEmittedInputRequest }
  | { readonly ok: false; readonly rejection: InputRequestRejection };

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

/**
 * Parse a dispatch result string for a {@link PENDING_INPUT_REQUEST_KEY}
 * sentinel.
 *
 * Returns `absent` for every ordinary result — including any string that is not
 * JSON at all, which is the overwhelming majority — so an ordinary tool result
 * stays an ordinary tool result.
 */
export function parseToolEmittedInputRequest(
  content: string,
): ParseInputRequestOutcome {
  // Cheap reject before paying for JSON.parse: the sentinel is a JSON object
  // and every dispatch result flows through here.
  if (!content.includes(PENDING_INPUT_REQUEST_KEY)) {
    return { ok: false, rejection: { kind: 'absent' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, rejection: { kind: 'absent' } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, rejection: { kind: 'absent' } };
  }
  const raw = (parsed as Record<string, unknown>)[PENDING_INPUT_REQUEST_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, rejection: { kind: 'absent' } };
  }
  const shape = raw as { message?: unknown; inputRequests?: unknown };
  // Same validator the client half runs on a REMOTE server's request. One
  // vocabulary, one set of clamps, in both directions.
  const fields = parseMcpInputRequests(shape.inputRequests);
  if (!fields.ok) {
    return { ok: false, rejection: { kind: 'unusable', reason: fields.reason } };
  }
  const message = clamp(shape.message, MESSAGE_MAX);
  return {
    ok: true,
    request: {
      ...(message !== undefined ? { message } : {}),
      inputRequests: fields.fields,
    },
  };
}

/**
 * True when this `tools/call` is the RETRY leg — the caller collected the values
 * and sent them back.
 *
 * Only used to keep a tool from bouncing the caller forever: a retry that comes
 * back asking for input AGAIN is refused (see
 * {@link inputRequestBounceError}), mirroring `MCP_INPUT_MAX_REPLAY_DEPTH` on
 * the client half. The responses themselves are passed to the tool untouched —
 * this endpoint does not read them, and must not: they may be secrets the human
 * typed for the tool.
 */
export function carriesInputResponses(args: unknown): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return false;
  }
  const responses = (args as Record<string, unknown>)[REPLAY_ARG_KEY];
  return (
    responses !== null &&
    typeof responses === 'object' &&
    !Array.isArray(responses) &&
    Object.keys(responses as Record<string, unknown>).length > 0
  );
}

/** The bounce cap tripped. An ordinary tool error, not a second request. */
export function inputRequestBounceError(toolName: string): string {
  return (
    `Error: tool "${toolName}" asked for user input again after it had already ` +
    'been answered once. Refused to avoid an endless input loop — report this ' +
    'to the tool author instead of retrying.'
  );
}

/** A tool emitted a request nobody can render. An ordinary tool error. */
export function inputRequestMalformedError(
  toolName: string,
  reason: McpInputParseFailure,
): string {
  return (
    `Error: tool "${toolName}" asked for user input with unusable ` +
    `inputRequests (${reason}). Treat this as a failed tool call.`
  );
}

/**
 * The MRTR JSON-RPC result body.
 *
 * `content` is populated as well as `resultType`, on purpose: a client that
 * predates MRTR ignores the unknown keys and still shows the human what is being
 * asked for, instead of rendering an empty result and looking broken.
 */
export interface McpInputRequiredResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly resultType: typeof MCP_RESULT_TYPE_INPUT_REQUIRED;
  readonly inputRequests: readonly McpInputField[];
  readonly message?: string;
}

/** Fallback prose when the tool named no message — the field names alone are
 *  not a sentence, and this text reaches a human. */
function defaultMessage(request: ToolEmittedInputRequest): string {
  const names = request.inputRequests.map((field) => field.label ?? field.name);
  return `Additional input required: ${names.join(', ')}.`;
}

/**
 * Render a validated request as the MRTR result body.
 *
 * Never carries `isError`. An `input_required` answer is not a failure — the
 * client half's `isInputRequiredResult` explicitly excludes `isError` results,
 * so setting it here would make omadia's own endpoint unreadable by omadia's own
 * client.
 */
export function renderInputRequiredResult(
  request: ToolEmittedInputRequest,
): McpInputRequiredResult {
  const message = request.message ?? defaultMessage(request);
  return {
    content: [{ type: 'text', text: message }],
    resultType: MCP_RESULT_TYPE_INPUT_REQUIRED,
    inputRequests: request.inputRequests,
    message,
  };
}
