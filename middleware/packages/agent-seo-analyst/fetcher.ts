export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  contentType: string | null;
  redirected: boolean;
}

export interface FetcherOptions {
  userAgent: string;
  timeoutMs: number;
  log: (...args: unknown[]) => void;
}

export function createFetcher(opts: FetcherOptions) {
  async function get(url: string, acceptHtml = true): Promise<FetchResult> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'user-agent': opts.userAgent,
          accept: acceptHtml
            ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1'
            : '*/*',
        },
      });
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return {
        url,
        finalUrl: res.url,
        status: res.status,
        headers,
        body,
        bytes: new TextEncoder().encode(body).length,
        contentType: res.headers.get('content-type'),
        redirected: res.redirected,
      };
    } catch (err) {
      opts.log('fetch error', { url, err: String(err) });
      return {
        url,
        finalUrl: url,
        status: 0,
        headers: {},
        body: '',
        bytes: 0,
        contentType: null,
        redirected: false,
      };
    } finally {
      clearTimeout(t);
    }
  }

  return { get };
}

// ---------------------------------------------------------------------------
// Minimal HTML-Extractor (regex-based).
//
// Deliberately without cheerio / linkedom because the package is meant to be
// a peerDependency-free reference for the upload format. For SEO evaluations
// (meta tags, heading counts, links, images, JSON-LD blocks) this suffices;
// for DOM traversal / CSS-selectors a real parser would be mandatory.
// ---------------------------------------------------------------------------

export interface MetaTag {
  name: string | null;
  property: string | null;
  content: string | null;
  httpEquiv: string | null;
  charset: string | null;
}

export interface LinkTag {
  rel: string | null;
  href: string | null;
  hreflang: string | null;
  type: string | null;
}

export interface ExtractedDocument {
  title: string | null;
  lang: string | null;
  metas: MetaTag[];
  linkTags: LinkTag[];
  headings: { level: number; text: string }[];
  anchors: { href: string; text: string; rel: string | null }[];
  images: { src: string; alt: string | null; loading: string | null }[];
  jsonLd: unknown[];
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const key = m[1];
    if (!key) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out[key.toLowerCase()] = decodeEntities(value);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim().replace(/\s+/g, ' ');
}

export function extractDocument(html: string): ExtractedDocument {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1] ? stripTags(titleMatch[1]) : null;

  const htmlTagMatch = /<html\b([^>]*)>/i.exec(html);
  const lang = htmlTagMatch?.[1] ? (parseAttrs(htmlTagMatch[1])['lang'] ?? null) : null;

  const metas: MetaTag[] = [];
  const metaRe = /<meta\b([^>]*)\/?>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(html)) !== null) {
    const attrs = parseAttrs(mm[1] ?? '');
    metas.push({
      name: attrs['name'] ?? null,
      property: attrs['property'] ?? null,
      content: attrs['content'] ?? null,
      httpEquiv: attrs['http-equiv'] ?? null,
      charset: attrs['charset'] ?? null,
    });
  }

  const linkTags: LinkTag[] = [];
  const linkRe = /<link\b([^>]*)\/?>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null) {
    const attrs = parseAttrs(lm[1] ?? '');
    linkTags.push({
      rel: attrs['rel'] ?? null,
      href: attrs['href'] ?? null,
      hreflang: attrs['hreflang'] ?? null,
      type: attrs['type'] ?? null,
    });
  }

  const headings: { level: number; text: string }[] = [];
  const headingRe = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(html)) !== null) {
    const tag = hm[1]?.toLowerCase();
    if (!tag) continue;
    headings.push({ level: Number(tag[1]), text: stripTags(hm[2] ?? '') });
  }

  const anchors: { href: string; text: string; rel: string | null }[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(html)) !== null) {
    const attrs = parseAttrs(am[1] ?? '');
    const href = attrs['href'];
    if (!href) continue;
    anchors.push({ href, text: stripTags(am[2] ?? ''), rel: attrs['rel'] ?? null });
  }

  const images: { src: string; alt: string | null; loading: string | null }[] = [];
  const imgRe = /<img\b([^>]*)\/?>/gi;
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(html)) !== null) {
    const attrs = parseAttrs(im[1] ?? '');
    images.push({
      src: attrs['src'] ?? '',
      alt: attrs['alt'] ?? null,
      loading: attrs['loading'] ?? null,
    });
  }

  const jsonLd: unknown[] = [];
  const ldRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jm: RegExpExecArray | null;
  while ((jm = ldRe.exec(html)) !== null) {
    const raw = (jm[1] ?? '').trim();
    if (!raw) continue;
    try {
      jsonLd.push(JSON.parse(raw));
    } catch {
      jsonLd.push({ _invalid_json: true, _raw_length: raw.length });
    }
  }

  return { title, lang, metas, linkTags, headings, anchors, images, jsonLd };
}
