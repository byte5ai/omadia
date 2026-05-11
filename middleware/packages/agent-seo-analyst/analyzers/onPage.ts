import type {
  ExtractedDocument,
  FetchResult,
} from '../fetcher.js';
import type {
  HeadingReport,
  ImageReport,
  LinkReport,
  PageMeta,
  PageReport,
  SeoIssue,
} from '../types.js';
import { scorePage } from './scoring.js';

const MAX_LINK_SAMPLES = 10;
const MAX_IMAGE_SAMPLES = 10;

export function analyzePage(fetched: FetchResult, doc: ExtractedDocument): PageReport {
  const meta = buildMeta(doc);
  const headings = buildHeadings(doc);
  const links = buildLinks(doc, fetched.finalUrl);
  const images = buildImages(doc);

  const issues: SeoIssue[] = [
    ...metaIssues(meta),
    ...headingIssues(headings),
    ...linkIssues(links),
    ...imageIssues(images),
    ...structuredDataIssues(doc.jsonLd),
  ];

  const score = scorePage({ meta, headings, links, images, jsonLd: doc.jsonLd, issues });

  return {
    url: fetched.finalUrl,
    status: fetched.status,
    bytes: fetched.bytes,
    fetched_at: new Date().toISOString(),
    content_type: fetched.contentType,
    meta,
    headings,
    links,
    images,
    structured_data: doc.jsonLd,
    issues,
    score,
  };
}

function buildMeta(doc: ExtractedDocument): PageMeta {
  const pick = (name: string): string | null => {
    const hit = doc.metas.find((m) => m.name?.toLowerCase() === name);
    return hit?.content ?? null;
  };
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  for (const m of doc.metas) {
    if (m.property?.toLowerCase().startsWith('og:') && m.content) {
      og[m.property.toLowerCase()] = m.content;
    }
    if (m.name?.toLowerCase().startsWith('twitter:') && m.content) {
      twitter[m.name.toLowerCase()] = m.content;
    }
  }
  const canonical = doc.linkTags.find((l) => l.rel?.toLowerCase() === 'canonical')?.href ?? null;
  const hreflang = doc.linkTags
    .filter((l) => l.rel?.toLowerCase() === 'alternate' && l.hreflang && l.href)
    .map((l) => ({ lang: l.hreflang as string, href: l.href as string }));
  const charsetMeta = doc.metas.find((m) => m.charset);
  const description = pick('description');
  const title = doc.title;
  return {
    title,
    title_length: title?.length ?? 0,
    description,
    description_length: description?.length ?? 0,
    canonical,
    robots: pick('robots'),
    viewport: pick('viewport'),
    charset: charsetMeta?.charset ?? null,
    og,
    twitter,
    hreflang,
  };
}

function buildHeadings(doc: ExtractedDocument): HeadingReport {
  const counts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 } as HeadingReport['counts'];
  const h1_texts: string[] = [];
  const order: string[] = [];
  for (const h of doc.headings) {
    const key = `h${h.level}` as keyof typeof counts;
    counts[key] += 1;
    order.push(key);
    if (h.level === 1) h1_texts.push(h.text);
  }
  return { counts, h1_texts, order };
}

function buildLinks(doc: ExtractedDocument, pageUrl: string): LinkReport {
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).host;
  } catch {
    pageHost = '';
  }
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  let empty = 0;
  const samples: LinkReport['samples'] = [];

  for (const a of doc.anchors) {
    if (!a.href || a.href.startsWith('#') || a.href.startsWith('mailto:') || a.href.startsWith('tel:')) continue;
    let resolved: URL | null = null;
    try {
      resolved = new URL(a.href, pageUrl);
    } catch {
      continue;
    }
    const isExternal = !!pageHost && resolved.host !== pageHost;
    if (isExternal) external += 1;
    else internal += 1;
    if ((a.rel ?? '').toLowerCase().split(/\s+/).includes('nofollow')) nofollow += 1;
    if (!a.text) empty += 1;
    if (samples.length < MAX_LINK_SAMPLES) {
      samples.push({ href: resolved.toString(), text: a.text, rel: a.rel, external: isExternal });
    }
  }

  return {
    total: internal + external,
    internal,
    external,
    nofollow,
    empty_anchors: empty,
    samples,
  };
}

function buildImages(doc: ExtractedDocument): ImageReport {
  let missingAlt = 0;
  let emptySrc = 0;
  let lazy = 0;
  const samples: ImageReport['samples'] = [];
  for (const img of doc.images) {
    if (!img.src) emptySrc += 1;
    if (img.alt === null || img.alt === undefined) missingAlt += 1;
    if ((img.loading ?? '').toLowerCase() === 'lazy') lazy += 1;
    if (samples.length < MAX_IMAGE_SAMPLES) samples.push(img);
  }
  return {
    total: doc.images.length,
    missing_alt: missingAlt,
    empty_src: emptySrc,
    lazy_loaded: lazy,
    samples,
  };
}

function metaIssues(meta: PageMeta): SeoIssue[] {
  const out: SeoIssue[] = [];
  if (!meta.title) {
    out.push({ severity: 'error', code: 'meta.title.missing', message: 'Kein <title>-Tag gefunden.' });
  } else if (meta.title_length < 20) {
    out.push({
      severity: 'warning',
      code: 'meta.title.short',
      message: `Title ist nur ${meta.title_length} Zeichen.`,
      hint: 'Ziel: 30-60 Zeichen.',
    });
  } else if (meta.title_length > 65) {
    out.push({
      severity: 'warning',
      code: 'meta.title.long',
      message: `Title ist ${meta.title_length} Zeichen — wird im SERP gekürzt.`,
    });
  }

  if (!meta.description) {
    out.push({
      severity: 'warning',
      code: 'meta.description.missing',
      message: 'Kein <meta name="description"> gefunden.',
    });
  } else if (meta.description_length < 70) {
    out.push({
      severity: 'info',
      code: 'meta.description.short',
      message: `Description nur ${meta.description_length} Zeichen.`,
    });
  } else if (meta.description_length > 160) {
    out.push({
      severity: 'warning',
      code: 'meta.description.long',
      message: `Description ${meta.description_length} Zeichen — wird im SERP gekürzt.`,
    });
  }

  if (!meta.canonical) {
    out.push({
      severity: 'warning',
      code: 'meta.canonical.missing',
      message: 'Kein <link rel="canonical"> gesetzt.',
    });
  }
  if (!meta.viewport) {
    out.push({
      severity: 'warning',
      code: 'meta.viewport.missing',
      message: 'Kein Viewport-Meta-Tag — Mobile-Rendering nicht optimiert.',
    });
  }
  if (!meta.og['og:title'] && !meta.og['og:image']) {
    out.push({
      severity: 'info',
      code: 'meta.og.missing',
      message: 'Keine Open-Graph-Tags — Social-Preview wird generisch.',
    });
  }
  return out;
}

function headingIssues(h: HeadingReport): SeoIssue[] {
  const out: SeoIssue[] = [];
  if (h.counts.h1 === 0) {
    out.push({ severity: 'error', code: 'headings.h1.missing', message: 'Keine H1 auf der Seite.' });
  } else if (h.counts.h1 > 1) {
    out.push({
      severity: 'warning',
      code: 'headings.h1.multiple',
      message: `${h.counts.h1} H1-Tags gefunden — eine H1 pro Seite ist Standard.`,
    });
  }
  if (h.counts.h2 === 0 && h.counts.h1 > 0) {
    out.push({
      severity: 'info',
      code: 'headings.h2.missing',
      message: 'Keine H2 — Content-Struktur flach.',
    });
  }
  return out;
}

function linkIssues(links: LinkReport): SeoIssue[] {
  const out: SeoIssue[] = [];
  if (links.empty_anchors > 0) {
    out.push({
      severity: 'warning',
      code: 'links.empty_anchor',
      message: `${links.empty_anchors} Links ohne Anchor-Text.`,
    });
  }
  if (links.internal === 0 && links.total > 0) {
    out.push({
      severity: 'info',
      code: 'links.internal.none',
      message: 'Keine internen Links — schwache interne Verlinkung.',
    });
  }
  return out;
}

function imageIssues(images: ImageReport): SeoIssue[] {
  const out: SeoIssue[] = [];
  if (images.missing_alt > 0) {
    out.push({
      severity: 'warning',
      code: 'images.alt.missing',
      message: `${images.missing_alt} Bilder ohne alt-Attribut.`,
      hint: 'alt="" ist erlaubt für dekorative Bilder — einfach das Attribut setzen.',
    });
  }
  if (images.empty_src > 0) {
    out.push({
      severity: 'error',
      code: 'images.src.empty',
      message: `${images.empty_src} Bilder mit leerem src.`,
    });
  }
  return out;
}

function structuredDataIssues(jsonLd: unknown[]): SeoIssue[] {
  if (jsonLd.length === 0) {
    return [
      {
        severity: 'info',
        code: 'jsonld.missing',
        message: 'Kein JSON-LD-Structured-Data gefunden.',
        hint: 'Organization / WebSite / BreadcrumbList sind Standard.',
      },
    ];
  }
  const invalid = jsonLd.filter((x) => (x as { _invalid_json?: boolean })._invalid_json).length;
  if (invalid > 0) {
    return [
      {
        severity: 'error',
        code: 'jsonld.invalid',
        message: `${invalid} JSON-LD-Block(e) sind kein gültiges JSON.`,
      },
    ];
  }
  return [];
}
