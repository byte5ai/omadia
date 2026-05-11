/**
 * `sessionBriefing@1` — capability contract für Session-Continuity
 * (Palaia Phase 6 / OB-75).
 *
 * Konsumenten (BuilderAgent, opt-in Plugin-Agents) rufen
 * `loadSessionBriefing({ scope, ... })` und kriegen einen
 * Markdown-Block, der als ERSTER System-Prompt-Block injiziert wird.
 * Zwei Modi:
 *   - **Resume** (newest non-summary turn < `resumeWindowMinutes` alt):
 *     Tail-Stream der letzten N Turns als Recap.
 *   - **Briefing** (älter): kurze Bullet-Summary + offene Tasks.
 *
 * Lazy-on-demand: wenn keine frische Summary für die Session
 * vorliegt, wird HEUTE erst der Haiku-Call ausgelöst und das
 * Ergebnis als Turn mit `userMessage = '<session-summary>'`
 * persistiert. Side-Effect: ein Briefing-Load auf einer aktiven
 * Session kann ~1s dauern. Acceptable für Builder-Bootstrap.
 *
 * Token-Budget: das Briefing respektiert das übergebene
 * `budgetTokens` über die Phase-5 `assembleForBudget`-Pipeline.
 */

export const SESSION_BRIEFING_SERVICE_NAME = 'sessionBriefing';
export const SESSION_BRIEFING_CAPABILITY = 'sessionBriefing@1';

export interface LoadSessionBriefingInput {
  /** Session-Scope, für die das Briefing gebaut wird. */
  scope: string;
  /** Optional — liefert open-task-Filter scope-übergreifend für den User. */
  userId?: string;
  /** Wer fragt — für agent_priorities-Lookup im Token-Budget-Assembler. */
  agentId: string;
  /** Token-Budget für das gerenderte Briefing. Default: ContextRetriever-Default. */
  budgetTokens?: number;
}

export type BriefingMode = 'resume' | 'briefing' | 'empty';

export interface SessionBriefingResult {
  /** Final-rendered Markdown-Block. Leerer String wenn nichts zu sagen ist. */
  text: string;
  mode: BriefingMode;
  /** Strukturierter Audit-Trail. */
  stats: {
    /** Anzahl der Turns die in den Resume-Tail eingegangen sind. */
    resumeTurns: number;
    /** Vorhanden eine frische Summary? */
    summaryFound: boolean;
    /** Wurde HEUTE eine neue Summary generiert (LLM-Call)? */
    summaryRegenerated: boolean;
    /** Anzahl offener Tasks die ins Briefing eingeflossen sind. */
    openTasks: number;
    /** Geschätzt verbrauchte Tokens (chars / charsPerToken). */
    tokensUsed: number;
  };
}

/**
 * Service-Surface, die ein `sessionBriefing@1`-Provider published.
 * Der Provider lebt in `harness-orchestrator-extras` (braucht
 * KnowledgeGraph + ContextRetriever + SessionSummaryGenerator);
 * Konsumenten ziehen ihn via `ctx.services.get<SessionBriefingService>('sessionBriefing')`.
 */
export interface SessionBriefingService {
  loadSessionBriefing(
    input: LoadSessionBriefingInput,
  ): Promise<SessionBriefingResult>;
}
