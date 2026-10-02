import { AsyncLocalStorage } from 'node:async_hooks';

import type { ChatStreamEvent } from '@omadia/channel-sdk';
import type { EntityRef } from '@omadia/plugin-api';

/**
 * The recorded turn of ONE user request that ran in several passes —
 * commit-on-delivery.
 *
 * A request the answer verifier may re-enter runs one pass per attempt: the
 * first run, a borderline resample, a correction retry. The user gets ONE
 * answer, so the request records one turn: the session-log row (and with it
 * the Knowledge-Graph turn and the next turn's verbatim context), the fact
 * extraction over it, an auto-promoted memory and `onAfterTurn`. That record
 * must hold the answer the user got. A pass cannot know that when it ends —
 * the verdict comes after it — so a pass whose ledger defers its record
 * (`ToolReplayLedger.defersTurnRecord`) writes nothing: it offers its row
 * here, and the verifier commits the row of the pass it delivers, or, when it
 * withholds the answer, of the pass its final verdict was about. Once.
 *
 * Before this, the first run wrote its row as soon as it ended and a re-entry
 * wrote none, so a delivered correction retry left the contradicted first
 * answer in every one of those places.
 *
 * A turn no re-entry can follow (no verifier, `shadow`, no retry or resample
 * allowed, a canvas stream) has no request ledger and writes its record
 * inside the turn, exactly as before.
 */

/** What writing one pass's row produced. */
export interface WrittenTurn {
  /** The persisted Turn id (`SessionLogger.log`), when the row was written. */
  readonly turnId?: string;
  /** Stream only: the memory the answer was auto-promoted to. */
  readonly autoPromotedMkId?: string;
  /** Stream only: events the write produced (Knowledge-Graph insert pulses). */
  readonly events?: readonly ChatStreamEvent[];
}

/** One pass's row, as the orchestrator would have written it when the pass
 *  ended. */
export interface TurnRecordDraft {
  /** Entities this pass's tool calls touched. A replayed call touches none,
   *  so the committed row carries the entities of every pass. */
  readonly entityRefs: readonly EntityRef[];
  /** Writes the row with `entityRefs` and starts what follows it (fact
   *  extraction, auto-promotion). Expected not to throw. */
  readonly write: (entityRefs: EntityRef[]) => Promise<WrittenTurn>;
}

/** The request's `onAfterTurn`, bound to the hook context the first run
 *  opened (`onBeforeTurn` keyed its state on it). Resolves to the annotation
 *  events the hooks returned. */
export type RequestAfterTurn = (
  answer: string,
  turnExternalId: string | undefined,
) => Promise<readonly ChatStreamEvent[]>;

/** What a commit wrote, and the events a stream releases with the answer. */
export interface CommittedTurn {
  readonly turnId?: string;
  readonly autoPromotedMkId?: string;
  readonly events: readonly ChatStreamEvent[];
}

export class RequestTurnRecord {
  readonly #drafts = new Map<number, TurnRecordDraft>();
  readonly #answers = new Map<number, string>();
  #afterTurn: RequestAfterTurn | undefined;
  #committed: Promise<CommittedTurn> | undefined;
  #settle: () => void = () => undefined;
  readonly #settled = new Promise<void>((resolve) => {
    this.#settle = resolve;
  });

  /**
   * A pass's row (`pass` 0 is the first run). One per pass: a later offer
   * for the same pass replaces the earlier one. The write runs in the async
   * context of the call that offered it — the pass's turn scope, which usage
   * attribution and the turn's identity are read from — exactly as when the
   * pass wrote its row itself.
   */
  offer(pass: number, draft: TurnRecordDraft): void {
    const inPass = AsyncLocalStorage.snapshot();
    this.#drafts.set(pass, {
      entityRefs: draft.entityRefs,
      write: (entityRefs) => inPass(() => draft.write(entityRefs)),
    });
  }

  /** The answer a pass would have handed `onAfterTurn`. */
  noteAnswer(pass: number, answer: string): void {
    this.#answers.set(pass, answer);
  }

  /** The request's `onAfterTurn`, run in the async context of the call that
   *  bound it. The first binding wins: the first run's. */
  bindAfterTurn(afterTurn: RequestAfterTurn): void {
    if (this.#afterTurn !== undefined) return;
    const inRun = AsyncLocalStorage.snapshot();
    this.#afterTurn = (answer, turnExternalId) => inRun(() => afterTurn(answer, turnExternalId));
  }

  /**
   * Writes the request's record from `pass`, once: that pass's row with the
   * entities of every pass, then the request's `onAfterTurn` with that pass's
   * answer and the row's id. Later calls return the first commit's outcome,
   * whichever pass they name. A pass that offered no row writes none (it ended
   * without one, or there is no session logger). Never throws.
   */
  commit(pass: number): Promise<CommittedTurn> {
    this.#committed ??= this.#write(pass).finally(() => {
      this.#settle();
    });
    return this.#committed;
  }

  /** Resolves once the request's record was committed (written or not). */
  whenCommitted(): Promise<void> {
    return this.#settled;
  }

  async #write(pass: number): Promise<CommittedTurn> {
    const draft = this.#drafts.get(pass);
    let written: WrittenTurn = {};
    if (draft !== undefined) {
      try {
        written = await draft.write(this.#entityRefs());
      } catch (err) {
        console.error('[orchestrator] the request’s turn could not be written:', err);
      }
    }
    const answer = this.#answers.get(pass);
    let annotations: readonly ChatStreamEvent[] = [];
    if (this.#afterTurn !== undefined && answer !== undefined) {
      try {
        annotations = await this.#afterTurn(answer, written.turnId);
      } catch (err) {
        console.error('[orchestrator] the request’s onAfterTurn threw (continuing):', err);
      }
    }
    return {
      ...(written.turnId !== undefined ? { turnId: written.turnId } : {}),
      ...(written.autoPromotedMkId !== undefined
        ? { autoPromotedMkId: written.autoPromotedMkId }
        : {}),
      events: [...(written.events ?? []), ...annotations],
    };
  }

  /** Every pass's entities, in pass order (the session logger dedupes). */
  #entityRefs(): EntityRef[] {
    return [...this.#drafts.values()].flatMap((draft) => [...draft.entityRefs]);
  }
}
