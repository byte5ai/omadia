import type { FactExtractor } from '@omadia/orchestrator-extras';
import type { EntityRef } from '@omadia/plugin-api';

import type { WrittenTurn } from './requestTurnRecord.js';
import type { SessionLogEntry, SessionLogger } from './sessionLogger.js';
import type { ToolReplayLedger } from './toolReplayLedger.js';
import { turnContext } from './turnContext.js';

/** One pass's session-log row before the entities are attached: a deferred
 *  row gets the entities of every pass of the request (`requestTurnRecord.ts`). */
export interface TurnRow {
  readonly entry: Omit<SessionLogEntry, 'entityRefs'>;
  readonly entityRefs: EntityRef[];
}

/** The fact-extraction prompt over a row (#361: masked wire variants, plus
 *  the restorer that turns extracted facts back into real values). */
export interface TurnFacts {
  readonly userMessage: string;
  readonly assistantAnswer: string;
  readonly restoreFacts?: (text: string) => string;
}

/** What follows a deferred row once it is written (fact extraction,
 *  auto-promotion); resolves to what the stream releases with the answer. */
export type AfterRow = (
  turnId: string | undefined,
  entityRefs: EntityRef[],
) => Promise<Omit<WrittenTurn, 'turnId'>>;

export interface TurnRecordWriterDeps {
  readonly sessionLogger: SessionLogger | undefined;
  readonly factExtractor: FactExtractor | undefined;
}

/**
 * How the orchestrator writes a turn's record — its session-log row and the
 * fact extraction over it: now, or, while a verifier may re-enter the
 * request, as an offer to the request's record, which the verifier commits
 * for the pass it delivers (commit-on-delivery, `requestTurnRecord.ts`).
 * Every write is best-effort, as at every site before: a failing log is
 * reported and the turn goes on.
 */
export class TurnRecordWriter {
  constructor(private readonly deps: TurnRecordWriterDeps) {}

  /**
   * The request ledger while this pass defers its record to the verifier:
   * the pass offers its row and notes its `onAfterTurn` answer instead of
   * writing them. Undefined when the turn writes its record itself (no
   * verifier bound a ledger to the request).
   */
  deferringLedger(): ToolReplayLedger | undefined {
    const ledger = turnContext.current()?.toolReplayLedger;
    return ledger?.defersTurnRecord === true ? ledger : undefined;
  }

  /** One session-log row now; resolves to its Turn id, or undefined when
   *  there is no logger or the log failed (reported with `what`). */
  async writeRow(entry: SessionLogEntry, what: string): Promise<string | undefined> {
    const logger = this.deps.sessionLogger;
    if (!logger) return undefined;
    try {
      return (await logger.log(entry)).turnExternalId;
    } catch (err) {
      console.error(
        `[orchestrator] session log failed (continuing with ${what}):`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  /**
   * Offers this pass's row to the request's record: written — with the
   * entities of every pass — only when the verifier commits this pass, and
   * `after` follows the write.
   */
  offerRow(
    ledger: ToolReplayLedger,
    row: TurnRow,
    what: string,
    after?: AfterRow,
  ): void {
    ledger.turnRecord.offer(ledger.pass, {
      entityRefs: row.entityRefs,
      write: async (entityRefs) => {
        const turnId = await this.writeRow({ ...row.entry, entityRefs }, what);
        const rest = after ? await after(turnId, entityRefs) : {};
        return { ...(turnId !== undefined ? { turnId } : {}), ...rest };
      },
    });
  }

  /** Writes this pass's row now and resolves to its Turn id — or offers it
   *  to the request's record ({@link deferringLedger}) and resolves to
   *  undefined. */
  async recordRow(row: TurnRow, what: string): Promise<string | undefined> {
    const ledger = this.deferringLedger();
    if (ledger === undefined) return this.writeRow({ ...row.entry, entityRefs: row.entityRefs }, what);
    this.offerRow(ledger, row, what);
    return undefined;
  }

  /** Fact extraction over a written row: fire-and-forget, never awaited. */
  startFactExtraction(
    turnId: string | undefined,
    facts: TurnFacts | undefined,
    entityRefs: readonly EntityRef[],
  ): void {
    const extractor = this.deps.factExtractor;
    if (!extractor || turnId === undefined || facts === undefined) return;
    void extractor.extractAndIngest({ turnId, ...facts, entityRefs });
  }
}
