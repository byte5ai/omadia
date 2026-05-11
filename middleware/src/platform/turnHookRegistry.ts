/**
 * Turn-Hook registry.
 *
 * Extension points that fire during an Orchestrator chat turn:
 *   - `onBeforeTurn`      — before the first LLM inference (consumer e.g.
 *                           future @omadia/knowledge-graph ContextRetriever)
 *   - `onAfterToolCall`   — after each tool invocation in the tool loop
 *                           (currently no planned consumer; reserved for
 *                           observability plugins)
 *   - `onAfterTurn`       — after the turn has produced its final answer
 *                           (consumer e.g. future @omadia/knowledge-graph
 *                           FactExtractor, Verifier-equivalent side-channels)
 *
 * v1 (this file): registry exists, hook-points are wired into the Orchestrator,
 * but no extension plugin registers yet. The built-ins (ContextRetriever,
 * FactExtractor) still run as direct Orchestrator-owned steps; the migration
 * to TurnHook-based invocation happens in Phase 4 when KG is extracted.
 *
 * Error-handling contract: a thrown hook does NOT abort the turn. The error
 * is logged and the remaining hooks continue. Turn-critical logic stays in
 * the Orchestrator itself — hooks are side-channel observers, not gatekeepers.
 */

export type TurnHookPoint = 'onBeforeTurn' | 'onAfterToolCall' | 'onAfterTurn';

/** Opaque turn-context. Shape evolves with the registry's consumers; for v1
 *  we keep it narrow — `turnId` is enough for correlation, everything else
 *  is passed through the existing EntityRefBus / RunTraceCollector plumbing. */
export interface TurnHookContext {
  readonly turnId: string;
  readonly sessionScope?: string;
  readonly userId?: string;
}

export interface TurnHookPayload {
  readonly userMessage?: string;
  readonly assistantAnswer?: string;
  readonly toolName?: string;
  readonly toolResult?: string;
}

export type TurnHook = (
  ctx: TurnHookContext,
  payload: TurnHookPayload,
) => void | Promise<void>;

interface HookEntry {
  readonly hook: TurnHook;
  /** Lower priority runs first. Default 0. Ties break by registration order. */
  readonly priority: number;
  /** Diagnostic label — shown in log output when the hook throws. */
  readonly label: string;
}

export interface TurnHookRegistration {
  readonly hook: TurnHook;
  readonly priority?: number;
  readonly label: string;
}

export class TurnHookRegistry {
  private readonly byPoint = new Map<TurnHookPoint, HookEntry[]>();

  constructor(
    private readonly log: (msg: string, err: unknown) => void = (msg, err) => {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`${msg}: ${detail}`);
    },
  ) {}

  register(point: TurnHookPoint, reg: TurnHookRegistration): () => void {
    const entry: HookEntry = {
      hook: reg.hook,
      priority: reg.priority ?? 0,
      label: reg.label,
    };
    const list = this.byPoint.get(point) ?? [];
    list.push(entry);
    list.sort((a, b) => a.priority - b.priority);
    this.byPoint.set(point, list);
    return () => {
      const current = this.byPoint.get(point);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  async run(
    point: TurnHookPoint,
    ctx: TurnHookContext,
    payload: TurnHookPayload,
  ): Promise<void> {
    const list = this.byPoint.get(point);
    if (!list || list.length === 0) return;
    for (const entry of list) {
      try {
        await entry.hook(ctx, payload);
      } catch (err) {
        this.log(`[turn-hook] ${point}/${entry.label} threw`, err);
      }
    }
  }

  /** Diagnostic: how many hooks at each point. Used by the introspection route
   *  in Phase 0b. */
  counts(): Record<TurnHookPoint, number> {
    return {
      onBeforeTurn: this.byPoint.get('onBeforeTurn')?.length ?? 0,
      onAfterToolCall: this.byPoint.get('onAfterToolCall')?.length ?? 0,
      onAfterTurn: this.byPoint.get('onAfterTurn')?.length ?? 0,
    };
  }
}
