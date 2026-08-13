import { parse as parseCookieHeader } from 'cookie';
import type { OperatorAuthAccessor } from '@omadia/plugin-api';

import { evaluateSessionToken, SESSION_COOKIE } from './requireAuth.js';
import type { EmailWhitelist } from './whitelist.js';

/**
 * Issue #438 follow-up — kernel-side implementation of the plugin-facing
 * `ctx.operatorAuth` accessor. Wraps `evaluateSessionToken`, the EXACT SAME
 * session-verification logic `requireAuth` runs for every gated
 * `/api/v1/*` route, so a plugin that needs an operator-only admin surface
 * (e.g. `@omadia/channel-api`'s `/admin/keys`) can reuse it instead of
 * re-implementing — and risking drifting from — the kernel's own session
 * rules. There is exactly one code path that decides session validity; this
 * is a thin adapter from "raw Cookie header" to that path, not a second one.
 */
export function createOperatorAuthAccessor(deps: {
  signingKey: Uint8Array;
  whitelist: EmailWhitelist;
}): OperatorAuthAccessor {
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
      const result = await evaluateSessionToken(parsed[SESSION_COOKIE], deps);
      return result.ok;
    },
  };
}
