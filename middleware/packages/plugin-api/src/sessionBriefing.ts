/**
 * `sessionBriefing@1` — capability contract for session continuity
 * (Palaia Phase 6 / OB-75).
 *
 * Consumers (BuilderAgent, opt-in plugin agents) call
 * `loadSessionBriefing({ scope, ... })` and get a Markdown block
 * that is injected as the FIRST system-prompt block. Two modes:
 *   - **Resume** (newest non-summary turn < `resumeWindowMinutes` old):
 *     tail-stream of the last N turns as a recap.
 *   - **Briefing** (older): short bullet summary + open tasks.
 *
 * Lazy-on-demand: if no fresh summary is present for the session,
 * the Haiku call is triggered TODAY and the result is persisted
 * as a turn with `userMessage = '<session-summary>'`. Side effect:
 * a briefing load on an active session can take ~1s. Acceptable
 * for Builder bootstrap.
 *
 * Token budget: the briefing respects the passed `budgetTokens`
 * via the Phase-5 `assembleForBudget` pipeline.
 */

export const SESSION_BRIEFING_SERVICE_NAME = 'sessionBriefing';
export const SESSION_BRIEFING_CAPABILITY = 'sessionBriefing@1';

export interface LoadSessionBriefingInput {
  /** Session scope for which the briefing is built. */
  scope: string;
  /** Optional — drives the open-task filter scope-agnostically for the user. */
  userId?: string;
  /** Who is asking — for the agent_priorities lookup in the Token-Budget-Assembler. */
  agentId: string;
  /** Token budget for the rendered briefing. Default: ContextRetriever-Default. */
  budgetTokens?: number;
}

export type BriefingMode = 'resume' | 'briefing' | 'empty';

export interface SessionBriefingResult {
  /** Final-rendered Markdown block. Empty string when there is nothing to say. */
  text: string;
  mode: BriefingMode;
  /** Structured audit trail. */
  stats: {
    /** Number of turns that went into the Resume-Tail. */
    resumeTurns: number;
    /** Is a fresh summary present? */
    summaryFound: boolean;
    /** Was a new summary generated TODAY (LLM call)? */
    summaryRegenerated: boolean;
    /** Number of open tasks that flowed into the briefing. */
    openTasks: number;
    /** Estimated consumed tokens (chars / charsPerToken). */
    tokensUsed: number;
  };
}

/**
 * Service surface that a `sessionBriefing@1` provider publishes.
 * The provider lives in `harness-orchestrator-extras` (needs
 * KnowledgeGraph + ContextRetriever + SessionSummaryGenerator);
 * consumers pull it via `ctx.services.get<SessionBriefingService>('sessionBriefing')`.
 */
export interface SessionBriefingService {
  loadSessionBriefing(
    input: LoadSessionBriefingInput,
  ): Promise<SessionBriefingResult>;
}
