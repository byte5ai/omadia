/**
 * The ONE definition of the Teams bot messaging wire paths.
 *
 * Its own module, dependency-free on purpose — the same reason
 * `mcp/publicMcpPath.ts` exists: `auth/publicPaths.ts` imports this to build
 * the requireAuth exemption, and `platform/teamsProvisionerService.ts` imports
 * it to build the endpoint URL handed to Azure. If the definition lived next
 * to the provisioner, importing it would drag the whole provisioning contract
 * into `publicPaths.ts`'s import graph — and into every test that asserts
 * against the allowlist — for the sake of one path shape.
 *
 * WHY THIS MODULE EXISTS AT ALL
 * -----------------------------
 * It is the fix for a specific, shipped outage. Before channel-teams 0.20.0
 * there was exactly one Bot Framework webhook, `/api/messages`, and exactly one
 * static exemption for it in `auth/publicPaths.ts`. 0.20.0 added the per-bot
 * route `/api/teams/<botSlug>/messages` and the no-slug alias
 * `/api/teams/messages`; the provisioner was taught to hand Azure the new URL
 * (`buildTeamsBotMessagingEndpoint`) and the exemption was NOT extended to
 * match. Every provisioned bot then answered Teams with the middleware's
 * `401 {"code":"auth.missing"}` — the blanket OB-106 `/api` guard rejecting a
 * Bot-Framework bearer token because it is not an operator session cookie —
 * before the bot handler was ever reached. The bots were silent, and every
 * other link in the chain (app registration, catalog app, Teams channel, chat
 * install, endpoint URL) was correct.
 *
 * The drift was therefore between two things CORE owns and core alone: the URL
 * core PROVISIONS and the URL core EXEMPTS. Those are now derived from the
 * constants below, so extending one extends the other. That is the whole point
 * of this module — a second, hand-retyped copy of the path is exactly the bug
 * it exists to make unrepresentable.
 */

/** Root under which channel-teams serves its slug-addressed webhooks. */
export const TEAMS_MESSAGING_ROOT = '/api/teams';

/** The terminal segment of every messaging route. */
export const TEAMS_MESSAGING_SEGMENT = 'messages';

/**
 * The bot-slug charset, as a RegExp SOURCE fragment so it can be embedded in
 * the exemption pattern below as well as anchored on its own.
 *
 * Deliberately conservative: a slug lands verbatim in the Azure bot's
 * messaging endpoint and in channel-teams' `:botSlug` route, so it may contain
 * nothing that could re-shape a path. Every character here is left untouched
 * by `encodeURIComponent`, which is what lets the exemption pattern match the
 * raw request path that {@link teamsBotMessagingPath} produces.
 */
export const TEAMS_BOT_SLUG_SOURCE = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';

/** {@link TEAMS_BOT_SLUG_SOURCE}, anchored — the provisioner's input guard. */
export const TEAMS_BOT_SLUG_RE = new RegExp(`^${TEAMS_BOT_SLUG_SOURCE}$`);

/**
 * The no-slug alias, which channel-teams routes to the DEFAULT bot. Listed in
 * the manifest as the documented spelling for Azure setup, so a bot registered
 * by an operator who followed the manifest points here rather than at
 * `/api/messages`.
 */
export const TEAMS_DEFAULT_MESSAGING_PATH = `${TEAMS_MESSAGING_ROOT}/${TEAMS_MESSAGING_SEGMENT}`;

/** The path component of one bot's messaging endpoint. */
export function teamsBotMessagingPath(botSlug: string): string {
  return `${TEAMS_MESSAGING_ROOT}/${encodeURIComponent(botSlug)}/${TEAMS_MESSAGING_SEGMENT}`;
}

/**
 * The requireAuth exemption pattern. Matched against `req.originalUrl`, hence
 * the `(?:$|\?)` tail every entry in `auth/publicPaths.ts` carries.
 *
 * WHAT IT ADMITS, AND WHY IT IS NOT `^/api/teams`
 * ----------------------------------------------
 * Exactly two shapes, both of which are POST-only webhooks whose bodies the
 * Bot Framework authenticates:
 *
 *     /api/teams/messages              → the default bot
 *     /api/teams/<botSlug>/messages    → that one bot's own credentials
 *
 * and nothing else. A prefix exemption for `/api/teams` would be a different
 * and much worse thing. `publicPaths` is a pure BYPASS, not a terminating
 * mount (see the header of `platform/publicPathGrants.ts`): a matching URL
 * skips the session gate and travels on into whatever router answers it. So
 * the entry must name the URLs that a self-authenticating handler owns TODAY,
 * not a namespace some future router may mount a session-needing sibling
 * under. `/api/teams/<slug>/admin` and `/api/teams/settings` do not match this
 * pattern and 401 exactly as they do now — pinned in
 * `test/auth/teamsMessagingPublicPath.test.ts`.
 *
 * The slug segment is matched with the real slug charset rather than `[^/]+`
 * for the same reason: only a slug the provisioner would actually have minted
 * can reach the handler unauthenticated.
 *
 * The optional trailing slash is Express's own non-strict routing (`/messages`
 * and `/messages/` are one route), so it admits no additional handler. It does
 * NOT admit a subpath: unlike the legacy `/api/messages` entry, which carries
 * `(?:\/|$|\?)` and therefore exempts anything beneath it, `/messages/anything`
 * is not matched here.
 */
export const TEAMS_MESSAGING_PATH_RE = new RegExp(
  `^${TEAMS_MESSAGING_ROOT}/(?:${TEAMS_BOT_SLUG_SOURCE}/)?${TEAMS_MESSAGING_SEGMENT}/?(?:$|\\?)`,
);
