/**
 * W2-2 (issue #543) — pure helpers for the GENERIC long-running task card.
 *
 * Delivery mechanism, and why it needs no new stream event: a task started from
 * chat surfaces as an ordinary `<tool>_start` tool call in the chat stream (a
 * `tool_use` paired with its `tool_result`). The tool result is the seam's
 * documented contract string
 * `{"status":"task_started","taskId":…,"tool":…,"kind":…,"phase":"queued"}`.
 * The chat UI detects any tool whose name ends in `_start`, parses the seed
 * below, and renders a card. Same mechanism `parseDevJobStartResult` already
 * uses for `dev_job_start` — this is its tool-agnostic sibling.
 *
 * PRIVACY: the seed is metadata only (ids, kind, progress label). The task's
 * RESULT deliberately never rides on the card: it is delivered by the model
 * calling `<tool>_status`, whose return value passes through the orchestrator's
 * `dispatchTool` privacy pass. See `describeDeferredPrivacyPosture()` in
 * `middleware/packages/harness-orchestrator/src/tasks/longRunningTool.ts`.
 */

/** The seed a `<tool>_start` tool result carries into the card. */
export interface TaskCardSeed {
  taskId: string;
  /** The `<tool>_start` tool that produced it. */
  tool: string;
  kind: string;
  phase: string;
}

/**
 * Parse a `<tool>_start` tool-result string. Returns a seed only for a
 * successful launch (`status === 'task_started'` with a string `taskId`);
 * returns `null` for a refusal / `Error:` string or any non-launch payload, so
 * the caller falls back to the plain tool row.
 */
export function parseTaskStartResult(output: string | undefined): TaskCardSeed | null {
  if (!output) return null;
  const trimmed = output.trim();
  if (!trimmed.startsWith('{')) return null; // `Error: …` and prose never parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj['status'] !== 'task_started') return null;
  const taskId = obj['taskId'];
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  const tool = typeof obj['tool'] === 'string' ? obj['tool'] : '';
  const kind = typeof obj['kind'] === 'string' ? obj['kind'] : '';
  const phase = typeof obj['phase'] === 'string' ? obj['phase'] : 'queued';
  return { taskId, tool, kind, phase };
}

/**
 * Human label for a `<tool>_start` name: `ask_research_start` → `research`.
 * Falls back to the raw name so an unrecognised shape still reads sensibly.
 */
export function taskCardLabel(toolName: string): string {
  const base = toolName.replace(/_start$/, '').replace(/^ask_/, '');
  return base.length > 0 ? base.replace(/_/g, ' ') : toolName;
}

/**
 * Does this tool name look like the seam's start half? Used to decide whether to
 * even attempt a parse, so a normal tool's JSON output is never mistaken for a
 * task handle.
 */
export function isTaskStartToolName(name: string): boolean {
  return name.endsWith('_start');
}
