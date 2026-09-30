/**
 * The tool result a platform tool bridge returns when a bridged tool fails —
 * `bridgeTool` (`dynamicAgentRuntime.ts`), `bridgePreviewTool`
 * (`builder/previewChatService.ts`) and `bridgeBuilderTool`
 * (`builder/builderAgent.ts`).
 *
 * The bridges used to answer every failure with `Error: ${err.message}`, which
 * put exception text on the model's wire: an ORM or HTTP client echoes the
 * record it failed on, and nothing sanitized it. What a failure may carry now
 * depends on WHERE it happened, not on the error's type:
 *
 *  - `input` — the model's own arguments failed the tool's Zod input schema.
 *    The issue list (path + message) is derived from the schema and from what
 *    the model itself sent, so it comes back as a readable hint the model can
 *    correct its call from. (The raw `ZodError` message is a JSON dump, which
 *    the dispatch seams withhold as exception-shaped.)
 *  - `run` — the tool's own code threw. That message is withheld:
 *    `toolErrorFromException` logs the full error under a reference and
 *    returns the data-free notice (class name, sanitised code, ref). This
 *    includes a `ZodError` thrown INSIDE the tool — a schema validating an
 *    upstream response reports upstream values, not the model's input.
 */

import { TOOL_ERROR_PREFIX, toolErrorFromException } from '@omadia/plugin-api';

/** Which step of a bridged call failed. */
export type BridgeStage = 'input' | 'run';

/** At most this many input issues are listed; the rest are counted. */
const MAX_LISTED_ISSUES = 5;
/** Upper bound on the listed issues, so a pathological schema stays short. */
const MAX_HINT_CHARS = 600;
/** Characters a tool id may keep inside the backticks of the hint. */
const UNSAFE_ID_CHARS = /[^A-Za-z0-9_.:-]/g;

interface InputIssue {
  readonly path?: unknown;
  readonly message?: unknown;
}

function issuesOf(err: unknown): readonly InputIssue[] | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) && issues.length > 0
    ? (issues as InputIssue[])
    : undefined;
}

function describeIssue(issue: InputIssue): string {
  const path =
    Array.isArray(issue.path) && issue.path.length > 0
      ? issue.path.map(String).join('.')
      : '<root>';
  const message =
    typeof issue.message === 'string' && issue.message.length > 0
      ? issue.message.replace(/\s+/g, ' ')
      : 'invalid value';
  return `${path}: ${message}`;
}

/**
 * The `Error:` result for a failed bridged call. Never contains the text of an
 * exception the tool's own code threw.
 */
export function bridgedToolError(
  toolId: string,
  err: unknown,
  stage: BridgeStage,
  site: string,
): string {
  const issues = stage === 'input' ? issuesOf(err) : undefined;
  if (issues === undefined) {
    return toolErrorFromException(toolId, err, { site });
  }
  const listed = issues.slice(0, MAX_LISTED_ISSUES).map(describeIssue).join('; ');
  const more =
    issues.length > MAX_LISTED_ISSUES
      ? ` (+${String(issues.length - MAX_LISTED_ISSUES)} more)`
      : '';
  const id = toolId.replace(UNSAFE_ID_CHARS, '') || 'tool';
  return (
    `${TOOL_ERROR_PREFIX} invalid input for \`${id}\` — ` +
    `${listed}${more}`.slice(0, MAX_HINT_CHARS)
  );
}
