/**
 * The one sentence that tells an operator where to configure LLM access.
 *
 * Issue #1090 — this text lived twice, as a literal in the boot warning and
 * again in the `chat_unavailable` 503 body, and both copies said "via the
 * Setup Wizard" long after the wizard stopped collecting a key. Two copies of
 * a claim drift apart; one does not. Every surface that tells an operator how
 * to turn chat on must compose this constant rather than restate it.
 *
 * Middleware copy has no i18n layer and is English by construction.
 */
export const LLM_SETUP_HINT =
  'connect a provider under Admin → LLM access (/admin/providers), or set ANTHROPIC_API_KEY in middleware/.env';
