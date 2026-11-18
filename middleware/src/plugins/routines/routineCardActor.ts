import { recordRefusedRoutineAction } from './refusedRoutineActionMetrics.js';
import type { RoutineActorScope } from './routineRunner.js';
import type { RoutineCardAction } from './routineSmartCard.js';

/**
 * #1025 / #1029 — who a routine smart-card click acts for.
 *
 * The card door (`RoutinesIntegration.handleRoutineAction`) reaches the same
 * pause/resume/trigger/delete mutations as `manage_routine`, on a path that
 * has no principal of its own: the card payload carries only the routine id,
 * and the Teams adapter dispatches the click out-of-band, without running a
 * turn. The channel's `actor` — the tenant and user of the activity the
 * adapter holds — is therefore the only thing this door can scope by.
 *
 * Without it the click is refused. Two fallbacks existed and both are gone:
 *   - the per-turn routine context. On an out-of-band path a context can only
 *     be one `enterWith` leaked forward from an earlier turn (#1016), so it
 *     would attribute the click to whoever spoke last.
 *   - `{ kind: 'operator' }`, #1029's interim, which turned a missing
 *     identity into cross-tenant rights. Operator scope is built by the
 *     `requireAuth`-gated operator router and nowhere else, which
 *     `test/routineOperatorScope.test.ts` enforces.
 */

/**
 * What the user sees. German, because the Teams adapter renders `err.message`
 * verbatim after `Konnte die Routine nicht <verb>: `. It names what has to be
 * updated, because whoever can fix it is not the person who clicked.
 */
const ROUTINE_ACTOR_REQUIRED_MESSAGE =
  'Keine Benutzeridentität für diese Karten-Aktion übermittelt — der ' +
  'Kanal-Adapter muss Mandant und Benutzer des Klicks mitgeben ' +
  '(Teams-Plugin ab 0.26.1).';

/** A card action arrived without a usable principal and was not executed. */
export class RoutineActorRequiredError extends Error {
  constructor(public readonly action: RoutineCardAction) {
    super(ROUTINE_ACTOR_REQUIRED_MESSAGE);
    this.name = 'RoutineActorRequiredError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A usable id half: a string with at least one non-whitespace character. */
function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The scope a card click runs under, or a refusal.
 *
 * `actor` is `unknown` on purpose: the contract says two strings, but a
 * channel plugin compiled against an older contract — or plain JavaScript —
 * can send anything, and this is the kernel's boundary.
 *
 * Blankness is judged on the trimmed value, but the scope carries both halves
 * VERBATIM. They have to equal what the routine was filed under, and
 * `captureRoutineTurn` stores the adapter's values unchanged; trimming on
 * this door alone could only turn a padded id into a silent not-found.
 *
 * A refusal is counted and logged before it is thrown, and before any row is
 * read, so the store never sees a card click without an owner.
 */
export function cardActorScope(
  action: RoutineCardAction,
  routineId: string,
  actor: unknown,
): RoutineActorScope {
  const tenant = isRecord(actor) ? actor['tenant'] : undefined;
  const userId = isRecord(actor) ? actor['userId'] : undefined;
  if (!isUsableId(tenant) || !isUsableId(userId)) {
    recordRefusedRoutineAction(action, routineId);
    throw new RoutineActorRequiredError(action);
  }
  return { kind: 'channel-user', tenant, userId };
}
