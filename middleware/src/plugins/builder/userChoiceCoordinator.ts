import { randomUUID } from 'node:crypto';

import type { SpecEventBus } from './specEventBus.js';

/**
 * Smart-card choice coordinator for the builder agent.
 *
 * The `ask_user_choice` tool calls `create(...)` to register a pending
 * choice and wait for the operator's pick. The UI receives the
 * `user_choice_required` event via the SpecEventBus and renders a
 * Smart-Card with two to four buttons. When the operator clicks one,
 * the route handler calls `resolve(...)` and the tool returns with
 * the chosen value.
 *
 * Coordinator state is in-memory only; pending choices do not survive
 * a middleware restart. A restart is treated as "operator did not
 * answer" — the tool surfaces a `cancelled` reason and the builder
 * agent can re-ask in the next turn if it still needs the answer.
 */

export interface ChoiceOption {
  /** Stable enum value passed back when the operator picks this option. */
  value: string;
  /** Operator-facing button label. */
  label: string;
  /** Optional short hint shown under the label. */
  description?: string;
}

export interface PendingChoice {
  choiceId: string;
  draftId: string;
  question: string;
  options: ChoiceOption[];
  createdAt: number;
}

export interface ChoiceResolution {
  ok: true;
  choiceId: string;
  value: string;
}

export interface ChoiceCancellation {
  ok: false;
  choiceId: string;
  reason: 'cancelled' | 'timeout' | 'unknown';
}

export type ChoiceOutcome = ChoiceResolution | ChoiceCancellation;

interface PendingEntry {
  choice: PendingChoice;
  resolve: (outcome: ChoiceOutcome) => void;
}

export interface UserChoiceCoordinatorOptions {
  bus: SpecEventBus;
  /** Timeout after which a pending choice resolves to `timeout`.
   *  Default 30 minutes — long enough that the operator can step away. */
  timeoutMs?: number;
  /** ID generator override (tests). */
  generateId?: () => string;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class UserChoiceCoordinator {
  private readonly bus: SpecEventBus;
  private readonly timeoutMs: number;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(opts: UserChoiceCoordinatorOptions) {
    this.bus = opts.bus;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.generateId = opts.generateId ?? (() => randomUUID());
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Register a pending choice and emit the `user_choice_required` event.
   * Returns a promise that resolves when the operator picks an option,
   * or when the coordinator times out / is cancelled.
   */
  create(input: {
    draftId: string;
    question: string;
    options: ChoiceOption[];
  }): { choiceId: string; result: Promise<ChoiceOutcome> } {
    if (input.options.length < 2 || input.options.length > 4) {
      throw new Error(
        `ask_user_choice expects 2-4 options, got ${String(input.options.length)}`,
      );
    }
    const choiceId = this.generateId();
    const choice: PendingChoice = {
      choiceId,
      draftId: input.draftId,
      question: input.question,
      options: input.options,
      createdAt: this.now(),
    };

    let timer: NodeJS.Timeout | undefined;
    const result = new Promise<ChoiceOutcome>((resolve) => {
      const entry: PendingEntry = {
        choice,
        resolve: (outcome) => {
          if (timer) clearTimeout(timer);
          this.pending.delete(choiceId);
          resolve(outcome);
        },
      };
      this.pending.set(choiceId, entry);
      timer = setTimeout(() => {
        if (this.pending.has(choiceId)) {
          entry.resolve({ ok: false, choiceId, reason: 'timeout' });
        }
      }, this.timeoutMs);
    });

    this.bus.emit(input.draftId, {
      type: 'user_choice_required',
      choiceId,
      question: input.question,
      options: input.options,
    });

    return { choiceId, result };
  }

  /**
   * Resolve a pending choice. Returns true when the choiceId matched a
   * live entry, false when the choice was unknown (already resolved,
   * timed out, or never created). The bus emits a
   * `user_choice_resolved` event so multi-tab clients can dismiss the
   * card.
   */
  resolve(input: {
    draftId: string;
    choiceId: string;
    value: string;
  }): boolean {
    const entry = this.pending.get(input.choiceId);
    if (!entry) return false;
    if (entry.choice.draftId !== input.draftId) return false;
    const allowed = entry.choice.options.some((o) => o.value === input.value);
    if (!allowed) return false;
    entry.resolve({ ok: true, choiceId: input.choiceId, value: input.value });
    this.bus.emit(input.draftId, {
      type: 'user_choice_resolved',
      choiceId: input.choiceId,
      value: input.value,
    });
    return true;
  }

  /**
   * Cancel a pending choice. Used by the route layer when the
   * operator dismisses the smart-card without picking an option.
   */
  cancel(input: { draftId: string; choiceId: string }): boolean {
    const entry = this.pending.get(input.choiceId);
    if (!entry) return false;
    if (entry.choice.draftId !== input.draftId) return false;
    entry.resolve({
      ok: false,
      choiceId: input.choiceId,
      reason: 'cancelled',
    });
    this.bus.emit(input.draftId, {
      type: 'user_choice_resolved',
      choiceId: input.choiceId,
      value: null,
    });
    return true;
  }

  /** Test-only: number of live pending choices. */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Resolve every pending choice as cancelled. Used by graceful
   * shutdown to wake up waiting builder turns so they can exit.
   */
  cancelAll(): void {
    for (const entry of Array.from(this.pending.values())) {
      entry.resolve({
        ok: false,
        choiceId: entry.choice.choiceId,
        reason: 'cancelled',
      });
    }
  }
}
