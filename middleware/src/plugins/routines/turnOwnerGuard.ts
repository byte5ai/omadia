import { randomBytes } from 'node:crypto';

import { routineTurnContext } from './routineTurnContext.js';

/**
 * #1016 — the production guard behind `CliChatAgentDeps.turnOwnerGuard`.
 *
 * On the subscription-CLI path a tool call arrives as an HTTP request from the
 * external `claude` process, so #993 restores the turn's async context around
 * the dispatch to give `manage_routine` its `(tenant, userId)` back. Restoring
 * a context is not the same as trusting it: channel adapters install it with
 * `routineTurnContext.enter`, i.e. `AsyncLocalStorage.enterWith`, which has NO
 * scope exit. The value persists forward on the async chain, so a chain that
 * starts a new turn without calling `captureRoutineTurn` again still carries
 * the PREVIOUS turn's principal.
 *
 * Before #993 that was harmless in the worst way — the CLI path saw no context
 * at all and the tool refused. After #993 the same staleness means acting AS
 * the previous principal. This guard turns that back into a refusal.
 *
 * The check is deliberately a plain identity comparison and not a call to
 * `resolveTurnOwnerIdentity`: the guard runs synchronously inside the restored
 * context immediately before dispatch, and both sides of the comparison are
 * the same channel-native id. `captureRoutineTurn({userId})` and
 * `ChatTurnInput.userId` are populated by the SAME channel adapter from the
 * same source (Teams AAD object id, HTTP `x-user-id`), so they agree for a
 * turn whose context is its own, and disagree exactly when the context is
 * stale. `resolveTurnOwnerIdentity` canonicalises a channel id into an omadia
 * uuid via the KnowledgeGraph, which is async and would compare two different
 * id spaces here.
 *
 * Scope, twice over. Only the CLI agent runtime is guarded — the in-process
 * orchestrator path never crosses a process boundary. And among the shipped
 * channels only the Teams adapter calls `captureRoutineTurn`, so it is the
 * only one that installs a context this guard can find stale;
 * `omadia-channel-telegram` never calls it and does not participate.
 */

/** Service name the kernel publishes the factory under. */
export const ROUTINE_TURN_OWNER_GUARD_SERVICE_NAME = 'routineTurnOwnerGuard';

/** The slice of a turn the guard needs; structurally a `ChatTurnInput`. */
export interface TurnOwnerGuardInput {
  readonly userId?: string | undefined;
}

/**
 * Built once per turn at the agent's public entry point, so the returned
 * closure can compare the turn it belongs to against whatever the restored
 * context reports at dispatch time. Returning `undefined` means "no guard for
 * this turn"; the guard itself throws to refuse.
 */
export type TurnOwnerGuardFactory = (
  input: TurnOwnerGuardInput,
) => (() => void) | undefined;

/** Raised when the restored context does not belong to the running turn. */
export class TurnOwnerMismatchError extends Error {
  /** Correlation token, also emitted in the server log for this refusal. */
  public readonly ref: string;

  public constructor(ref: string) {
    // Deliberately says nothing about either principal. This message travels
    // back to the CLI and can reach the model; naming the other user would
    // leak one turn's principal into another's transcript. The detail goes to
    // the server log instead, joined to this text only by `ref` — enough to
    // match a user's report to a log line, and useless to anyone who cannot
    // read the log.
    super(
      'Refused: the caller context for this turn could not be verified ' +
        `(ref ${ref}). This is a runtime fault, not something you did wrong.`,
    );
    this.name = 'TurnOwnerMismatchError';
    this.ref = ref;
  }
}

interface RoutineTurnOwnerGuardDeps {
  /** Reads the restored context. Injectable so tests need no live ALS. */
  readonly currentContext?: () => { readonly userId?: string } | undefined;
  readonly log?: (message: string) => void;
  /** Correlation-token source. Injectable so tests can assert a fixed ref. */
  readonly newRef?: () => string;
}

/** Normalises a possibly blank id to `undefined` so "" never matches "". */
function idOrUndefined(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Build the guard factory the kernel publishes.
 *
 * Decision table, all four cases deliberate:
 *
 * | restored context | turn `userId` | outcome |
 * |---|---|---|
 * | absent  | any      | pass — see the note below on why, and on what it does not cover |
 * | present | absent   | REFUSE — a context exists that this turn cannot vouch for, which is the stale-chain shape |
 * | present | differs  | REFUSE — the bug this issue is about |
 * | present | matches  | pass |
 *
 * On the "absent ⇒ pass" row, stated precisely because the obvious phrasing
 * overclaims: `manage_routine` refuses a missing context in `handleCreate` and
 * `handleList` only. `handlePause`, `handleResume` and `handleDelete` never
 * call `resolveContext` at all — they pass a bare `args.id` to the runner,
 * which does no tenant scoping. So for two of five actions the absent-context
 * case is genuinely covered downstream; for the other three nothing checks,
 * and passing here neither creates nor closes that hole. The reason to pass is
 * narrower than "the tool handles it": throwing on absence would harden every
 * context-free HTTP turn into an error, and this guard's job is staleness, not
 * authorization. The pause/resume/delete scoping gap is tracked separately.
 */
export function createRoutineTurnOwnerGuard(
  deps: RoutineTurnOwnerGuardDeps = {},
): TurnOwnerGuardFactory {
  const currentContext =
    deps.currentContext ?? ((): { readonly userId?: string } | undefined => routineTurnContext.current());
  const log =
    deps.log ??
    ((message: string): void => {
      console.error(message);
    });
  // Short, non-guessable, and not derived from either principal — it exists to
  // join a user's "ref abc12345" to one log line, nothing more.
  const newRef = deps.newRef ?? ((): string => randomBytes(4).toString('hex'));

  return (input: TurnOwnerGuardInput) => {
    const turnUserId = idOrUndefined(input.userId);

    return (): void => {
      const restored = currentContext();
      // No context: nothing to cross-check. See the decision table above for
      // why this passes and what it does not cover.
      if (!restored) return;

      const contextUserId = idOrUndefined(restored.userId);
      if (contextUserId !== undefined && turnUserId !== undefined && contextUserId === turnUserId) {
        return;
      }

      const ref = newRef();
      log(
        `[routines] turn-owner guard refused a loopback dispatch (#1016) ref=${ref}: ` +
          `restored routine context belongs to userId=${contextUserId ?? '<none>'} ` +
          `but the turn belongs to userId=${turnUserId ?? '<none>'}. A stale enterWith ` +
          'chain would otherwise have dispatched under the wrong principal.',
      );
      throw new TurnOwnerMismatchError(ref);
    };
  };
}
