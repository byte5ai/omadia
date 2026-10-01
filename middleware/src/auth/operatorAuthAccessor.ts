import { parseCookie as parseCookieHeader } from 'cookie';
import type { OperatorAuthAccessor } from '@omadia/plugin-api';

import {
  evaluateSessionToken,
  SESSION_COOKIE,
  type SessionEvaluationDeps,
} from './requireAuth.js';

/**
 * Issue #438 follow-up — kernel-side implementation of the plugin-facing
 * `ctx.operatorAuth` accessor. Wraps `evaluateSessionToken`, the EXACT SAME
 * session-verification logic `requireAuth` runs for every gated
 * `/api/v1/*` route, so a plugin that needs an operator-only admin surface
 * (e.g. `@omadia/channel-api`'s `/admin/keys`) can reuse it instead of
 * re-implementing — and risking drifting from — the kernel's own session
 * rules. There is exactly one code path that decides session validity; this
 * is a thin adapter from "raw Cookie header" to that path, not a second one —
 * so a revoked session (`deps.sessions`) is refused here exactly as it is on
 * every `/api` route.
 */
export function createOperatorAuthAccessor(
  deps: SessionEvaluationDeps,
): OperatorAuthAccessor {
  return {
    async hasValidSession(cookieHeader: string | undefined): Promise<boolean> {
      if (!cookieHeader) return false;
      let parsed: Record<string, string | undefined>;
      try {
        parsed = parseCookieHeader(cookieHeader);
      } catch {
        // Malformed Cookie header — never throw out of this accessor.
        return false;
      }
      try {
        const result = await evaluateSessionToken(parsed[SESSION_COOKIE], deps);
        // `auth.unavailable` (revocation lookup failed) is `false` too: the
        // contract is a boolean, and an unverifiable session is not valid.
        return result.ok;
      } catch {
        // The evaluation already maps a store outage to a verdict; this keeps
        // the plugin-facing contract ("never throws") airtight regardless.
        return false;
      }
    },
  };
}
