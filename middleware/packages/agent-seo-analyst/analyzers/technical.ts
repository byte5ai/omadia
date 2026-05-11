import type { createFetcher } from '../fetcher.js';
import type {
  RobotsReport,
  SeoIssue,
  SitemapEntry,
  TechnicalReport,
} from '../types.js';
import { scoreTechnical } from './scoring.js';

type Fetcher = ReturnType<typeof createFetcher>;

export async function analyzeTechnical(
  fetcher: Fetcher,
  baseUrl: string,
  userAgent: string,
): Promise<TechnicalReport> {
  const root = normalizeBase(baseUrl);
  const [robots, rootResponse] = await Promise.all([
    fetchRobots(fetcher, root, userAgent),
    fetcher.get(root, true),
  ]);

  const sitemapUrls = robots.sitemaps.length > 0 ? robots.sitemaps : [joinUrl(root, '/sitemap.xml')];
  const sitemaps = await Promise.all(sitemapUrls.map((u) => fetchSitemap(fetcher, u)));

  const issues: SeoIssue[] = [];

  if (!robots.fetched) {
    issues.push({
      severity: 'warning',
      code: 'robots.missing',
      message: 'robots.txt nicht erreichbar.',
    });
  }
  if (robots.fetched && !robots.allows_our_ua) {
    issues.push({
      severity: 'error',
      code: 'robots.disallow_self',
      message: `robots.txt blockiert den User-Agent ${userAgent}.`,
    });
  }
  if (sitemaps.every((s) => s.status !== 200)) {
    issues.push({
      severity: 'warning',
      code: 'sitemap.missing',
      message: 'Kein erreichbares sitemap.xml.',
    });
  }
  for (const s of sitemaps) {
    for (const err of s.errors) {
      issues.push({
        severity: 'warning',
        code: 'sitemap.parse_error',
        message: `${s.url}: ${err}`,
      });
    }
  }

  const usesHttps = root.startsWith('https://');
  if (!usesHttps) {
    issues.push({
      severity: 'error',
      code: 'https.missing',
      message: 'Root-URL ist kein HTTPS.',
    });
  }

  const hsts = headerOf(rootResponse.headers, 'strict-transport-security');
  const csp = headerOf(rootResponse.headers, 'content-security-policy');
  const xRobots = headerOf(rootResponse.headers, 'x-robots-tag');
  const xFrame = headerOf(rootResponse.headers, 'x-frame-options');
  const xRobotsIndexable = !xRobots || !/noindex/i.test(xRobots);

  if (!hsts && usesHttps) {
    issues.push({
      severity: 'info',
      code: 'headers.hsts.missing',
      message: 'Kein Strict-Transport-Security-Header.',
    });
  }
  if (xRobots && /noindex/i.test(xRobots)) {
    issues.push({
      severity: 'error',
      code: 'headers.x_robots.noindex',
      message: `x-robots-tag blockiert Indexierung: "${xRobots}".`,
    });
  }

  const score = scoreTechnical({
    robotsFetched: robots.fetched,
    allowsOurUa: robots.allows_our_ua,
    sitemapsCount: sitemaps.filter((s) => s.status === 200).length,
    sitemapsOk: sitemaps.some((s) => s.status === 200 && s.errors.length === 0),
    httpsOk: usesHttps,
    hstsPresent: !!hsts,
    cspPresent: !!csp,
    xRobotsIndexable,
  });

  return {
    base_url: root,
    robots,
    sitemaps,
    https: { uses_https: usesHttps, http_redirects_to_https: null },
    headers: {
      x_robots_tag: xRobots,
      strict_transport_security: hsts,
      content_security_policy_present: !!csp,
      x_frame_options: xFrame,
    },
    issues,
    score,
  };
}

async function fetchRobots(
  fetcher: Fetcher,
  root: string,
  userAgent: string,
): Promise<RobotsReport> {
  const res = await fetcher.get(joinUrl(root, '/robots.txt'), false);
  if (res.status !== 200) {
    return {
      fetched: false,
      status: res.status || null,
      sitemaps: [],
      user_agents: [],
      disallows_root: false,
      allows_our_ua: true,
      raw_length: 0,
    };
  }
  return parseRobotsTxt(res.body, userAgent);
}

export function parseRobotsTxt(raw: string, userAgent: string): RobotsReport {
  const lines = raw.split(/\r?\n/);
  const sitemaps: string[] = [];
  const uaBlocks: { uas: string[]; rules: { type: 'allow' | 'disallow'; value: string }[] }[] = [];
  let current: (typeof uaBlocks)[number] | null = null;
  const allUas = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) {
      current = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current) {
        current = { uas: [], rules: [] };
        uaBlocks.push(current);
      }
      current.uas.push(value);
      allUas.add(value);
      continue;
    }
    if (!current) {
      current = { uas: ['*'], rules: [] };
      uaBlocks.push(current);
      allUas.add('*');
    }
    if (key === 'allow') current.rules.push({ type: 'allow', value });
    if (key === 'disallow') current.rules.push({ type: 'disallow', value });
  }

  const matching = uaBlocks.filter((b) =>
    b.uas.some((ua) => ua === '*' || userAgent.toLowerCase().includes(ua.toLowerCase())),
  );
  const rules = matching.flatMap((b) => b.rules);
  const disallowsRoot = rules.some((r) => r.type === 'disallow' && (r.value === '/' || r.value === ''));
  const allowsRoot = rules.some((r) => r.type === 'allow' && r.value === '/');

  return {
    fetched: true,
    status: 200,
    sitemaps,
    user_agents: [...allUas],
    disallows_root: disallowsRoot && !allowsRoot,
    allows_our_ua: !(disallowsRoot && !allowsRoot),
    raw_length: raw.length,
  };
}

async function fetchSitemap(fetcher: Fetcher, url: string): Promise<SitemapEntry> {
  const res = await fetcher.get(url, false);
  if (res.status !== 200) {
    return { url, status: res.status, url_count: null, is_index: false, errors: [] };
  }
  const errors: string[] = [];
  const body = res.body;
  const isIndex = /<sitemapindex\b/i.test(body);
  const urlCount = (body.match(/<url\b/gi) ?? []).length;
  const submapCount = (body.match(/<sitemap\b/gi) ?? []).length;

  if (!/<\?xml/i.test(body) && !/<urlset\b/i.test(body) && !isIndex) {
    errors.push('Kein gültiges XML / kein <urlset> / <sitemapindex>.');
  }

  return {
    url,
    status: 200,
    url_count: isIndex ? submapCount : urlCount,
    is_index: isIndex,
    errors,
  };
}

export function extractSitemapUrls(xml: string, limit: number): string[] {
  const out: string[] = [];
  const re = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && out.length < limit) {
    const v = (m[1] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

function normalizeBase(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return u.replace(/\/$/, '');
  }
}

function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : base + '/').toString();
}

function headerOf(headers: Record<string, string>, key: string): string | null {
  return headers[key.toLowerCase()] ?? null;
}
