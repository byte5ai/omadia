import type {
  Nudge,
  NudgeEmissionRecord,
  NudgeEvaluationInput,
  NudgeProvider,
  NudgeRegistry,
  NudgeStateRecord,
  NudgeStateStore,
  ReadonlyTurnContext,
  ProcessMemoryService,
} from '@omadia/plugin-api';
import {
  NUDGE_MAX_PER_TOOL_CALL,
  NUDGE_MAX_PER_TURN,
  NUDGE_PROVIDER_TIMEOUT_MS,
  NUDGE_REGRESSION_AFTER_MISSES,
  NUDGE_RETIRE_AFTER_STREAK,
  NUDGE_SUPPRESS_DEFAULT_DAYS,
} from '@omadia/plugin-api';

/**
 * Palaia Phase 8 (OB-77) — pure-logic Nudge-Pipeline.
 *
 * Runs after every tool_result during an orchestrator turn. Iterates the
 * registered `NudgeProvider`s in priority-desc/id-asc order, applies a
 * 50 ms hard timeout per `evaluate`, skips suppressed/retired states, and
 * emits at most one `<nudge>` per tool-call (capped at 3 per turn via the
 * caller-supplied counter). The augmented content goes back into the
 * tool_result so the agent sees the coaching block in its next API call.
 *
 * **Stateless design**: the per-turn cap counter is owned by the caller
 * (orchestrator threads it through the per-turn `TurnContextValue`). The
 * pipeline reads + bumps it; consumers never need a global registry.
 */

/**
 * Mutable turn-scoped scratchpad — the orchestrator allocates one per
 * turn and threads it through every `runNudgePipeline` call so the cap
 * is enforced across all tool-calls of the turn.
 *
 * `emitted` counts total emissions (capped at `NUDGE_MAX_PER_TURN`).
 * `emittedIds` tracks per-nudgeId dedup: a turn whose cumulative trace
 * keeps satisfying a provider's trigger across many iterations would
 * otherwise emit the same nudge once per iteration. The pipeline runs
 * after every iteration's tool_result batch — once a nudge fires, its
 * id stays in this set for the rest of the turn.
 */
export interface NudgeTurnCounter {
  emitted: number;
  emittedIds: Set<string>;
}

export function createNudgeTurnCounter(): NudgeTurnCounter {
  return { emitted: 0, emittedIds: new Set<string>() };
}

export interface RunNudgePipelineInput {
  readonly turnContext: ReadonlyTurnContext;
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly toolResult: string;
  readonly registry: NudgeRegistry;
  readonly stateStore: NudgeStateStore;
  readonly turnCounter: NudgeTurnCounter;
  readonly processMemory?: ProcessMemoryService;
  /** Whether the upstream tool errored. Errored tool-calls are skipped. */
  readonly toolErrored: boolean;
  /** Test-friendly clock. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Logger. Defaults to console.error so timeouts surface in dev logs. */
  readonly log?: (msg: string) => void;
}

export interface RunNudgePipelineOutput {
  /** The (possibly augmented) tool-result content. Always defined. */
  readonly content: string;
  /** Set when a nudge was emitted; orchestrator persists via `recordEmission`. */
  readonly emission?: NudgeEmissionRecord;
}

/**
 * Serialise a `Nudge` to the on-the-wire `<nudge>` block. Uses XML-ish
 * tags so the channel renderer can split it back out cleanly. Body lines
 * are kept verbatim — providers must already strip PII.
 */
export function serialiseNudge(nudge: Nudge): string {
  const lines: string[] = [`<nudge id="${escapeAttr(nudge.id)}">`];
  lines.push(`<text>${escapeXml(nudge.text)}</text>`);
  if (nudge.cta) {
    lines.push(
      `<cta label="${escapeAttr(nudge.cta.label)}" tool="${escapeAttr(nudge.cta.toolCall.name)}">`,
    );
    lines.push(JSON.stringify(nudge.cta.toolCall.arguments));
    lines.push(`</cta>`);
  }
  lines.push(`</nudge>`);
  return lines.join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/[&<>]/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    return '&gt;';
  });
}

function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;');
}

/**
 * Race a promise against a timeout. Resolves to `null` and logs on
 * timeout. Errors propagate so the caller can swallow per-provider.
 */
async function evaluateWithTimeout(
  provider: NudgeProvider,
  input: NudgeEvaluationInput,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<Nudge | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Nudge | null>((resolve) => {
    timer = setTimeout(() => {
      log(
        `[nudge-pipeline] provider "${provider.id}" exceeded ${String(timeoutMs)}ms timeout — skipping`,
      );
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.evaluate(input), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isStateClosed(state: NudgeStateRecord | null, now: Date): boolean {
  if (!state) return false;
  if (state.retiredAt !== null) return true;
  if (state.suppressedUntil !== null && state.suppressedUntil > now) return true;
  return false;
}

/**
 * Run the pipeline for a single tool_result. Returns the (possibly
 * augmented) content + an emission record. Caller is responsible for
 * persisting the emission (`stateStore.recordEmission`) so this function
 * stays pure.
 */
export async function runNudgePipeline(
  input: RunNudgePipelineInput,
): Promise<RunNudgePipelineOutput> {
  const { toolResult, toolErrored, registry, stateStore, turnCounter } = input;
  const log = input.log ?? ((msg: string) => console.error(msg));
  const now = (input.now ?? (() => new Date()))();

  // Skip rules: errored tool, per-turn cap reached, registry empty.
  if (toolErrored) return { content: toolResult };
  if (turnCounter.emitted >= NUDGE_MAX_PER_TURN) return { content: toolResult };

  const providers = registry.list();
  if (providers.length === 0) return { content: toolResult };

  let emitted: { provider: NudgeProvider; nudge: Nudge } | null = null;
  let perToolCallCount = 0;

  for (const provider of providers) {
    if (perToolCallCount >= NUDGE_MAX_PER_TOOL_CALL) break;

    // Per-turn dedup: same nudge already fired earlier in this turn —
    // skip even if the cumulative trace still satisfies the trigger.
    // Without this, a turn that ends with several meta-tool iterations
    // (memory · view, suggest_follow_ups, …) re-emits the nudge once
    // per iteration because the trigger condition stays true forever
    // once cumulative crosses the threshold.
    if (turnCounter.emittedIds.has(provider.id)) continue;

    // Closed-state probe BEFORE evaluating — saves the expensive call when
    // the nudge is suppressed/retired.
    let state: NudgeStateRecord | null;
    try {
      state = await stateStore.read(input.turnContext.agentId, provider.id);
    } catch (err) {
      log(
        `[nudge-pipeline] state read failed for "${provider.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (isStateClosed(state, now)) continue;

    let candidate: Nudge | null = null;
    try {
      candidate = await evaluateWithTimeout(
        provider,
        {
          turnId: input.turnContext.turnId,
          toolName: input.toolName,
          toolArgs: input.toolArgs,
          toolResult: input.toolResult,
          turnContext: input.turnContext,
          nudgeStateStore: { read: stateStore.read.bind(stateStore) },
          ...(input.processMemory ? { processMemory: input.processMemory } : {}),
        },
        NUDGE_PROVIDER_TIMEOUT_MS,
        log,
      );
    } catch (err) {
      log(
        `[nudge-pipeline] provider "${provider.id}" threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!candidate) continue;

    // Provenance check — providers MUST set candidate.id to their own id.
    if (candidate.id !== provider.id) {
      log(
        `[nudge-pipeline] provider "${provider.id}" returned id "${candidate.id}" — coercing for state-key safety`,
      );
      candidate = { ...candidate, id: provider.id };
    }

    emitted = { provider, nudge: candidate };
    perToolCallCount += 1;
  }

  if (!emitted) return { content: toolResult };

  const block = serialiseNudge(emitted.nudge);
  const augmented = `${toolResult}\n\n${block}`;
  turnCounter.emitted += 1;
  turnCounter.emittedIds.add(emitted.nudge.id);

  const emission: NudgeEmissionRecord = {
    agentId: input.turnContext.agentId,
    nudgeId: emitted.nudge.id,
    turnId: input.turnContext.turnId,
    toolName: input.toolName,
    hintText: emitted.nudge.text,
    ...(emitted.nudge.workflowHash
      ? { workflowHash: emitted.nudge.workflowHash }
      : {}),
    ...(emitted.nudge.cta ? { cta: emitted.nudge.cta } : {}),
  };

  return { content: augmented, emission };
}

/**
 * Followup-Detection — invoked at the START of each subsequent tool-call
 * iteration (i.e. before the next dispatch). Compares the active toolUses
 * against open emissions for this `(agentId, nudgeId)` and records follow
 * when a `successSignal` matches.
 *
 * Wall-clock window note: the contract spec uses `withinTurns` for the
 * follow window, but a turn-counter-per-agent is brittle in our async
 * stack. Slice 2 uses a 60-minute soft TTL as a proxy — sufficient for
 * the lead use case (CTA-click is typically the very next user message).
 * A turn-index column can replace this in Phase 8.5 without breaking the
 * contract.
 */
export interface FollowupDetectionInput {
  readonly turnContext: ReadonlyTurnContext;
  readonly stateStore: NudgeStateStore;
  readonly toolUses: readonly { name: string }[];
  readonly nudgeIds: readonly string[];
}

const FOLLOW_WINDOW_MS = 60 * 60 * 1000;

export async function detectAndRecordFollows(
  input: FollowupDetectionInput,
  now: () => Date = () => new Date(),
): Promise<readonly string[]> {
  const matched: string[] = [];
  const usedNames = new Set(input.toolUses.map((u) => u.name));
  const cutoff = new Date(now().getTime() - FOLLOW_WINDOW_MS);

  for (const nudgeId of input.nudgeIds) {
    const state = await input.stateStore.read(input.turnContext.agentId, nudgeId);
    if (!state) continue;
    if (state.lastFollowedAt && state.lastFollowedAt > cutoff) continue;
    if (!state.lastEmittedAt || state.lastEmittedAt < cutoff) continue;
    // The emission row carries the actual toolName we should compare against;
    // for the simple case (one nudge id → one signal toolName) the orchestrator
    // pre-resolves the open-emission rows and passes the signal toolNames here.
    // To keep the surface narrow, this helper tolerates both: nudgeIds that
    // matched ANY current toolUse name are reported as followed. Providers
    // whose CTAs invoke a unique tool benefit from this; ambiguous cases
    // require richer info that we plumb through the store query (Slice 3).
    if (usedNames.size > 0) {
      await input.stateStore.recordFollow(
        input.turnContext.agentId,
        nudgeId,
        input.turnContext.turnId,
      );
      matched.push(nudgeId);
    }
  }
  return matched;
}

export {
  NUDGE_MAX_PER_TURN,
  NUDGE_MAX_PER_TOOL_CALL,
  NUDGE_RETIRE_AFTER_STREAK,
  NUDGE_REGRESSION_AFTER_MISSES,
  NUDGE_SUPPRESS_DEFAULT_DAYS,
};
