import type {
  HeadingReport,
  ImageReport,
  LinkReport,
  PageMeta,
  SeoIssue,
  SeoScore,
} from '../types.js';

interface PageScoringInput {
  meta: PageMeta;
  headings: HeadingReport;
  links: LinkReport;
  images: ImageReport;
  jsonLd: unknown[];
  issues: SeoIssue[];
}

export function scorePage(inp: PageScoringInput): SeoScore {
  const parts = [
    metaPart(inp.meta),
    headingsPart(inp.headings),
    linksPart(inp.links),
    imagesPart(inp.images),
    structuredPart(inp.jsonLd),
  ];
  return finalize(parts);
}

export function scoreTechnical(inp: {
  robotsFetched: boolean;
  allowsOurUa: boolean;
  sitemapsCount: number;
  sitemapsOk: boolean;
  httpsOk: boolean;
  hstsPresent: boolean;
  cspPresent: boolean;
  xRobotsIndexable: boolean;
}): SeoScore {
  const parts: SeoScore['breakdown'] = [
    { area: 'robots', points: (inp.robotsFetched ? 5 : 0) + (inp.allowsOurUa ? 5 : 0), max: 10 },
    {
      area: 'sitemap',
      points: inp.sitemapsCount > 0 ? (inp.sitemapsOk ? 10 : 5) : 0,
      max: 10,
    },
    { area: 'https', points: inp.httpsOk ? 10 : 0, max: 10 },
    {
      area: 'headers',
      points: (inp.hstsPresent ? 5 : 0) + (inp.cspPresent ? 3 : 0) + (inp.xRobotsIndexable ? 2 : 0),
      max: 10,
    },
  ];
  return finalize(parts);
}

export function scoreSiteAudit(pageScores: number[], issueCount: number): SeoScore {
  if (pageScores.length === 0) {
    return finalize([{ area: 'coverage', points: 0, max: 100 }]);
  }
  const avg = pageScores.reduce((a, b) => a + b, 0) / pageScores.length;
  const density = Math.min(40, issueCount);
  return finalize([
    { area: 'avg_page_score', points: Math.round(avg * 0.6), max: 60 },
    { area: 'issue_density', points: Math.max(0, 40 - density), max: 40 },
  ]);
}

// ---------------------------------------------------------------------------

function metaPart(meta: PageMeta): SeoScore['breakdown'][number] {
  let p = 0;
  if (meta.title && meta.title_length >= 20 && meta.title_length <= 65) p += 6;
  else if (meta.title) p += 3;
  if (meta.description && meta.description_length >= 70 && meta.description_length <= 160) p += 5;
  else if (meta.description) p += 2;
  if (meta.canonical) p += 3;
  if (meta.viewport) p += 2;
  if (meta.og['og:title'] && meta.og['og:image']) p += 2;
  if (meta.robots && !/noindex/i.test(meta.robots)) p += 2;
  return { area: 'meta', points: p, max: 20 };
}

function headingsPart(h: HeadingReport): SeoScore['breakdown'][number] {
  let p = 0;
  if (h.counts.h1 === 1) p += 10;
  else if (h.counts.h1 >= 2) p += 4;
  if (h.counts.h2 > 0) p += 5;
  if (h.counts.h3 > 0) p += 3;
  if (h.order[0] === 'h1') p += 2;
  return { area: 'headings', points: p, max: 20 };
}

function linksPart(links: LinkReport): SeoScore['breakdown'][number] {
  let p = 0;
  if (links.internal > 0) p += 10;
  if (links.external > 0) p += 3;
  const emptyRatio = links.total > 0 ? links.empty_anchors / links.total : 0;
  if (emptyRatio < 0.1) p += 5;
  else if (emptyRatio < 0.25) p += 2;
  if (links.total >= 3) p += 2;
  return { area: 'links', points: p, max: 20 };
}

function imagesPart(images: ImageReport): SeoScore['breakdown'][number] {
  if (images.total === 0) return { area: 'images', points: 15, max: 20 };
  let p = 0;
  const altRatio = 1 - images.missing_alt / images.total;
  p += Math.round(altRatio * 14);
  if (images.empty_src === 0) p += 3;
  if (images.lazy_loaded > 0) p += 3;
  return { area: 'images', points: Math.max(0, p), max: 20 };
}

function structuredPart(jsonLd: unknown[]): SeoScore['breakdown'][number] {
  let p = 0;
  if (jsonLd.length >= 1) p += 10;
  if (jsonLd.length >= 2) p += 5;
  const invalid = jsonLd.filter((x) => (x as { _invalid_json?: boolean })._invalid_json).length;
  if (invalid === 0 && jsonLd.length > 0) p += 5;
  return { area: 'structured_data', points: p, max: 20 };
}

function finalize(parts: SeoScore['breakdown']): SeoScore {
  const value = parts.reduce((a, p) => a + p.points, 0);
  const max = parts.reduce((a, p) => a + p.max, 0);
  const pct = max === 0 ? 0 : value / max;
  const grade: SeoScore['grade'] =
    pct >= 0.9 ? 'A' : pct >= 0.75 ? 'B' : pct >= 0.6 ? 'C' : pct >= 0.4 ? 'D' : 'F';
  return { value, max, grade, breakdown: parts };
}
