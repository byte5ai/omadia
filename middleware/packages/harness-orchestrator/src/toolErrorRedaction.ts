/**
 * Tool errors on their way to a model — the one ingestion helper every
 * tool-dispatch seam routes them through.
 *
 * Why this exists: the Privacy Shield only ever saw what a tool RETURNED as
 * data. A tool error slipped past it on two routes. A handler that THREW had its
 * message folded into `Error: ${err.message}` by the dispatch loops, and a
 * fulfilled `Error:` string (the tool-error convention, #1105/#1097) was passed
 * through un-interned so the model could read its hint. Neither text is
 * sanitized by construction: an ORM echoes the failing row, a driver the bound
 * parameters, a remote MCP server whatever its error body quotes. Both reached
 * the provider wire, the streamed `tool_result` event and the persisted session
 * verbatim, and neither left a receipt entry.
 *
 * The policy follows PROVENANCE, not the carrier's shape:
 *
 *  - THROWN (`withholdThrownToolError`): the message is never forwarded. The
 *    model gets `Error: tool \`<name>\` failed with <ErrorClass> (code <code>)
 *    [ref <ref>] …` — class name and a sanitised code only — and the full error
 *    (message, stack, cause) goes to the server log under the same ref, which
 *    is the turn's correlation id (#641: the id a degraded turn reports as
 *    `<turn-incomplete ref="…">`). That log line is where an operator recovers
 *    the driver text.
 *  - RETURNED `Error:` (`guardControlFlowResult`): the text behind the prefix
 *    goes through the privacy provider's free-text redactor
 *    (`redactToolErrorText`: C0 identity types, the operator deny-list, C1),
 *    which replaces every span irreversibly with `[masked:<type>]` so the hint
 *    survives. It is WITHHELD whole instead when it is exception-shaped (a JSON
 *    or dict row echo, a stack trace — partial regex masking of a record dump is
 *    not reliable, names survive it), when it is too long to check, or when the
 *    provider cannot redact (it predates the contract, throws, or reports
 *    `withheld`). Fail closed, never forward unchecked.
 *  - MCP CONNECT PROMPT: passes byte-identical. It is kernel-authored, and the
 *    connect URL and the `<mcp-auth-required>` block the chat UI parses into a
 *    Connect card must survive (C0's phone pattern would rewrite digit runs in
 *    the URL). Known limit: recognized by its prefix only.
 *
 * Every handled error writes a PII-free `toolErrors` entry into the turn's
 * privacy receipt (`recordToolError`).
 *
 * Parity default: with no privacy provider installed nothing is masked at all,
 * tool results included, so a thrown message still flows raw there; the same
 * holds for intern-exempt self tools (`privacyInternPolicy.ts`), whose errors
 * are the agent's own operational state. Seams must call these helpers AFTER
 * the intern exemption and the operator bypass, and BEFORE interning.
 */

import {
  MCP_AUTH_PROMPT_PREFIX,
  TOOL_ERROR_PREFIX,
  newToolErrorRef,
  withheldToolErrorNotice,
} from '@omadia/plugin-api';
import type {
  PromptMaskedSpanInfo,
  ToolErrorCarrier,
  ToolErrorOutcome,
} from '@omadia/plugin-api';

import type { PrivacyTurnHandle } from './privacyHandle.js';
import { isInternExemptTool } from './privacyInternPolicy.js';
import { turnContext } from './turnContext.js';

/**
 * Longest returned error body (after the `Error:` prefix) that is redacted.
 * The C0 regex baseline is superlinear on long unbroken runs (a 40 KB body
 * costs about a second), prompt text is bounded by the chat input but a remote
 * error body is not, and an error hint worth reading is a sentence or two.
 * Longer text is withheld.
 */
export const MAX_REDACTABLE_TOOL_ERROR_CHARS = 4096;

/** Why a returned error text was withheld instead of redacted. */
export type ToolErrorWithholdReason =
  | 'too_long'
  | 'exception_shaped'
  | 'provider_unsupported'
  | 'redaction_failed';

/** The minimum provider version that implements `redactToolErrorText`. */
const REQUIRED_PROVIDER = '@omadia/plugin-privacy-guard >= 0.6.0';

// A quoted key followed by a colon, opened by `{`, `[` or `,`: a JSON object,
// a Python dict repr, an array of such — the shape of a record echo. Bounded
// quantifiers keep the scan linear.
const OBJECT_KEY = /[{[,]\s*["'][^"'\n]{1,128}["']\s*:/;
// A JavaScript / Java stack frame on its own line.
const STACK_FRAME = /\n\s*at\s+\S/;
// A Python traceback.
const PY_TRACEBACK = /Traceback \(most recent call last\)|\bFile "[^"\n]{1,256}", line \d+/;
// Postgres unique-violation detail: `Key (email)=(jane@…) already exists`.
const KEY_VALUE_DETAIL = /\bKey \([^)\n]{1,128}\)=\(/;

const UNSAFE_TOKEN_CHARS = /[^A-Za-z0-9_.:-]/g;

/** A process-wide latch so a provider gap is reported once, not per call. */
let providerGapLogged = false;

/** Test seam: re-arm the once-per-process diagnostics. */
export function resetToolErrorRedactionDiagnostics(): void {
  providerGapLogged = false;
}

/**
 * The correlation reference a seam puts into a notice and its log line: the
 * turn's id (#641) when a turn is active, otherwise a fresh `err_…` token.
 */
export function toolErrorRef(): string {
  const turnId = turnContext.currentTurnId();
  return turnId !== undefined && turnId !== '' ? turnId : newToolErrorRef();
}

/** True when an error text looks like a raw exception or a record dump. */
export function looksExceptionShaped(text: string): boolean {
  return (
    OBJECT_KEY.test(text) ||
    STACK_FRAME.test(text) ||
    PY_TRACEBACK.test(text) ||
    KEY_VALUE_DETAIL.test(text)
  );
}

/** The model-facing notice for a thrown exception (class name, code, ref). */
export function thrownToolErrorForModel(
  toolName: string,
  err: unknown,
  ref: string,
): string {
  return withheldToolErrorNotice(toolName, err, ref);
}

function safeToken(value: string): string {
  const cleaned = value.replace(UNSAFE_TOKEN_CHARS, '');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

const WITHHOLD_CLAUSE: Readonly<Record<ToolErrorWithholdReason, string>> = {
  too_long: 'was too long to check for personal data',
  exception_shaped: 'looked like a raw exception or record dump',
  provider_unsupported:
    `could not be checked: the installed privacy provider predates tool-error redaction (${REQUIRED_PROVIDER} required)`,
  redaction_failed: 'could not be checked for personal data',
};

/** The model-facing notice for a returned `Error:` text that was withheld. */
export function returnedToolErrorWithheldNotice(
  toolName: string,
  ref: string,
  reason: ToolErrorWithholdReason,
): string {
  return (
    `${TOOL_ERROR_PREFIX} tool \`${safeToken(toolName)}\` reported an error whose text ` +
    `${WITHHOLD_CLAUSE[reason]}; it was withheld from the model [ref ${safeToken(ref)}]. ` +
    'An operator can find it in the server log under this ref. Continue without ' +
    'this tool or tell the user it is unavailable.'
  );
}

interface ToolErrorReceiptEntry {
  readonly toolName: string;
  readonly carrier: ToolErrorCarrier;
  readonly outcome: ToolErrorOutcome;
  readonly bytes: number;
  readonly redactedSpans?: readonly PromptMaskedSpanInfo[];
}

/** Receipt writes never fail a dispatch. A stub handle may lack the member. */
async function recordSafely(
  privacy: PrivacyTurnHandle,
  entry: ToolErrorReceiptEntry,
  site: string,
): Promise<void> {
  if (typeof privacy.recordToolError !== 'function') return;
  try {
    await privacy.recordToolError(entry);
  } catch (err) {
    console.warn(
      `[${site}:${entry.toolName}] privacy.recordToolError threw — receipt entry dropped:`,
      err,
    );
  }
}

export interface ThrownToolErrorOutcome {
  /** The model-facing text: the withheld notice, or — parity — the raw message
   *  formatted by `formatRaw`. */
  readonly text: string;
  /** True when the message was withheld (and receipted). */
  readonly withheld: boolean;
}

/**
 * For an exception a tool handler THREW. Logs the full error under the ref and,
 * under a privacy handle (and for a tool that is not intern-exempt), returns the
 * withheld notice and records a `thrown`/`withheld` receipt entry. Never throws.
 */
export async function withholdThrownToolError(input: {
  readonly toolName: string;
  readonly err: unknown;
  readonly privacy: PrivacyTurnHandle | undefined;
  /** Log prefix naming the seam, e.g. `orchestrator.dispatchTool`. */
  readonly site: string;
  /** Correlation ref. Default {@link toolErrorRef}. */
  readonly ref?: string;
  /** Parity formatting when nothing is withheld. Default `Error: <message>`. */
  readonly formatRaw?: (message: string) => string;
}): Promise<ThrownToolErrorOutcome> {
  const { toolName, err, privacy, site } = input;
  const ref = input.ref !== undefined && input.ref !== '' ? input.ref : toolErrorRef();
  const message = err instanceof Error ? err.message : String(err);
  const withhold = privacy !== undefined && !isInternExemptTool(toolName);
  console.error(
    `[${site}:${toolName}] tool threw (ref=${ref})` +
      `${withhold ? ' — message withheld from the model' : ''}:`,
    err,
  );
  if (!withhold) {
    const format = input.formatRaw ?? ((m: string): string => `${TOOL_ERROR_PREFIX} ${m}`);
    return { text: format(message), withheld: false };
  }
  await recordSafely(
    privacy,
    {
      toolName,
      carrier: 'thrown',
      outcome: 'withheld',
      bytes: Buffer.byteLength(message, 'utf8'),
    },
    site,
  );
  return { text: thrownToolErrorForModel(toolName, err, ref), withheld: true };
}

/**
 * For a fulfilled control-flow result (precondition:
 * `isControlFlowToolResult(result)`) under a privacy handle. Returns the text
 * the model may read: the connect prompt unchanged, a redacted `Error:` text,
 * or the withheld notice. Never throws.
 */
export async function guardControlFlowResult(input: {
  readonly toolName: string;
  readonly result: string;
  readonly privacy: PrivacyTurnHandle;
  readonly site: string;
}): Promise<string> {
  const { toolName, result, privacy, site } = input;
  const bytes = Buffer.byteLength(result, 'utf8');

  if (result.startsWith(MCP_AUTH_PROMPT_PREFIX)) {
    await recordSafely(privacy, { toolName, carrier: 'mcp_auth_prompt', outcome: 'passed', bytes }, site);
    return result;
  }

  const withhold = async (reason: ToolErrorWithholdReason): Promise<string> => {
    const ref = toolErrorRef();
    console.error(
      `[${site}:${toolName}] returned tool error withheld from the model (ref=${ref}, reason=${reason}):`,
      result,
    );
    await recordSafely(privacy, { toolName, carrier: 'returned', outcome: 'withheld', bytes }, site);
    return returnedToolErrorWithheldNotice(toolName, ref, reason);
  };

  // The caller keeps the prefix, so `is_error` stays derivable whatever a
  // detector does to the body.
  const body = result.startsWith(TOOL_ERROR_PREFIX)
    ? result.slice(TOOL_ERROR_PREFIX.length)
    : result;
  if (body.length > MAX_REDACTABLE_TOOL_ERROR_CHARS) return withhold('too_long');
  if (looksExceptionShaped(body)) return withhold('exception_shaped');

  if (typeof privacy.redactToolErrorText !== 'function') {
    logProviderGapOnce();
    return withhold('provider_unsupported');
  }
  let redacted;
  try {
    redacted = await privacy.redactToolErrorText({ toolName, text: body });
  } catch (err) {
    console.warn(`[${site}:${toolName}] privacy.redactToolErrorText threw — withholding:`, err);
    return withhold('redaction_failed');
  }
  if (redacted === undefined) {
    logProviderGapOnce();
    return withhold('provider_unsupported');
  }
  if (redacted.outcome !== 'redacted') return withhold('redaction_failed');
  await recordSafely(
    privacy,
    {
      toolName,
      carrier: 'returned',
      outcome: 'redacted',
      bytes,
      ...(redacted.spans.length > 0 ? { redactedSpans: redacted.spans } : {}),
    },
    site,
  );
  return `${TOOL_ERROR_PREFIX}${redacted.text}`;
}

function logProviderGapOnce(): void {
  if (providerGapLogged) return;
  providerGapLogged = true;
  console.error(
    '[orchestrator] the installed privacy.redact@1 provider does not implement ' +
      'redactToolErrorText — returned `Error:` tool results are WITHHELD from the ' +
      `model until ${REQUIRED_PROVIDER} is installed (logged once per process).`,
  );
}
