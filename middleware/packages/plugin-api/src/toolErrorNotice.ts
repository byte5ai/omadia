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
    'this ref. If the code points at your input, correct the call; otherwise ' +
    'continue without this tool or tell the user it is unavailable.'
  );
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
 * notice. Use this instead of `Error: ${err.message}`. A wrapper's OWN typed
 * errors whose messages it authored (a validation hint, "quota exceeded") are
 * not exceptions in this sense and may keep their text.
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
  log?.(
    `[${options?.site ?? 'tool'}:${toolName}] tool threw (ref=${ref}) — message withheld from the model:`,
    err,
  );
  return withheldToolErrorNotice(toolName, err, ref);
}
