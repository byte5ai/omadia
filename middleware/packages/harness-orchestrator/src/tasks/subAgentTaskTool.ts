/**
 * W2-2 criterion 4 — the SECOND consumer of the long-running task seam:
 * sub-agent dispatch.
 *
 * This is the case that motivated the whole unit. A `DomainTool` built by
 * `registry/subAgentTools.ts` / `tools/domainQueryTool.ts` wraps an
 * {@link Askable} — in practice a `LocalSubAgent` running its own multi-turn LLM
 * loop with its own tools. `DomainTool.handle()` AWAITS that loop, so the parent
 * turn blocks for as long as the sub-agent runs: minutes for a research-shaped
 * question. That is exactly the failure the seam removes.
 *
 * Wrapping the same `Askable` here yields `ask_<name>_start` /
 * `ask_<name>_status` / `ask_<name>_list`: the parent turn gets a handle in
 * milliseconds, the sub-agent runs detached, and a following turn collects the
 * answer via `_status`.
 *
 * ## Why this needed no migration
 *
 * The sub-agent's task state is process-local ({@link InMemoryTaskStore}) — a
 * deliberate W2-2 boundary, since `0031`/`0032` are taken by parallel units and
 * this unit ships no schema change. A restart therefore drops in-flight
 * sub-agent tasks; they are reaped/absent rather than silently wrong, and a poll
 * says so. Making them durable is the follow-up that owns the migration.
 *
 * ## Blocking and non-blocking coexist
 *
 * This does NOT replace the blocking `ask_<name>` DomainTool. Both can be
 * registered: a question the sub-agent answers in seconds should stay inline
 * (one turn, one answer), and only genuinely slow sub-agents want the deferred
 * shape. Which sub-agents get it is an opt-in decision by the caller, so a
 * `LocalSubAgent` that returns quickly is never made worse.
 */

import type { AskObserver, Askable } from '../tools/domainQueryTool.js';

import { InMemoryTaskStore } from './inMemoryTaskStore.js';
import {
  defineLongRunningTool,
  type LongRunningToolHandle,
} from './longRunningTool.js';
import type { TaskStore } from './taskTypes.js';

/** Prefix mirroring `subAgentToolName()`'s `ask_<slug>` convention. */
export const SUB_AGENT_TASK_KIND_PREFIX = 'subagent';

export interface LongRunningSubAgentToolOptions {
  /**
   * The sub-agent's tool base name — pass the SAME value
   * `subAgentToolName(sub.name)` produced (e.g. `ask_hr`), so the deferred
   * triple is recognisably the same agent as the inline tool.
   */
  readonly baseToolName: string;
  /** Human-readable sub-agent name, used as the non-sensitive card label. */
  readonly displayName: string;
  /** What the sub-agent is for — shown to the parent model. */
  readonly description: string;
  /** The wrapped sub-agent. `LocalSubAgent` satisfies this. */
  readonly agent: Askable;
  /** Share one store across sub-agents, or omit for a private one. */
  readonly store?: TaskStore;
  /** Forwarded to `agent.ask` when the caller wants inner-loop observability. */
  readonly observer?: AskObserver;
  readonly onRunnerError?: (err: unknown, taskId: string) => void;
}

/**
 * Wrap an {@link Askable} sub-agent as a non-blocking tool triple.
 *
 * The executor is thin on purpose: `agent.ask()` is the whole operation, and the
 * phase/log calls around it exist so the status card has something truthful to
 * show while the sub-agent thinks.
 */
export function createLongRunningSubAgentTool(
  opts: LongRunningSubAgentToolOptions,
): LongRunningToolHandle {
  const store = opts.store ?? new InMemoryTaskStore();
  return defineLongRunningTool({
    toolName: opts.baseToolName,
    longRunning: true,
    kind: `${SUB_AGENT_TASK_KIND_PREFIX}.${opts.displayName}`,
    cardLabel: opts.displayName,
    startDescription:
      `${opts.description} Runs the "${opts.displayName}" sub-agent ` +
      'ASYNCHRONOUSLY: this call returns immediately with a task id, not with ' +
      'the answer. Use the matching `_status` tool to collect the answer once ' +
      'it is `completed`.',
    inputProperties: {
      question: {
        type: 'string',
        description:
          'The single, self-contained question for the sub-agent — including ' +
          'every id, name, and time range it needs, since you cannot clarify ' +
          'mid-run.',
      },
    },
    requiredInput: ['question'],
    validateInput: (input: unknown): string | null => {
      const question = (input as Record<string, unknown>)['question'];
      if (typeof question !== 'string' || question.trim().length === 0) {
        return '`question` must be a non-empty string.';
      }
      return null;
    },
    store,
    ...(opts.onRunnerError ? { onRunnerError: opts.onRunnerError } : {}),
    execute: async (input, handle): Promise<string> => {
      const question = String((input as Record<string, unknown>)['question']);
      await handle.setPhase('asking');
      // Truncated preview only — a card/event line must stay non-sensitive and
      // bounded, and the full question is already in the task's stored input.
      await handle.log('tool', `delegating to ${opts.displayName}`);
      const answer = await opts.agent.ask(question, opts.observer);
      await handle.setPhase('answered');
      return answer;
    },
  });
}
