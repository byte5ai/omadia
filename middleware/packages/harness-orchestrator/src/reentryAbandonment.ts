/**
 * How a verifier re-entry that cannot stay inside the first run ends
 * (`toolReplayLedger.ts`): the notice a seam hands the model for a refused
 * call, the names a re-entry is abandoned under, and the error the
 * orchestrator throws for it. Re-exported by `toolReplayLedger.ts`.
 */

/**
 * Why a re-entry was abandoned when no tool call outside the first run did
 * it. Passed to `ToolReplayLedger.abort` in place of a tool name.
 */
export const REENTRY_ABANDONED = {
  /** The turn answers an MCP input card: its parked call is take-once and
   *  already ran in the first run. */
  mcpInputReply: 'mcp-input-reply',
  /** The pass's prompt — the verifier's correction hint included — could not
   *  be masked for the model (#361, failure-closed). */
  promptMaskBlocked: 'prompt-mask-blocked',
  /** The pass found no first-run attachment ingestion to reuse; ingesting
   *  again would import the uploads outside the first run. */
  attachmentsNotRecorded: 'attachments-not-recorded',
} as const;

/** Characters a tool name may keep inside a notice's backticks. */
const UNSAFE_TOKEN_CHARS = /[^A-Za-z0-9_.:-]/g;

function safeToolName(toolName: string): string {
  return toolName.replace(UNSAFE_TOKEN_CHARS, '') || 'unknown';
}

/** What abandoned a re-entry — a tool name or one of {@link REENTRY_ABANDONED}
 *  — as a log line or error message says it. PII-free: names only. */
export function describeAbandonment(name: string): string {
  switch (name) {
    case REENTRY_ABANDONED.mcpInputReply:
      return 'it answers an MCP input card whose parked call already ran';
    case REENTRY_ABANDONED.promptMaskBlocked:
      return 'its prompt could not be masked for the model';
    case REENTRY_ABANDONED.attachmentsNotRecorded:
      return 'the first run left no attachment ingestion to reuse';
    default:
      return `tool "${safeToolName(name)}" is not in the first run's result set`;
  }
}

/**
 * The tool result a seam returns for a refused re-entry miss. Kernel-authored
 * and PII-free: the tool name only, never the input. Keeps the `Error:`
 * prefix so every loop flags it `is_error`.
 */
export function replayMissNotice(toolName: string): string {
  return (
    `Error: tool \`${safeToolName(toolName)}\` was not run: this answer is being ` +
    'regenerated over the results of the first attempt, and this call was not ' +
    'among them. Answer from the results you have.'
  );
}

/**
 * A verifier re-entry could not stay inside the first run's results.
 * `toolName` is the tool whose miss abandoned it, or one of
 * {@link REENTRY_ABANDONED}.
 */
export class ToolReplayAbortError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`verifier re-entry abandoned: ${describeAbandonment(toolName)}`);
    this.name = 'ToolReplayAbortError';
    this.toolName = toolName;
  }
}
