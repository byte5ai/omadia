/**
 * #1402 — keep a Privacy Shield v4 table render's real rows off the LLM wire.
 *
 * `v4_render_answer` materializes the answer from the REAL rows. Its
 * `_pendingCanvasTree` snapshot is for the canvas only; the model's
 * `tool_result` must be the shape-only acknowledgement. A current guard hands
 * the snapshot back as `canvasSentinel`. A guard that predates the field still
 * embeds a render's snapshot in `resultText` — a `_pending*` sentinel in a
 * `v4_render_answer` result is moved to the side channel and replaced by a
 * kernel-authored note, so the model never reads real values whichever guard
 * is installed. Verb results (digests) pass through untouched.
 */

import type { PrivacyV4ToolResult } from '@omadia/plugin-api';

export const V4_RENDER_TOOL_NAME = 'v4_render_answer';

/** Same wording as the guard's private `V4_RENDER_NOTE`
 *  (harness-plugin-privacy-guard/src/service.ts) — keep the two in step. */
export const V4_RENDER_KERNEL_NOTE =
  '[privacy-shield-v4] Final answer rendered server-side for the user. ' +
  'The turn is complete — do not restate the answer.';

export interface V4ToolResultSplit {
  /** The text for the model's `tool_result` block. */
  readonly llmText: string;
  /** User-destined canvas sentinel, for the turn's canvas-sentinel sink. */
  readonly canvasSentinel?: string;
}

export function splitV4ToolResult(
  toolName: string,
  result: PrivacyV4ToolResult,
): V4ToolResultSplit {
  const legacySnapshot =
    toolName === V4_RENDER_TOOL_NAME && result.resultText.includes('"_pending');
  const llmText = legacySnapshot ? V4_RENDER_KERNEL_NOTE : result.resultText;
  const canvasSentinel =
    result.canvasSentinel ?? (legacySnapshot ? result.resultText : undefined);
  return canvasSentinel !== undefined ? { llmText, canvasSentinel } : { llmText };
}
