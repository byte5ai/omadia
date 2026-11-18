import { turnContext } from './turnContext.js';

/**
 * Did the current turn run without the Privacy Shield, or did a tool bypass
 * it (#1507)? Its text can then hold values no shield masked. Read inside the
 * turn's dispatch; no turn context counts as unprotected (fail closed).
 */
export function isCurrentTurnUnprotected(): boolean {
  const privacy = turnContext.current()?.privacyHandle;
  return privacy === undefined || privacy.hasBypassed?.() === true;
}

/**
 * Does the current turn run with a privacy handle, i.e. does the shield mask
 * what reaches its model? A turn without one (no guard, or the subscription
 * CLI, which has no shield) sends everything as it is anyway.
 */
export function currentTurnIsShielded(): boolean {
  return turnContext.current()?.privacyHandle !== undefined;
}
