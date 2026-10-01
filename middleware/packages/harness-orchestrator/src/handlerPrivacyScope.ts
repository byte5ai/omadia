/**
 * What a tool handler runs UNDER when it is dispatched outside a chat turn.
 *
 * A dispatch seam guards what a handler RETURNS. Code running INSIDE the
 * handler reads its privacy handle from `turnContext`: a domain tool's
 * `LocalSubAgent` (its inner tool results, inner tool errors and the requests
 * to its own model provider), a plugin tool asking a sub-agent
 * (`ctx.subAgent.ask`), a nested dispatcher's ambient fallback. The chat path
 * runs every handler inside its turn scope, so they find the turn's handle. A
 * standalone dispatcher — the public MCP endpoint — runs outside any turn, so
 * that read found nothing, and a sub-agent's provider received what the API
 * caller only ever saw masked.
 */

import type { PrivacyTurnHandle } from './privacyHandle.js';
import { today, turnContext } from './turnContext.js';

/**
 * Runs `handler` with `privacy` as the ambient `turnContext.privacyHandle` —
 * its `forNestedCalls()` variant when it has one (the public MCP gate keeps
 * its positive `masked()` signal for the call's own result).
 *
 * Inside a turn only the handle changes. Outside one the scope is turn-less
 * (`turnId: ''`, as `ctx.mcp` opens it), so nothing else — MCP audit or usage
 * attribution — reads it as a turn. No re-scope when the handle is already
 * the ambient one, and none without a handle (no provider installed).
 */
export function runHandlerInPrivacyScope<T>(
  privacy: PrivacyTurnHandle | undefined,
  handler: () => Promise<T>,
): Promise<T> {
  if (privacy === undefined) return handler();
  const nested = privacy.forNestedCalls?.() ?? privacy;
  const current = turnContext.current();
  if (current?.privacyHandle === nested) return handler();
  return turnContext.run(
    { ...(current ?? { turnId: '', turnDate: today() }), privacyHandle: nested },
    handler,
  );
}
