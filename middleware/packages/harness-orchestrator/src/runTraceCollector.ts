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

  beginInvocation(agentName: string, agentId?: string): InvocationHandle {
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
          ...(ev.postcondition ? { postcondition: ev.postcondition } : {}),
          ...(ev.usage ? { usage: ev.usage } : {}),
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
          ...(agentId !== undefined ? { agentId } : {}),
          durationMs,
          subIterations,
          status,
          toolCalls: subToolCalls,
        });
      },
    };
  }

  /**
   * #650 — record which model produced this turn's answer, and who served it.
   *
   * Set ONCE, right after per-turn model routing resolves, rather than passed
   * to `finish()`. `finish()` has five call sites across the buffered and
   * streaming paths; threading two more arguments through all of them is five
   * chances to miss one, and a trace that silently lacks the model on exactly
   * one exit path is worse than not having the field — it looks recorded.
   *
   * Last write wins, so a turn that re-routes mid-flight reports the model that
   * actually answered.
   */
  recordModel(model: string, provider?: string): void {
    this.model = model;
    this.provider = provider;
  }

  private model?: string;
  private provider?: string;

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
      // #650 — omitted entirely when unknown rather than written as an empty
      // string: a trace that carries `model: ''` claims to know and does not.
      ...(this.model ? { model: this.model } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(opts.error ? { error: opts.error } : {}),
    };
    return payload;
  }
}
