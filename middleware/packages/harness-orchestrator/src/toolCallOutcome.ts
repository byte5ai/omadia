/**
 * #1502 — what an `onAfterToolCall` hook learns about a finished top-level
 * tool call, beyond its name and result text.
 *
 * - `toolFailed`: the result is an `Error:` string, or the tool is a sub-agent
 *   whose every inner tool call failed. Such a sub-agent still answers in
 *   prose ("I could not reach Confluence …"), so its result text alone looks
 *   like a success.
 * - `toolIsBookkeeping`: the tool serves the turn itself (the memory
 *   directory, the server-rendered answer, follow-up and choice cards), not
 *   the user's task. A hook that maps calls to task progress skips these.
 *
 * Both fire paths (buffered tool loop, streaming wrapper) build the payload
 * here, so they cannot drift.
 */

import { MEMORY_TOOL_NAME } from './registry/subAgentMemoryTool.js';
import type { AskObserver } from './tools/domainQueryTool.js';
import { ASK_USER_CHOICE_TOOL_NAME } from './tools/askUserChoiceTool.js';
import { SUGGEST_FOLLOW_UPS_TOOL_NAME } from './tools/suggestFollowUpsTool.js';
import type { TurnHookPayload } from './turnHooks.js';
import { V4_RENDER_TOOL_NAME } from './v4RenderSideChannel.js';

const BOOKKEEPING_TOOL_NAMES: ReadonlySet<string> = new Set([
  MEMORY_TOOL_NAME,
  V4_RENDER_TOOL_NAME,
  SUGGEST_FOLLOW_UPS_TOOL_NAME,
  ASK_USER_CHOICE_TOOL_NAME,
]);

export function isBookkeepingTool(name: string): boolean {
  return BOOKKEEPING_TOOL_NAMES.has(name);
}

/** Counts the inner tool results of each running sub-agent call, keyed by
 *  the top-level tool_use id. */
export class SubToolOutcomeTally {
  private readonly byParent = new Map<string, { calls: number; failed: number }>();

  record(parentId: string, isError: boolean): void {
    const entry = this.byParent.get(parentId) ?? { calls: 0, failed: 0 };
    this.byParent.set(parentId, {
      calls: entry.calls + 1,
      failed: entry.failed + (isError ? 1 : 0),
    });
  }

  /** True when the call made inner tool calls and none of them succeeded. */
  allFailed(parentId: string): boolean {
    const entry = this.byParent.get(parentId);
    return entry !== undefined && entry.calls > 0 && entry.failed === entry.calls;
  }

  /** An observer that tallies `parentId`'s inner results and forwards every
   *  event to `inner` (when given). Every callback delegates explicitly (no
   *  spread), so an observer whose methods live on a prototype loses none. */
  observe(parentId: string, inner: AskObserver | undefined): AskObserver {
    return {
      onIteration: (ev) => inner?.onIteration?.(ev),
      onSubToolUse: (ev) => inner?.onSubToolUse?.(ev),
      onSubToolResult: (ev) => {
        this.record(parentId, ev.isError);
        inner?.onSubToolResult?.(ev);
      },
      onIterationPhase: (ev) => inner?.onIterationPhase?.(ev),
      onTokenChunk: (ev) => inner?.onTokenChunk?.(ev),
      onIterationUsage: (ev) => inner?.onIterationUsage?.(ev),
      onIterationEnd: (ev) => inner?.onIterationEnd?.(ev),
    };
  }
}

export function afterToolCallPayload(input: {
  toolName: string | undefined;
  toolResult: string | undefined;
  isError: boolean;
  innerCallsAllFailed: boolean;
}): TurnHookPayload {
  return {
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    ...(input.toolResult !== undefined ? { toolResult: input.toolResult } : {}),
    toolFailed: input.isError || input.innerCallsAllFailed,
    toolIsBookkeeping: input.toolName !== undefined && isBookkeepingTool(input.toolName),
  };
}
