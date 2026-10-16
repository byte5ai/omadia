import { fetchMiddlewareHealth } from './platformHealth';

/**
 * AI-Act marking posture, read for the operator channels dashboard (#648).
 *
 * ## Why this reads `/health` rather than a new operator endpoint
 *
 * The middleware already projects the resolved posture there
 * (`src/health/disclosureHealth.ts`), deliberately stripped of anything that
 * permits conclusions about content or users — levels, sources and booleans
 * only. Adding a second endpoint would mean a second projection of the same
 * config, and two projections of one config drift. The dashboard shows exactly
 * what `/health` shows.
 *
 * ## Server-only
 *
 * `/health` lives OUTSIDE the `/api` mount, so the browser-side `/bot-api`
 * proxy does not reach it. This module is called from the server component
 * only; the posture arrives at the client component as a prop.
 */

/** Marking verbosity, as the middleware publishes it. */
export type DisclosureLevel = 'standard' | 'concise' | 'off';

/** The `disclosure` block of `GET /health`. */
export interface DisclosureHealthDto {
  known: boolean;
  source: 'default' | 'operator' | 'unknown';
  deviates: boolean;
  channels: Record<string, DisclosureLevel>;
  inertOverrides: string[];
  warnings: string[];
}

/**
 * Should the operator see the deviation hint?
 *
 * Deviation is the ONLY trigger, and that is deliberate. #648 requires the
 * surface to stay completely quiet in the delivered state — a hint that fires
 * on a default install is one operators learn to scroll past, which would cost
 * exactly the signal this feature exists to create. So: not when the posture
 * could not be read (nothing to claim), not when the middleware is older than
 * this feature, and not for an override that merely pins a channel to the
 * shipping level (`web=standard` configures something inert, but deviates from
 * nothing).
 *
 * Extracted from the component so the rule is testable without rendering an
 * async server component.
 */
export function shouldShowDisclosureNotice(
  posture: DisclosureHealthDto | null,
): boolean {
  return Boolean(posture?.known && posture.deviates);
}

/**
 * The channels whose marking differs from the delivered state, as
 * `[channel, level]` pairs in the order `/health` reported them.
 *
 * Compares against the shipping level rather than against the instance's own
 * global default: an operator who set `ai_disclosure_level=off` globally has
 * deviated on every channel, and a list that quietly treated their global
 * setting as the baseline would report nothing at all.
 */
export function deviatingChannels(
  posture: DisclosureHealthDto,
): Array<[string, DisclosureLevel]> {
  return Object.entries(posture.channels).filter(
    ([, level]) => level !== SHIPPED_LEVEL,
  );
}

/** The delivered marking level. Mirrors `DEFAULT_AI_DISCLOSURE_POLICY.level`
 *  in `@omadia/channel-sdk`; `/health` reports it as `shippedLevel`. */
const SHIPPED_LEVEL: DisclosureLevel = 'standard';

/**
 * Fetch the resolved marking posture.
 *
 * Returns `null` on any failure — an unreachable middleware, an older build
 * whose `/health` has no `disclosure` block. A 503 from a dead pool still
 * carries the full snapshot (#665), which `fetchMiddlewareHealth` parses. The
 * dashboard renders nothing at all when this is `null`: this is an
 * informational hint, and a channels page that fails to load because a hint
 * could not be fetched would be a worse outcome than a missing hint.
 */
export async function fetchDisclosurePosture(): Promise<DisclosureHealthDto | null> {
  const health = await fetchMiddlewareHealth();
  return health.reachable ? (health.body.disclosure ?? null) : null;
}
