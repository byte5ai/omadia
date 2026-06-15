/**
 * RFC 7636 — PKCE helpers for the plugin-OAuth flow.
 *
 * The implementation now lives in `@omadia/plugin-api` (spec 004 FR-B4) so
 * plugins running their own redirect flows and the kernel broker share one
 * source of truth. This module re-exports it to keep existing kernel imports
 * (`oauth/index.ts`) stable.
 */

export { generateCodeVerifier, computeCodeChallenge } from '@omadia/plugin-api';
