/**
 * Calls a `LocalSubAgent` run must not repeat: the ones that ended in an
 * exception.
 *
 * An exception says nothing about how far a call got. A write can commit
 * upstream and its response then time out or drop, so the tool throws after
 * the data changed. Inside a sub-agent such a call is a tool result the
 * sub-agent answers around (`toolErrorRedaction.ts`), which leaves its model
 * free to call the same tool with the same input again, and the write would
 * run twice. `LocalSubAgentTool` carries no write-capability metadata, so the
 * loop cannot tell a read it could retry from a write it must not repeat. It
 * refuses every identical repeat for the rest of the run instead (same tool,
 * same canonical input): at most once beats at least once for writes, the rule
 * the MCP client's own retry follows under an idempotency scope (#542). A call
 * with another input still runs, and so does a retry after an ordinary
 * returned `Error:` hint, whose tool knew how far it got.
 *
 * A call ended in an exception when its handler threw, or when its wrapper
 * caught the exception and returned the withheld notice instead (the platform
 * tool bridges, `toolErrorFromException`), which `isWithheldToolErrorNotice`
 * (`@omadia/plugin-api`) recognises by shape. A tool that imitates the shape
 * only blocks its own repeat.
 */

import { TOOL_ERROR_PREFIX } from '@omadia/plugin-api';

/** Characters a tool name may keep inside the refusal's backticks. */
const UNSAFE_TOKEN_CHARS = /[^A-Za-z0-9_.:-]/g;

/** What one inner tool call of a sub-agent hands back to its loop. */
export interface SubToolOutcome {
  output: string;
  postcondition?: { issues: readonly string[] };
  /** The call ended in an exception; an identical repeat is refused. */
  outcomeUnknown?: true;
  /** A verifier re-entry handed back the first run's outcome; the handler
   *  did not run (`toolReplayLedger.ts`). */
  replayed?: true;
}

/** The calls of one sub-agent run that ended in an exception. */
export class UnknownOutcomeCalls {
  readonly #keys = new Set<string>();

  /** Remember a call (tool name + canonical input) whose outcome is unknown. */
  add(toolName: string, inputHash: string): void {
    this.#keys.add(keyOf(toolName, inputHash));
  }

  /** True when an identical call ended in an exception earlier in the run. */
  has(toolName: string, inputHash: string): boolean {
    return this.#keys.has(keyOf(toolName, inputHash));
  }
}

function keyOf(toolName: string, inputHash: string): string {
  return `${toolName}\u0000${inputHash}`;
}

/**
 * The tool result for a refused repeat. Kernel-authored and PII-free: the tool
 * name only, never the input. Keeps the `Error:` prefix, so the loop flags it
 * `is_error` and counts it toward its repeat-failure guard.
 */
export function repeatRefusedNotice(toolName: string): string {
  const name = toolName.replace(UNSAFE_TOKEN_CHARS, '') || 'unknown';
  return (
    `${TOOL_ERROR_PREFIX} tool \`${name}\` was not called: an identical call ` +
    '(same tool, same input) ended in an exception earlier in this run, so ' +
    'whether it took effect is unknown. Do not repeat a call that changes ' +
    'data; continue without this tool or tell the user it is unavailable.'
  );
}

/** The loop's answer to a refused repeat, logged without the input. */
export function refusedRepeat(agentName: string, toolName: string): SubToolOutcome {
  console.warn(
    `[sub-agent ${agentName}] refused an identical repeat of '${toolName}': the earlier call ended in an exception, its outcome is unknown`,
  );
  return { output: repeatRefusedNotice(toolName) };
}
