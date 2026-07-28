/**
 * Plugin-contributed navigation entries (`GET /api/v1/ui/navigation`).
 *
 * The shell ships a static nav for its own compiled surfaces and merges
 * this for anything a plugin adds, so a feature's menu entry can travel
 * with the plugin that owns it instead of being hardcoded in `Nav.tsx`.
 *
 * Fetched server-side from the root layout, deliberately:
 *   - labels are resolved by the middleware for the locale the server
 *     already knows, so there is no second i18n clock to drift out of
 *     sync with next-intl on a locale switch;
 *   - the nav renders correct on first paint, with no post-hydration
 *     mutation of the header.
 *
 * `botApi` + `forwardCookieHeader` mirror `_lib/agents.ts` — they are
 * file-private there, and exporting them would mean changing an unrelated
 * module's public surface. Keep the three in sync if the cookie / URL
 * conventions ever change.
 */

function botApi(path: string): string {
  if (typeof window !== 'undefined') {
    return `/bot-api${path}`;
  }
  const base = process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979';
  return `${base}/api${path}`;
}

async function forwardCookieHeader(): Promise<Record<string, string>> {
  if (typeof window !== 'undefined') return {};
  try {
    const mod = await import('next/headers');
    const jar = await mod.cookies();
    const cookieHeader = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    return cookieHeader ? { cookie: cookieHeader } : {};
  } catch {
    return {};
  }
}

/**
 * One entry in the operator nav, contributed by a plugin. `label` is
 * already resolved for the requested locale by the middleware.
 */
export interface NavEntryDto {
  readonly pluginId: string;
  readonly navId: string;
  readonly href: string;
  readonly cluster?: string;
  readonly order: number;
  readonly label: string;
}

/**
 * Defensive parse. The nav is chrome on every page, so a malformed or
 * partial response must degrade to "no plugin entries" rather than throw
 * and take the whole layout down with it. The middleware validates these
 * fields at registration time; this is the second half of that contract,
 * enforced at the trust boundary.
 */
function parseEntries(payload: unknown): readonly NavEntryDto[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return [];

  const out: NavEntryDto[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const { pluginId, navId, href, label, order, cluster } = e;
    if (
      typeof pluginId !== 'string' ||
      typeof navId !== 'string' ||
      typeof label !== 'string' ||
      typeof href !== 'string' ||
      label.length === 0
    ) {
      continue;
    }
    // Never render a link the middleware would not have accepted: in-app
    // paths only, so a compromised or buggy plugin cannot point the
    // trusted header off-origin.
    if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/\\')) {
      continue;
    }
    out.push({
      pluginId,
      navId,
      href,
      label,
      order: typeof order === 'number' ? order : 100,
      ...(typeof cluster === 'string' ? { cluster } : {}),
    });
  }
  return out;
}

/**
 * Fetch the plugin-contributed nav for `locale`. Never throws and never
 * redirects: an unauthenticated visitor (login, setup) or an unreachable
 * middleware simply gets an empty list, and the shell renders its static
 * nav alone.
 */
export async function fetchNavEntries(
  locale: string,
): Promise<readonly NavEntryDto[]> {
  try {
    const res = await fetch(
      botApi(`/v1/ui/navigation?locale=${encodeURIComponent(locale)}`),
      {
        headers: await forwardCookieHeader(),
        cache: 'no-store',
      },
    );
    if (!res.ok) return [];
    return parseEntries((await res.json()) as unknown);
  } catch {
    return [];
  }
}
