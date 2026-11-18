/**
 * The withheld tool-error notice — the text a model receives in place of an
 * exception message.
 *
 * An exception message is not sanitized text. An ORM echoes the failing row, a
 * driver echoes the bound parameters, an HTTP client echoes the response body:
 * `Fault: Invalid field 'x' on record {'name': 'Jane Doe', 'email': …}` is an
 * ordinary Odoo error. Handing that string to the model as a tool result puts
 * whatever the failing layer was holding on the provider wire, into the chat
 * transcript and into the persisted session — behind the Privacy Shield's back,
 * because the shield only ever sees what a tool RETURNS.
 *
 * So the policy follows provenance: a message that came out of an exception is
 * never a tool result. The model gets the exception's class name, a sanitised
 * error code (a Postgres SQLSTATE such as `22P02`, a Node `ECONNREFUSED`, a
 * numeric XML-RPC fault code) and a log reference. The full error — message,
 * stack, cause — goes to the server log under that reference, where an operator
 * debugging their own integration finds it.
 *
 * Two kinds of producer build this notice:
 *  - the kernel's dispatch seams (`@omadia/orchestrator`, `toolErrorRedaction`)
 *    for an exception a tool handler THREW, with the turn id as the reference;
 *  - tool wrappers that catch an exception themselves and would otherwise
 *    return `Error: ${err.message}` ({@link toolErrorFromException}), with a
 *    fresh per-error reference.
 *
 * The notice keeps the `Error:` prefix, so the dispatch loops still derive
 * `is_error` from it and {@link isControlFlowToolResult} still recognizes it.
 *
 * An exception says nothing about how far the call got: a write can commit
 * upstream and its response then time out. So the notice tells the model the
 * outcome is unknown and not to repeat a call that changes data, and a
 * sub-agent loop refuses an identical repeat of a call that ended this way
 * ({@link isWithheldToolErrorNotice}).
 *
 * One kind of exception is written FOR the model: a refusal
 * ({@link ToolRefusalError}, and the kernel's own `ctx.http` permission errors).
 * The tool did not carry the call out, and its message says why and what an
 * operator can change. That message reaches the model as a refusal notice
 * ({@link refusedToolErrorNotice}) — without the "outcome is unknown" clause,
 * because nothing happened. It is still an `Error:` result, so the dispatch
 * seams run it through the Privacy Shield's free-text redactor like any other
 * returned error text.
 */

import { randomBytes } from 'node:crypto';

import { TOOL_ERROR_PREFIX } from './toolControlFlowText.js';

/** What of an exception may reach a model: its class name and a sanitised code. */
export interface ThrownErrorDescription {
  /** `err.name` when it is a plain identifier, otherwise `'Error'`. */
  readonly name: string;
  /** `err.code` (or `err.faultCode`) when it is a short plain token. */
  readonly code?: string;
}

/** A class name: starts with a letter, identifier characters only. */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_$.]{0,63}$/;
/** An error code: SQLSTATE, errno names, numeric fault codes, dotted codes. */
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,48}$/;
/** Characters a tool name or ref may keep inside the notice. Anything else
 *  (backticks, brackets, whitespace) could break the notice's framing. */
const UNSAFE_TOKEN_CHARS = /[^A-Za-z0-9_.:-]/g;

function readCode(err: object): string | undefined {
  const record = err as { code?: unknown; faultCode?: unknown };
  const raw = record.code ?? record.faultCode;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : undefined;
  }
  if (typeof raw === 'string' && SAFE_ERROR_CODE.test(raw)) return raw;
  return undefined;
}

/**
 * Describe a caught value by its class name and code only. Never reads the
 * message, never stringifies a non-Error throw (a thrown string IS a message).
 */
export function describeThrownError(err: unknown): ThrownErrorDescription {
  if (err === null || typeof err !== 'object') return { name: 'Error' };
  const name =
    err instanceof Error && SAFE_ERROR_NAME.test(err.name) ? err.name : 'Error';
  const code = readCode(err);
  return code === undefined ? { name } : { name, code };
}

/**
 * A fresh log reference for one withheld error: `err_` plus 12 hex digits. It
 * starts with a letter and contains no separator, so no word-boundary-anchored
 * PII pattern (phone, id number) can match inside it — a notice carrying it
 * passes a later redaction pass byte-identical.
 */
export function newToolErrorRef(): string {
  return `err_${randomBytes(6).toString('hex')}`;
}

function safeToken(value: string, fallback: string): string {
  const cleaned = value.replace(UNSAFE_TOKEN_CHARS, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * The model-facing text for a withheld exception. PII-free by construction:
 * the tool name the caller dispatched, the class name, a sanitised code, and
 * the log reference.
 */
export function withheldToolErrorNotice(
  toolName: string,
  err: unknown,
  ref: string,
): string {
  const { name, code } = describeThrownError(err);
  const codeClause = code === undefined ? '' : ` (code ${code})`;
  return (
    `${TOOL_ERROR_PREFIX} tool \`${safeToken(toolName, 'unknown')}\` failed with ` +
    `${name}${codeClause} [ref ${safeToken(ref, 'unknown')}]. The error text was ` +
    'withheld from the model; an operator can find it in the server log under ' +
    'this ref. The outcome is unknown, so do not repeat a call that changes ' +
    'data. If the code points at your input, correct the call; otherwise ' +
    'continue without this tool or tell the user it is unavailable.'
  );
}

/**
 * The head of every notice {@link withheldToolErrorNotice} builds. The code
 * clause accepts any run without brackets or whitespace, because a numeric
 * code is printed as JavaScript prints the number (`1e+21`).
 */
const WITHHELD_NOTICE_HEAD =
  /^Error: tool `[A-Za-z0-9_.:-]+` failed with [A-Za-z][A-Za-z0-9_$.]{0,63}(?: \(code [^()\s]{1,48}\))? \[ref [A-Za-z0-9_.:-]+\]\. The error text was withheld from the model;/;

/**
 * True when `text` is a notice {@link withheldToolErrorNotice} built: a tool
 * call that ended in an exception, so whether it took effect is unknown. The
 * kernel's sub-agent loop uses it to refuse an identical repeat of a call
 * whose wrapper caught the exception itself ({@link toolErrorFromException}).
 *
 * Recognised by its shape, which any tool can imitate. Use it only to RESTRICT
 * what happens next, never to exempt a text from a check.
 */
export function isWithheldToolErrorNotice(text: string): boolean {
  return WITHHELD_NOTICE_HEAD.test(text);
}

export interface ToolErrorFromExceptionOptions {
  /** Log reference. Default: a fresh {@link newToolErrorRef}. */
  readonly ref?: string;
  /** Log prefix naming the producer, e.g. `dynamic-agent`. Default `tool`. */
  readonly site?: string;
  /**
   * Where the FULL error goes. Default `console.error`. `null` when the caller
   * logs the error itself (it must then log the same `ref`).
   */
  readonly log?: ((line: string, err: unknown) => void) | null;
}

/**
 * For a tool wrapper that catches an exception and must answer with a tool
 * result: logs the full error under a reference and returns the withheld
 * notice. Use this instead of `Error: ${err.message}`. A refusal — a
 * {@link ToolRefusalError} or a kernel `ctx.http` permission error — is the
 * exception: its message was written for the model, so it comes back as the
 * refusal notice ({@link refusedToolErrorNotice}) and is still logged under the
 * ref.
 */
export function toolErrorFromException(
  toolName: string,
  err: unknown,
  options?: ToolErrorFromExceptionOptions,
): string {
  const ref = options?.ref ?? newToolErrorRef();
  const log =
    options?.log === undefined
      ? (line: string, e: unknown): void => {
          console.error(line, e);
        }
      : options.log;
  const readable = readableToolErrorNotice(toolName, err);
  if (readable !== undefined) {
    log?.(
      `[${options?.site ?? 'tool'}:${toolName}] tool refused the call (ref=${ref}) — message passed to the model:`,
      err,
    );
    return readable.text;
  }
  log?.(
    `[${options?.site ?? 'tool'}:${toolName}] tool threw (ref=${ref}) — message withheld from the model:`,
    err,
  );
  return withheldToolErrorNotice(toolName, err, ref);
}

// ---------------------------------------------------------------------------
// Refusals — exception messages written for the model (#1343)
// ---------------------------------------------------------------------------

/** The `name` a {@link ToolRefusalError} carries, and the one it is recognised by. */
export const TOOL_REFUSAL_ERROR_NAME = 'ToolRefusalError';

/**
 * The kernel's `ctx.http` permission errors. omadia writes their messages
 * itself from the plugin id and the host (`plugin '<id>' is not permitted to
 * reach '<host>' — …`, `plugin '<id>' exceeded its per-minute HTTP request
 * budget`), and each one is thrown before a request leaves the middleware.
 */
const KERNEL_HTTP_REFUSAL_NAMES: ReadonlySet<string> = new Set([
  'HttpForbiddenError',
  'HttpBlockedAddressError',
  'HttpRateLimitError',
]);
/** Every kernel `ctx.http` refusal message starts like this. A library error
 *  that merely shares one of the names above keeps being withheld. */
const KERNEL_HTTP_REFUSAL_HEAD = /^plugin '[^'\n]{1,214}' (?:is not permitted to reach|exceeded its)/;

/** Longest refusal text a notice carries; the rest is cut. */
export const MAX_REFUSAL_MESSAGE_CHARS = 600;
// A line break. A refusal is one sentence or two; a message with lines is
// treated as a dump (a stack trace, a quoted body) and stays withheld — the
// detectors that would recognise it are line-based, and flattening it first
// would hide it from them.
const REFUSAL_LINE_BREAK = /[\r\n\u2028\u2029]/;
// The remaining C0 and C1 control characters — anything that could break the
// notice's framing.
// eslint-disable-next-line no-control-regex
const REFUSAL_UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * A tool refusing a call, with a message written for the model.
 *
 * Throw it when the tool did NOT carry the call out (nothing was read from or
 * written to anything upstream) and the reason is something the model can act
 * on or tell the user: a host the audit mode forbids, a target that could not
 * be reached, a precondition the operator has to change. The message reaches
 * the model as written (one line, trimmed to {@link MAX_REFUSAL_MESSAGE_CHARS},
 * control characters removed; a message with line breaks stays withheld)
 * instead of the withheld notice, so write it yourself and keep it free of
 * data: no record, no response body, no upstream error text. Because nothing
 * was carried out, the model is not told the outcome is unknown, and a
 * sub-agent may repeat the call. Every other exception stays withheld.
 *
 * Recognised by its `name`, not by `instanceof`: a plugin bundles its own copy
 * of this package, and a plugin that must run on a host older than plugin-api
 * 1.28.0 can throw `Object.assign(new Error(msg), { name: 'ToolRefusalError' })`
 * instead of importing the class. An older host withholds it like any error.
 */
export class ToolRefusalError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = TOOL_REFUSAL_ERROR_NAME;
  }
}

/**
 * The message of a caught value when it is written for the model: a
 * {@link ToolRefusalError} (by name) or one of the kernel's `ctx.http`
 * permission errors (by name and message shape). `undefined` for anything else,
 * which stays withheld. The returned text is cleaned and bounded.
 */
export function modelReadableToolErrorMessage(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const { message } = err;
  if (typeof message !== 'string') return undefined;
  if (!isToolRefusalError(err) && !isKernelHttpRefusal(err)) return undefined;
  if (REFUSAL_LINE_BREAK.test(message)) return undefined;
  const cleaned = message.replace(REFUSAL_UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_REFUSAL_MESSAGE_CHARS
    ? `${cleaned.slice(0, MAX_REFUSAL_MESSAGE_CHARS - 1)}…`
    : cleaned;
}

/** True for a {@link ToolRefusalError}, recognised by `name`. */
export function isToolRefusalError(err: unknown): boolean {
  return err instanceof Error && err.name === TOOL_REFUSAL_ERROR_NAME;
}

/** True for a kernel `ctx.http` permission error (by name AND message shape). */
function isKernelHttpRefusal(err: Error): boolean {
  return (
    KERNEL_HTTP_REFUSAL_NAMES.has(err.name) &&
    typeof err.message === 'string' &&
    KERNEL_HTTP_REFUSAL_HEAD.test(err.message)
  );
}

/**
 * The model-facing text for a refused call: the tool name and the refusal's
 * own message. No "outcome is unknown" clause — the call was not carried out.
 * `message` must already be cleaned ({@link modelReadableToolErrorMessage}).
 */
export function refusedToolErrorNotice(toolName: string, message: string): string {
  return (
    `${TOOL_ERROR_PREFIX} tool \`${safeToken(toolName, 'unknown')}\` refused the call: ` +
    message
  );
}

/**
 * The model-facing text for a kernel `ctx.http` block the tool did not catch.
 * omadia refused that request, but the tool may have done something before it
 * (written a record, then failed to notify a host), so unlike a
 * {@link ToolRefusalError} the outcome stays unknown.
 */
export function blockedToolErrorNotice(toolName: string, message: string): string {
  return (
    `${TOOL_ERROR_PREFIX} tool \`${safeToken(toolName, 'unknown')}\` was stopped by omadia: ` +
    `${message} ${BLOCKED_NOTICE_TAIL}`
  );
}

const BLOCKED_NOTICE_TAIL =
  'Anything the tool did before this point may have taken effect, so do not ' +
  'repeat a call that changes data.';
const BLOCKED_NOTICE_HEAD = /^Error: tool `[A-Za-z0-9_.:-]+` was stopped by omadia: /;

/** A readable notice for a caught value, and whether the call was refused
 *  before doing anything (`refused`) or its outcome stays unknown. */
export interface ReadableToolErrorNotice {
  readonly text: string;
  readonly refused: boolean;
}

/**
 * The notice for an exception whose message may reach the model: a
 * {@link ToolRefusalError} ({@link refusedToolErrorNotice}, `refused: true`)
 * or a kernel `ctx.http` block ({@link blockedToolErrorNotice},
 * `refused: false`). `undefined` for every other exception, which stays
 * withheld ({@link withheldToolErrorNotice}).
 */
export function readableToolErrorNotice(
  toolName: string,
  err: unknown,
): ReadableToolErrorNotice | undefined {
  const message = modelReadableToolErrorMessage(err);
  if (message === undefined) return undefined;
  return isToolRefusalError(err)
    ? { text: refusedToolErrorNotice(toolName, message), refused: true }
    : { text: blockedToolErrorNotice(toolName, message), refused: false };
}

/**
 * True when `text` is a notice for a call whose outcome is unknown: the
 * withheld notice ({@link isWithheldToolErrorNotice}) or a kernel block
 * ({@link blockedToolErrorNotice}). The kernel's sub-agent loop refuses an
 * identical repeat of such a call. Recognised by shape, which any tool can
 * imitate: use it only to RESTRICT what happens next.
 */
export function isUnknownOutcomeToolErrorNotice(text: string): boolean {
  return isWithheldToolErrorNotice(text) || BLOCKED_NOTICE_HEAD.test(text);
}
