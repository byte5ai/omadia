import { z } from 'zod';

import { analyzePage } from './analyzers/onPage.js';
import { analyzeTechnical } from './analyzers/technical.js';
import { crawlAndAudit } from './analyzers/crawler.js';
import type { createFetcher} from './fetcher.js';
import { extractDocument } from './fetcher.js';
import type {
  PageReport,
  SiteAuditReport,
  TechnicalReport,
} from './types.js';

export interface ToolDescriptor<I, O> {
  readonly id: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  run(input: I): Promise<O>;
}

export interface Toolkit {
  readonly tools: readonly ToolDescriptor<unknown, unknown>[];
  getTool<I = unknown, O = unknown>(id: string): ToolDescriptor<I, O> | undefined;
  close(): Promise<void>;
}

export interface ToolkitOptions {
  fetcher: ReturnType<typeof createFetcher>;
  targetBaseUrl: string;
  userAgent: string;
  crawlMaxPages: number;
  crawlMaxDepth: number;
  log: (...args: unknown[]) => void;
}

const analyzePageInput = z.object({
  url: z.string().url(),
});

const checkTechnicalInput = z.object({
  base_url: z.string().url().optional(),
});

const auditSiteInput = z.object({
  start_url: z.string().url().optional(),
  max_pages: z.number().int().min(1).max(100).optional(),
  max_depth: z.number().int().min(1).max(5).optional(),
});

export function createToolkit(opts: ToolkitOptions): Toolkit {
  const tools: ToolDescriptor<unknown, unknown>[] = [
    {
      id: 'analyze_page',
      description:
        'Lädt eine URL und liefert einen strukturierten On-Page-SEO-Report (Meta, Headings, Links, Bilder, JSON-LD, Score).',
      input: analyzePageInput as z.ZodType<unknown>,
      async run(raw): Promise<PageReport> {
        const { url } = analyzePageInput.parse(raw);
        opts.log('tool:analyze_page', { url });
        const res = await opts.fetcher.get(url, true);
        if (res.status === 0) {
          throw new Error(`fetch failed for ${url}`);
        }
        const doc = extractDocument(res.body);
        return analyzePage(res, doc);
      },
    },
    {
      id: 'check_technical_seo',
      description:
        'Prüft robots.txt, sitemap.xml, HTTPS-Config und Security-Header für die angegebene (oder konfigurierte) Domain.',
      input: checkTechnicalInput as z.ZodType<unknown>,
      async run(raw): Promise<TechnicalReport> {
        const { base_url } = checkTechnicalInput.parse(raw);
        const target = base_url ?? opts.targetBaseUrl;
        opts.log('tool:check_technical_seo', { target });
        return analyzeTechnical(opts.fetcher, target, opts.userAgent);
      },
    },
    {
      id: 'audit_site',
      description:
        'Crawlt die Domain (BFS, depth- und count-begrenzt) und aggregiert On-Page-Issues über alle gefundenen Seiten.',
      input: auditSiteInput as z.ZodType<unknown>,
      async run(raw): Promise<SiteAuditReport> {
        const { start_url, max_pages, max_depth } = auditSiteInput.parse(raw);
        const target = start_url ?? opts.targetBaseUrl;
        const maxPages = Math.min(max_pages ?? opts.crawlMaxPages, 100);
        const maxDepth = Math.min(max_depth ?? opts.crawlMaxDepth, 5);
        opts.log('tool:audit_site', { target, maxPages, maxDepth });
        return crawlAndAudit({
          fetcher: opts.fetcher,
          startUrl: target,
          maxPages,
          maxDepth,
          log: opts.log,
        });
      },
    },
  ];

  const byId = new Map(tools.map((t) => [t.id, t]));
  return {
    tools,
    getTool<I = unknown, O = unknown>(id: string) {
      return byId.get(id) as ToolDescriptor<I, O> | undefined;
    },
    async close() {
      // Fetcher ist stateless — nichts zu schließen. Hook bleibt für zukünftige
      // Client-Pools (persistent HTTP-Agent, Cache) bestehen.
    },
  };
}
