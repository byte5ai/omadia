import type {
  ChatStreamEvent,
  RunToolCall,
  RunTracePayload,
} from '@omadia/channel-sdk';
import type { PalaiaExcerpt } from '@omadia/plugin-api';

import { OMADIA_MCP_TOOL_PREFIX } from './cliSpawnGate.js';

/**
 * #1391 — a subscription-CLI turn that finished successfully, in the shape the
 * orchestrator's turn persistence needs (session log row, run trace).
 */
export interface CliCompletedTurn {
  /** The CLI turn's id — the same one its cost-ledger row carries (#1098). */
  readonly turnId: string;
  readonly answer: string;
  readonly toolCalls: number;
  readonly iterations: number;
  readonly runTrace: RunTracePayload;
}

/**
 * #1391 — what persisting a CLI turn produced, for the `done` event: the
 * written Turn's id, the save-as-memory excerpt and the auto-promoted
 * MemorableKnowledge id, plus annotation events (KG-insert pulse,
 * `onAfterTurn` hooks) that go out just before `done`, as on the in-process
 * path. Every field is optional: a host without a session logger records
 * nothing and the turn is released unchanged.
 */
export interface CliTurnRecord {
  readonly turnId?: string;
  readonly palaiaExcerpt?: PalaiaExcerpt;
  readonly autoPromotedMkId?: string;
  readonly events?: readonly ChatStreamEvent[];
}

interface PendingToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: number;
  durationMs?: number;
  isError?: boolean;
}

/**
 * Collects the tool calls of one CLI turn from its stream events into a
 * {@link RunTracePayload}, so the session logger writes `Run` and `ToolCall`
 * nodes for them the way it does for an in-process turn.
 *
 * The CLI owns its own loop, so the calls are seen only as the `tool_use` /
 * `tool_result` events it streams. Every call is top-level from the trace's
 * point of view (`agentContext: 'orchestrator'`); a sub-agent the CLI reached
 * over the loopback bridge shows up as the `ask_<slug>` call it was.
 */
export class CliToolTrace {
  private readonly calls = new Map<string, PendingToolCall>();

  private readonly startedAt: number;

  public constructor(private readonly now: () => number = () => Date.now()) {
    this.startedAt = now();
  }

  public observe(event: ChatStreamEvent): void {
    if (event.type === 'tool_use') {
      if (this.calls.has(event.id)) return;
      this.calls.set(event.id, {
        callId: event.id,
        toolName: event.name.startsWith(OMADIA_MCP_TOOL_PREFIX)
          ? event.name.slice(OMADIA_MCP_TOOL_PREFIX.length)
          : event.name,
        startedAt: this.now(),
      });
      return;
    }
    if (event.type === 'tool_result') {
      const call = this.calls.get(event.id);
      if (call === undefined) return;
      call.durationMs = event.durationMs;
      call.isError = event.isError === true;
    }
  }

  public finish(meta: {
    readonly scope: string;
    readonly userId?: string;
    readonly iterations: number;
    readonly model: string;
  }): RunTracePayload {
    const finishedAt = this.now();
    const orchestratorToolCalls: RunToolCall[] = [...this.calls.values()].map((call) => ({
      callId: call.callId,
      toolName: call.toolName,
      // A call whose result never streamed back ran until the turn ended.
      durationMs: call.durationMs ?? Math.max(0, finishedAt - call.startedAt),
      isError: call.isError ?? false,
      agentContext: 'orchestrator',
    }));
    return {
      scope: meta.scope,
      ...(meta.userId !== undefined ? { userId: meta.userId } : {}),
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: Math.max(0, finishedAt - this.startedAt),
      status: 'success',
      iterations: meta.iterations,
      orchestratorToolCalls,
      agentInvocations: [],
      model: meta.model,
      provider: 'claude-cli',
    };
  }
}

/**
 * #1391 — what the graph recalled for a CLI turn before it spawns: the context
 * text for the system prompt, and the `kg_recall` / `kg_graph` annotation
 * events the in-process path streams before its answer.
 */
export interface CliRecalledContext {
  readonly text?: string;
  readonly events?: readonly ChatStreamEvent[];
}
