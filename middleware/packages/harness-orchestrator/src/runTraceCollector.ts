import type { AskObserver } from './tools/domainQueryTool.js';
import type {
  RunAgentInvocation,
  RunStatus,
  RunToolCall,
} from '@omadia/plugin-api';
import type { RunTracePayload } from '@omadia/channel-sdk';

/**
 * `RunTracePayload` was lifted to `@omadia/channel-sdk` in S+10-2 so
 * the orchestrator-plugin (S+10-3/4) and channel-plugins-final (S+11) can
 * consume it without a peer-dep on the knowledge-graph package. The shape
 * is a structural copy of `Omit<RunTrace, 'turnId'>` from
 * `@omadia/knowledge-graph`; the session logger still hands the
 * payload to `KnowledgeGraph.ingestTurn` after stamping the canonical
 * `turnId`, and TypeScript structurally accepts the cross-package
 * compatibility (RunStatus + RunToolCall + RunAgentInvocation shapes
 * match by construction; see `chatAgent.ts` for the inlined copies).
 *
 * Re-exported here so kernel-side callers (`./services/orchestrator.ts`
 * back-compat barrel, `./services/sessionLogger.ts`, etc.) can keep
 * importing `RunTracePayload from './runTraceCollector.js'` without
 * crossing into the SDK directly. Sub-Commit S+10-3 flips those imports.
 */
export type { RunTracePayload };

export interface InvocationHandle {
  readonly agentName: string;
  readonly index: number;
  readonly observer: AskObserver;
  finish(opts: { durationMs: number; status: RunStatus }): void;
}

export interface RunTraceCollectorOptions {
  scope: string;
  userId?: string;
  /** ISO timestamp. Passed in so tests can pin it; production uses now(). */
  startedAt?: string;
}

/**
 * Gathers the agentic run-graph signal during a single orchestrator turn.
 * - Orchestrator-level tool calls (memory, query_knowledge_graph, …) are
 *   recorded with {@link recordOrchestratorToolCall}.
 * - Each domain-tool invocation is bracketed by {@link beginInvocation} +
 *   the returned handle's `finish()`. The handle's `observer` is dropped
 *   into the sub-agent's `ask()` call, so sub-iterations and inner tool
 *   calls are captured without extra plumbing.
 * - {@link finish} produces a {@link RunTracePayload} for the session logger
 *   to finalise with a turn id and hand off to the graph.
 */
export class RunTraceCollector {
  private readonly startedAt: string;

  private readonly orchestratorToolCalls: RunToolCall[] = [];

  private readonly agentInvocations: RunAgentInvocation[] = [];

  private invocationIndex = 0;

  constructor(private readonly opts: RunTraceCollectorOptions) {
    this.startedAt = opts.startedAt ?? new Date().toISOString();
  }

  recordOrchestratorToolCall(
    call: Omit<RunToolCall, 'agentContext'>,
  ): void {
    this.orchestratorToolCalls.push({
      ...call,
      agentContext: 'orchestrator',
    });
  }

  beginInvocation(agentName: string): InvocationHandle {
    const index = this.invocationIndex++;
    const toolCallStarts = new Map<string, { name: string }>();
    const subToolCalls: RunToolCall[] = [];
    let subIterations = 0;
    let finished = false;
    const push = (inv: RunAgentInvocation): void => {
      this.agentInvocations.push(inv);
    };

    const observer: AskObserver = {
      onIteration: () => {
        subIterations++;
      },
      onSubToolUse: (ev) => {
        toolCallStarts.set(ev.id, { name: ev.name });
      },
      onSubToolResult: (ev) => {
        const meta = toolCallStarts.get(ev.id);
        subToolCalls.push({
          callId: ev.id,
          toolName: meta?.name ?? 'unknown',
          durationMs: ev.durationMs,
          isError: ev.isError,
          agentContext: agentName,
        });
        toolCallStarts.delete(ev.id);
      },
    };

    return {
      agentName,
      index,
      observer,
      finish({ durationMs, status }): void {
        if (finished) return;
        finished = true;
        push({
          index,
          agentName,
          durationMs,
          subIterations,
          status,
          toolCalls: subToolCalls,
        });
      },
    };
  }

  finish(opts: {
    iterations: number;
    status: RunStatus;
    error?: string;
    finishedAt?: string;
  }): RunTracePayload {
    const finishedAt = opts.finishedAt ?? new Date().toISOString();
    const startMs = Date.parse(this.startedAt);
    const finishMs = Date.parse(finishedAt);
    const payload: RunTracePayload = {
      scope: this.opts.scope,
      ...(this.opts.userId ? { userId: this.opts.userId } : {}),
      startedAt: this.startedAt,
      finishedAt,
      durationMs: Math.max(0, finishMs - startMs),
      status: opts.status,
      iterations: opts.iterations,
      orchestratorToolCalls: this.orchestratorToolCalls,
      agentInvocations: this.agentInvocations,
      ...(opts.error ? { error: opts.error } : {}),
    };
    return payload;
  }
}
