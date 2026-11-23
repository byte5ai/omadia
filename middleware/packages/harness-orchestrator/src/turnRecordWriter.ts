import { AsyncResource } from 'node:async_hooks';

import type { FactExtractor } from '@omadia/orchestrator-extras';
import type { CaptureDisclosure, EntityRef } from '@omadia/plugin-api';


import { currentAnswerRecordGate } from './identityGuard/answerRecordGate.js';
import type { WrittenTurn } from './requestTurnRecord.js';
import type { SessionLogEntry, SessionLogger } from './sessionLogger.js';
import type { ToolReplayLedger } from './toolReplayLedger.js';
import { turnContext } from './turnContext.js';
import type { DiscretionTurnState } from './discretion/turnLabels.js';

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

/** Bounds {@link TurnRecordWriter}'s pending disclosures: a non-streaming turn
 *  writes a row but has no `done` to take its disclosure. */
const PENDING_DISCLOSURES_CAP = 256;

export interface TurnRecordWriterDeps {
  readonly sessionLogger: SessionLogger | undefined;
  readonly factExtractor: FactExtractor | undefined;
  /**
   * Spec 2042 §5.11 — called once a row is written, with the discretion state
   * of the turn that produced it: the turn keeps its label set. Errors are
   * logged; a failed label write never fails the turn. Known gap: a later
   * recall of such an unlabelled turn adds no labels (documented residual).
   */
  readonly onTurnWritten?: (turnId: string, discretion: DiscretionTurnState | undefined) => Promise<void>;
  /**
   * Spec 2042 §5.11 — the row as it may be kept: an answer refused at the
   * people egress is stored without its text (`withoutAnswer`), so neither it
   * nor the line that replaced it can be recalled later (the line is the
   * channel's notice, not something the agent said). Identity when nothing is
   * refused.
   */
  readonly beforeTurnWritten?: (
    entry: SessionLogEntry,
    discretion: DiscretionTurnState | undefined,
  ) => Promise<SessionLogEntry>;
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
  /** What the capture filter decided for a written row, until the `done`
   *  carrying its Turn id takes it. A dozen sites write rows and hand back a
   *  bare id, so the disclosure waits here instead of riding each of them. */
  readonly #pendingDisclosures = new Map<string, CaptureDisclosure>();

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
  async writeRow(
    entry: SessionLogEntry,
    what: string,
    discretion: DiscretionTurnState | undefined = turnContext.current()?.discretion,
  ): Promise<string | undefined> {
    const logger = this.deps.sessionLogger;
    if (!logger) return undefined;
    try {
      const kept = this.deps.beforeTurnWritten ? await this.deps.beforeTurnWritten(entry, discretion) : entry;
      const { turnExternalId, captureDisclosure } = await logger.log(kept);
      this.amendOnVerdict(logger, turnExternalId, what);
      if (captureDisclosure) this.noteDisclosure(turnExternalId, captureDisclosure);
      await this.deps.onTurnWritten?.(turnExternalId, discretion).catch((err: unknown) => {
        console.error(
          `[discretion] label write failed for turn ${turnExternalId}:`,
          err instanceof Error ? err.message : err,
        );
      });
      return turnExternalId;
    } catch (err) {
      console.error(
        `[orchestrator] session log failed (continuing with ${what}):`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  /**
   * Spec 2042 — inside an agent turn the identity guard decides after the row
   * is written (it wraps the agent from outside). The row is amended once it
   * has: it gets the verdict, and a withheld answer loses its text, so no later
   * turn recalls the draft. Outside a guarded turn nothing happens.
   */
  private amendOnVerdict(logger: SessionLogger, turnExternalId: string, what: string): void {
    currentAnswerRecordGate()?.recorded(async (verdict) => {
      if (verdict.kept && verdict.guard === undefined) return;
      if (!verdict.kept) {
        console.log(`[orchestrator] ${what}: the withheld answer is kept out of the agent's memory`);
      }
      await logger.amendTurn(turnExternalId, {
        ...(verdict.guard ? { identityGuard: verdict.guard } : {}),
        ...(verdict.kept ? {} : { withholdAnswer: true }),
      });
    });
  }

  /** The capture disclosure of a written row, once: the `done` that takes it
   *  is the only reader. */
  takeCaptureDisclosure(turnId: string | undefined): CaptureDisclosure | undefined {
    if (turnId === undefined) return undefined;
    const disclosure = this.#pendingDisclosures.get(turnId);
    this.#pendingDisclosures.delete(turnId);
    return disclosure;
  }

  private noteDisclosure(turnId: string, disclosure: CaptureDisclosure): void {
    if (this.#pendingDisclosures.size >= PENDING_DISCLOSURES_CAP) {
      const oldest = this.#pendingDisclosures.keys().next().value;
      if (oldest !== undefined) this.#pendingDisclosures.delete(oldest);
    }
    this.#pendingDisclosures.set(turnId, disclosure);
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
    // The write may run later, in the verifier's scope: keep this pass's labels.
    const discretion = turnContext.current()?.discretion;
    ledger.turnRecord.offer(ledger.pass, {
      entityRefs: row.entityRefs,
      write: async (entityRefs) => {
        const turnId = await this.writeRow({ ...row.entry, entityRefs }, what, discretion);
        const captureDisclosure = this.takeCaptureDisclosure(turnId);
        const rest = after ? await after(turnId, entityRefs) : {};
        return {
          ...(turnId !== undefined ? { turnId } : {}),
          ...(captureDisclosure ? { captureDisclosure } : {}),
          ...rest,
        };
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
    const extract = (): void => void extractor.extractAndIngest({ turnId, ...facts, entityRefs });
    // Spec 2042 — facts are learned only from an answer the identity guard kept.
    const gate = currentAnswerRecordGate();
    // Bound to this turn's async context (turn context, execution context of
    // the model gateway, cost attribution): it may run from the guard's.
    if (gate) gate.whenKept(AsyncResource.bind(extract));
    else extract();
  }
}
