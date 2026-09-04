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
 * Scope: this only guards the CLI agent runtime. The in-process orchestrator
 * path never crosses a process boundary and is untouched.
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
  public constructor() {
    // Deliberately says nothing about either principal. This message travels
    // back to the CLI and can reach the model; naming the other user would
    // leak one turn's principal into another's transcript. The detail goes to
    // the server log instead.
    super(
      'Refused: the caller context for this turn could not be verified. ' +
        'This is a runtime fault, not something you did wrong.',
    );
    this.name = 'TurnOwnerMismatchError';
  }
}

interface RoutineTurnOwnerGuardDeps {
  /** Reads the restored context. Injectable so tests need no live ALS. */
  readonly currentContext?: () => { readonly userId?: string } | undefined;
  readonly log?: (message: string) => void;
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
 * | absent  | any      | pass — `manage_routine` already refuses with "no user context"; turning that into a throw would change an established, correct refusal into a harder error for every context-free HTTP turn |
 * | present | absent   | REFUSE — a context exists that this turn cannot vouch for, which is the stale-chain shape |
 * | present | differs  | REFUSE — the bug this issue is about |
 * | present | matches  | pass |
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

  return (input: TurnOwnerGuardInput) => {
    const turnUserId = idOrUndefined(input.userId);

    return (): void => {
      const restored = currentContext();
      // No context at all: the pre-#993 refusal still applies inside the tool.
      if (!restored) return;

      const contextUserId = idOrUndefined(restored.userId);
      if (contextUserId !== undefined && turnUserId !== undefined && contextUserId === turnUserId) {
        return;
      }

      log(
        '[routines] turn-owner guard refused a loopback dispatch (#1016): restored routine context ' +
          `belongs to userId=${contextUserId ?? '<none>'} but the turn belongs to ` +
          `userId=${turnUserId ?? '<none>'}. A stale enterWith chain would otherwise have dispatched ` +
          'under the wrong principal.',
      );
      throw new TurnOwnerMismatchError();
    };
  };
}
