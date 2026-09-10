import { CliIncompatibleError, RESTRICTED_FLAG_MIN_CLI_VERSION } from '@omadia/orchestrator';

/**
 * OM-100b — the one fact the dashboard could not see: whether the last chat
 * turn actually worked.
 *
 * In the round-5 beta test every card on the Systemstatus panel was green
 * while every single turn died in the CLI bridge. That is not a bug in any of
 * those cards: "LLM-Provider · VERBUNDEN" answers "is a credential present",
 * "Orchestratoren · VERBUNDEN" answers "is an agent configured". Both were
 * truthfully green. Nobody asked the only question the tester cared about —
 * did the last turn come back.
 *
 * Deliberately in-memory and process-scoped, like `foreignToolMetrics` and
 * `brokerMetrics`: this is a liveness signal about THIS runtime, so it must
 * not survive a restart (a restart is exactly the remedy an operator applies,
 * and a persisted red would then keep lying in the other direction).
 */

/** Error classes the status card can explain rather than just echo. */
export type TurnErrorCode =
  /** The installed `claude` CLI rejects a flag omadia's security gate needs. */
  | 'cli_incompatible'
  /** The CLI-owned turn exceeded its wall-clock budget (OM-104). */
  | 'cli_timeout'
  /** Anything else — the message carries the detail. */
  | 'orchestrator_failure';

export interface TurnOutcome {
  readonly status: 'ok' | 'failed';
  /** Epoch millis of the turn's terminal event. */
  readonly at: number;
  /** Only on `failed`. */
  readonly errorCode?: TurnErrorCode;
  /** Only on `failed`. First line of the underlying error, capped. */
  readonly errorMessage?: string;
  /** Only on `cli_incompatible`: what is installed and what is required. */
  readonly cliVersion?: string;
  readonly minCliVersion?: string;
}

const MAX_MESSAGE_LENGTH = 300;

let lastOutcome: TurnOutcome | undefined;

/** Overwrite the single slot. Newest wins; there is no history here. */
export function recordTurnOutcome(outcome: TurnOutcome): void {
  lastOutcome = outcome;
}

export function getLastTurnOutcome(): TurnOutcome | undefined {
  return lastOutcome;
}

/** Test seam — the module-level slot would otherwise leak across test files. */
export function resetLastTurnOutcome(): void {
  lastOutcome = undefined;
}

export function recordTurnSuccess(now: number = Date.now()): void {
  recordTurnOutcome({ status: 'ok', at: now });
}

function firstLine(message: string): string {
  const line = message.split('\n', 1)[0] ?? message;
  return line.slice(0, MAX_MESSAGE_LENGTH).trim();
}

/**
 * Map a thrown turn error onto the small vocabulary the status card renders.
 * `CliIncompatibleError` is singled out because it has an actionable remedy
 * (update the CLI) that no generic message conveys.
 */
export function classifyTurnError(err: unknown): TurnOutcome {
  const at = Date.now();
  const message = firstLine(err instanceof Error ? err.message : String(err));

  if (err instanceof CliIncompatibleError) {
    return {
      status: 'failed',
      at,
      errorCode: 'cli_incompatible',
      errorMessage: message,
      ...(err.cliVersion !== undefined ? { cliVersion: err.cliVersion } : {}),
      minCliVersion: RESTRICTED_FLAG_MIN_CLI_VERSION,
    };
  }

  // The CLI bridge throws a plain Error for its own timeout (it is not a
  // compatibility problem), so the class is recovered from the message the
  // bridge writes — see `cliChatAgent.ts`'s spawn-timeout branch.
  if (/CLI timed out after \d+ms/.test(message)) {
    return {
      status: 'failed',
      at,
      errorCode: 'cli_timeout',
      errorMessage: message,
    };
  }

  return {
    status: 'failed',
    at,
    errorCode: 'orchestrator_failure',
    errorMessage: message,
  };
}

/** Classify and store in one step — what both chat catch-blocks want. */
export function recordTurnFailure(err: unknown): TurnOutcome {
  const outcome = classifyTurnError(err);
  recordTurnOutcome(outcome);
  return outcome;
}
