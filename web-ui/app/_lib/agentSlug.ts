/**
 * #1885 — the slug rules as HTML `pattern` attributes.
 *
 * Browsers compile `pattern` with the `v` flag, where an unescaped `-` at the
 * end of a character class is a syntax error: the old `^[a-z0-9][a-z0-9-]*$`
 * was ignored with a console warning, so the form never checked anything.
 * `pattern` is anchored by the browser; no `^`/`$` here.
 */

/** An agent slug (server: `AGENT_SLUG_RE` in harness-orchestrator's configStore). */
export const AGENT_SLUG_PATTERN = '[a-z0-9](?:[a-z0-9\\-]{0,62}[a-z0-9])?';
export const AGENT_SLUG_MAX_LENGTH = 64;

/** A Teams bot slug (server: `TeamsIdentityProvisionSchema.bot_slug`, 1..63 chars). */
export const TEAMS_BOT_SLUG_PATTERN = '[a-z0-9][a-z0-9\\-]{0,62}';
export const TEAMS_BOT_SLUG_MAX_LENGTH = 63;

/** Whether `value` matches `pattern` the way the browser checks it. */
export function matchesHtmlPattern(pattern: string, value: string): boolean {
  return new RegExp(`^(?:${pattern})$`, 'v').test(value);
}
