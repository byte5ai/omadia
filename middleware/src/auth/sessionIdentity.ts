import type { Request } from 'express';

// Pulls in the `declare module 'express-serve-static-core'` augmentation that
// puts `session?: SessionClaims` on `Request`. Import-for-side-effect only —
// without it this module type-checks against a bare Express `Request`.
import './requireAuth.js';

/**
 * The identity a request's SESSION offers, with no fallback baked in.
 *
 * This is the OAuth-shaped key the MCP token table is keyed on: the same value
 * `/mcp-servers/:id/authorize` stores a token under, so a later chat turn from
 * the same operator resolves that token again. It is deliberately NOT
 * `req.session.omadia_user_id` (the KG cluster-root id that `chat.ts`'s
 * `resolveUserId` reads) — those are different namespaces, and conflating them
 * would look up a token that was never stored.
 *
 * W0-1 (D2): the old `|| 'operator'` tail is gone. Whether an unresolved
 * identity may borrow a shared one is the server's `delegation` decision,
 * applied by `resolveMcpUserKey` — never an implicit default here. Callers
 * must treat `null` as "no identity" and must NOT invent a substitute.
 *
 * Extracted verbatim from `routes/agentBuilder.ts` (W4-1) so the chat routes
 * can PRODUCE the key the MCP auth provider already CONSUMES.
 */
export function sessionIdentity(req: Request): string | null {
  return req.session?.sub || req.session?.email || null;
}
