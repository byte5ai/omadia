/**
 * #1527 — `parseLlmJson` lives in `@omadia/plugin-api` (shared with the
 * privacy guard's schema classifier). Re-exported here so existing imports
 * of this module keep working.
 */
export { parseLlmJson } from '@omadia/plugin-api';
