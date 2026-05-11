import { extractDocument, type createFetcher } from '../fetcher.js';
import type { SeoIssue, SiteAuditReport } from '../types.js';
import { analyzePage } from './onPage.js';
import { scoreSiteAudit } from './scoring.js';

type Fetcher = ReturnType<typeof createFetcher>;

export interface CrawlOptions {
  fetcher: Fetcher;
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  log: (...args: unknown[]) => void;
}

export async function crawlAndAudit(opts: CrawlOptions): Promise<SiteAuditReport> {
  const start = normalizeStart(opts.startUrl);
  const startHost = new URL(start).host;

  const seen = new Set<string>([start]);
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  const pages: SiteAuditReport['per_page'] = [];
  const allIssues: SeoIssue[] = [];
  const pageScores: number[] = [];
  let stoppedReason: SiteAuditReport['stopped_reason'] = 'no_more_links';

  while (queue.length > 0 && pages.length < opts.maxPages) {
    const next = queue.shift();
    if (!next) break;
    const { url, depth } = next;
    opts.log('crawl', { url, depth, pages: pages.length });

    const fetched = await opts.fetcher.get(url, true);
    if (fetched.status !== 200 || !fetched.contentType?.includes('text/html')) {
      pages.push({ url, status: fetched.status, score: 0, issue_count: 0 });
      continue;
    }

    const doc = extractDocument(fetched.body);
    const report = analyzePage(fetched, doc);
    pages.push({
      url: report.url,
      status: report.status,
      score: Math.round((report.score.value / Math.max(1, report.score.max)) * 100),
      issue_count: report.issues.length,
    });
    pageScores.push(report.score.value / Math.max(1, report.score.max) * 100);
    for (const issue of report.issues) allIssues.push(issue);

    if (depth + 1 > opts.maxDepth) continue;

    for (const a of doc.anchors) {
      if (pages.length + queue.length >= opts.maxPages) {
        stoppedReason = 'budget';
        break;
      }
      if (!a.href) continue;
      let target: URL;
      try {
        target = new URL(a.href, fetched.finalUrl);
      } catch {
        continue;
      }
      if (target.host !== startHost) continue;
      if (!['http:', 'https:'].includes(target.protocol)) continue;
      target.hash = '';
      const key = target.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ url: key, depth: depth + 1 });
    }
  }

  if (pages.length >= opts.maxPages) stoppedReason = 'budget';

  const aggregate = aggregateIssues(allIssues);
  const score = scoreSiteAudit(pageScores, allIssues.length);

  return {
    start_url: start,
    pages_analyzed: pages.length,
    max_pages: opts.maxPages,
    max_depth: opts.maxDepth,
    stopped_reason: stoppedReason,
    per_page: pages,
    aggregate_issues: aggregate,
    score,
  };
}

function aggregateIssues(
  issues: SeoIssue[],
): SiteAuditReport['aggregate_issues'] {
  const map = new Map<string, { count: number; severity: SeoIssue['severity']; message: string }>();
  for (const i of issues) {
    const prev = map.get(i.code);
    if (prev) {
      prev.count += 1;
    } else {
      map.set(i.code, { count: 1, severity: i.severity, message: i.message });
    }
  }
  return [...map.entries()]
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.count - a.count);
}

function normalizeStart(u: string): string {
  const parsed = new URL(u);
  parsed.hash = '';
  return parsed.toString();
}
