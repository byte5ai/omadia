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

/** Mirrors the middleware's limits — see platform/uiRouteCatalog.ts. */
const MAX_LABEL_LENGTH = 40;
const MAX_HREF_LENGTH = 256;
const MAX_ENTRIES = 100;
const HREF_SEGMENT = /^[A-Za-z0-9\-._~]+$/;

/** Control, bidi-formatting and zero-width codepoints. */
function hasUnsafeChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
    if (code === 0x061c) return true;
    if (code === 0x200e || code === 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code >= 0x200b && code <= 0x200d) return true;
    if (code === 0x2060 || code === 0xfeff) return true;
  }
  return false;
}

/** Canonical in-app path, same rule the middleware enforces. */
function isCanonicalInAppHref(href: string): boolean {
  if (href.length === 0 || href.length > MAX_HREF_LENGTH) return false;
  if (!href.startsWith('/')) return false;
  if (href === '/') return true;
  return href
    .slice(1)
    .split('/')
    .every((s) => s !== '.' && s !== '..' && HREF_SEGMENT.test(s));
}

/**
 * Defensive parse. The nav is chrome on every page, so a malformed or
 * partial response must degrade to "no plugin entries" rather than throw
 * and take the whole layout down with it.
 *
 * This re-applies the middleware's rules rather than trusting them to have
 * run. The middleware is the enforcement point, but it is a *separate
 * deployable* — a version skew, a partial rollout, or a compromised
 * control plane must not be able to put an off-origin link or a
 * header-breaking label into the shell's chrome. Anything that fails is
 * dropped silently; a missing menu entry is a far better outcome than a
 * malicious one.
 */
export function parseEntries(payload: unknown): readonly NavEntryDto[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return [];

  const out: NavEntryDto[] = [];
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const { pluginId, navId, href, label, order, cluster } = e;
    if (
      typeof pluginId !== 'string' ||
      typeof navId !== 'string' ||
      typeof label !== 'string' ||
      typeof href !== 'string'
    ) {
      continue;
    }
    if (label.trim().length === 0 || label.length > MAX_LABEL_LENGTH) continue;
    if (hasUnsafeChars(label) || hasUnsafeChars(href)) continue;
    if (!isCanonicalInAppHref(href)) continue;
    if (cluster !== undefined && typeof cluster !== 'string') continue;
    // `JSON.parse('{"order":1e400}')` yields Infinity, which is a number —
    // it would poison every comparison in the merge sort.
    const resolvedOrder =
      typeof order === 'number' && Number.isFinite(order) ? order : 100;
    out.push({
      pluginId,
      navId,
      href,
      label,
      order: resolvedOrder,
      ...(typeof cluster === 'string' ? { cluster } : {}),
    });
  }
  return out;
}

/**
 * Hard ceiling on how long the nav lookup may delay a page render.
 *
 * This runs in the root layout, so it is on the critical path of EVERY
 * page. An unbounded fetch would let a hung or half-open middleware stall
 * the entire UI rather than degrade one menu. Two seconds is far above the
 * real cost (an in-memory map walk on the same host) and far below any
 * user-visible stall budget.
 */
const NAV_FETCH_TIMEOUT_MS = 2_000;

/**
 * Fetch the plugin-contributed nav for `locale`. Never throws and never
 * redirects: an unauthenticated visitor (login, setup), an unreachable or
 * slow middleware, or a malformed response all yield an empty list, and
 * the shell renders its static nav alone. Losing a plugin's menu entry is
 * an acceptable degradation; losing the page is not.
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
        signal: AbortSignal.timeout(NAV_FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) return [];
    return parseEntries((await res.json()) as unknown);
  } catch {
    return [];
  }
}
