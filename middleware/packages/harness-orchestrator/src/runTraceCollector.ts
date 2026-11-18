import type { AskObserver } from './tools/domainQueryTool.js';
import type {
  EntityRef,
  EntityRefCollection,
  RunAgentInvocation,
  RunStatus,
  RunToolCall,
} from '@omadia/plugin-api';
import type { RunTracePayload } from '@omadia/channel-sdk';
import { KNOWLEDGE_GRAPH_TOOL_NAME } from './knowledgeGraphTool.js';
import { knowledgeGraphRefsIn } from './knowledgeGraphRefs.js';

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
  /** `replayed`: a verifier re-entry handed back the first run's result,
   *  the sub-agent did not run in this pass. */
  finish(opts: { durationMs: number; status: RunStatus; replayed?: boolean }): void;
}

export interface RunTraceCollectorOptions {
  scope: string;
  userId?: string;
  /** ISO timestamp. Passed in so tests can pin it; production uses now(). */
  startedAt?: string;
  /** #1571 — the turn's id (the turn context's), kept beside the payload for
   *  the verifier ({@link turnEvidenceOf}). */
  turnId?: string;
  /** #1574 — the turn's EntityRef collection: the records its tools read,
   *  kept beside the payload for the verifier ({@link turnEvidenceOf}). */
  entityRefs?: SharedEntityRefs;
}

/**
 * #1574 — one turn's EntityRef collection, read by two consumers: the run
 * trace (for the verifier, at `finish()`) and the session-log row (at
 * `drain()`). The first read drains the bus collection; both see the same
 * refs. `drain()` keeps the bus semantics: the refs once, then `[]`. A ref
 * published after the trace finished (no tool runs then) is not collected.
 */
export class SharedEntityRefs implements EntityRefCollection {
  #refs: EntityRef[] | undefined;
  #drained = false;

  constructor(private readonly source: EntityRefCollection) {}

  /** The refs collected so far, without consuming them. */
  snapshot(): readonly EntityRef[] {
    this.#refs ??= this.source.drain();
    return this.#refs;
  }

  drain(): EntityRef[] {
    if (this.#drained) return [];
    this.#drained = true;
    return [...this.snapshot()];
  }
}

/** Shares a bus collection between the run trace and the session log. */
export function shareEntityRefs(
  source: EntityRefCollection | undefined,
): SharedEntityRefs | undefined {
  return source === undefined ? undefined : new SharedEntityRefs(source);
}

/** What the verifier reads about a finished turn beside its trace payload. */
export interface TurnEvidence {
  readonly turnId?: string;
  readonly entityRefs: readonly EntityRef[];
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

  /**
   * `output` — the result text the model received. For a
   * `query_knowledge_graph` call it supplies the turn's citable source ids
   * ({@link noteKnowledgeGraphOutput}); other tools' output is not kept.
   */
  recordOrchestratorToolCall(
    call: Omit<RunToolCall, 'agentContext'>,
    output?: string,
  ): void {
    if (call.toolName === KNOWLEDGE_GRAPH_TOOL_NAME && output !== undefined) {
      this.noteKnowledgeGraphOutput(output);
    }
    this.orchestratorToolCalls.push({
      ...call,
      agentContext: 'orchestrator',
    });
  }

  /**
   * Keeps the source ids a knowledge-graph result showed the model — the ids
   * a `[ref:…]` marker in the answer may name ({@link knowledgeGraphRefsOf}).
   * A replayed result passes through here exactly like an executed one.
   */
  noteKnowledgeGraphOutput(output: string): void {
    this.knowledgeGraphOutputSeen = true;
    for (const ref of knowledgeGraphRefsIn(output)) this.knowledgeGraphRefs.add(ref);
  }

  private knowledgeGraphOutputSeen = false;
  private readonly knowledgeGraphRefs = new Set<string>();

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
        if (meta?.name === KNOWLEDGE_GRAPH_TOOL_NAME) this.noteKnowledgeGraphOutput(ev.output);
        subToolCalls.push({
          callId: ev.id,
          toolName: meta?.name ?? 'unknown',
          durationMs: ev.durationMs,
          isError: ev.isError,
          agentContext: agentName,
          ...(ev.postcondition ? { postcondition: ev.postcondition } : {}),
          ...(ev.replayed === true ? { replayed: true } : {}),
        });
        toolCallStarts.delete(ev.id);
      },
    };

    return {
      agentName,
      index,
      observer,
      finish({ durationMs, status, replayed }): void {
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
          ...(replayed === true ? { replayed: true } : {}),
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
    if (this.knowledgeGraphOutputSeen) {
      KNOWLEDGE_GRAPH_REFS.set(payload, [...this.knowledgeGraphRefs].sort());
    }
    TURN_EVIDENCE.set(payload, {
      ...(this.opts.turnId !== undefined ? { turnId: this.opts.turnId } : {}),
      entityRefs: this.opts.entityRefs?.snapshot() ?? [],
    });
    return payload;
  }
}

/**
 * The citable ids per finished trace, held BESIDE the payload rather than on
 * it: the payload goes out on the stream's `done`, into routine runs and to
 * `ingestRun`, and these ids are verifier input for this turn only. Keyed by
 * the payload object, so they live exactly as long as the trace does.
 */
const KNOWLEDGE_GRAPH_REFS = new WeakMap<RunTracePayload, readonly string[]>();

/**
 * The source ids this trace's `query_knowledge_graph` results showed the
 * model (`id` / `turnId`), sorted — what a `[ref:…]` marker in the answer may
 * name. Undefined when the turn made no graph call (or the trace was not
 * built by a collector); empty when the graph returned nothing citable.
 */
export function knowledgeGraphRefsOf(trace: RunTracePayload): readonly string[] | undefined {
  return KNOWLEDGE_GRAPH_REFS.get(trace);
}

/**
 * #1571 / #1574 — the turn id and the records the turn's tools read, per
 * finished trace, held BESIDE the payload like the knowledge-graph refs: they
 * are verifier input for this turn only and must not ride the stream's
 * `done`, routine runs or `ingestRun`.
 */
const TURN_EVIDENCE = new WeakMap<RunTracePayload, TurnEvidence>();

/** The turn id and read records of a trace built by a collector, else
 *  undefined. */
export function turnEvidenceOf(trace: RunTracePayload): TurnEvidence | undefined {
  return TURN_EVIDENCE.get(trace);
}
