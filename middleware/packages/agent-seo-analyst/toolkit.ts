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
  /** #91 — operator-selected audit mode, woven into the blocked-host error
   *  message so the agent reports honestly instead of substituting a URL. */
  auditMode: string;
  log: (...args: unknown[]) => void;
}

const analyzePageInput = z.object({
  url: z.string().url().describe('Vollständige URL der zu prüfenden Seite (https://...).'),
});

const checkTechnicalInput = z.object({
  base_url: z
    .string()
    .url()
    .optional()
    .describe('Domain-Root. Weggelassen → die für diesen Agenten konfigurierte Domain.'),
});

const auditSiteInput = z.object({
  start_url: z
    .string()
    .url()
    .optional()
    .describe('Einstiegs-URL des Crawls. Weggelassen → die konfigurierte Domain.'),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Seiten-Obergrenze, 1–100. Weggelassen → der konfigurierte Wert.'),
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('Crawl-Tiefe ab der Einstiegs-URL, 1–5. Weggelassen → der konfigurierte Wert.'),
});

export function createToolkit(opts: ToolkitOptions): Toolkit {
  const tools: ToolDescriptor<unknown, unknown>[] = [
    {
      id: 'analyze_page',
      description:
        'Lädt eine einzelne URL und liefert einen strukturierten On-Page-SEO-' +
        'Report (Meta, Headings, Links, Bilder, JSON-LD, Score). Nutze das Tool ' +
        'für eine konkrete Seite; für eine ganze Domain `audit_site`. Liegt der ' +
        'Host außerhalb des erlaubten Audit-Modus, schlägt der Call mit einem ' +
        'Fehler fehl und es wird NICHTS analysiert — dann muss der Operator den ' +
        'Audit-Modus weiten oder den Host freigeben.',
      input: analyzePageInput as z.ZodType<unknown>,
      async run(raw): Promise<PageReport> {
        const { url } = analyzePageInput.parse(raw);
        opts.log('tool:analyze_page', { url });
        const res = await opts.fetcher.get(url, true);
        if (res.blocked !== undefined) {
          throw new Error(
            `${res.blocked} (audit mode: ${opts.auditMode}). The requested ` +
              'URL was NOT analysed — ask the operator to widen the audit ' +
              'mode or add the host to the allow-list.',
          );
        }
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
        'Prüft robots.txt, sitemap.xml, HTTPS-Config und Security-Header einer ' +
        'Domain. Nutze das Tool bei Fragen zu Crawlbarkeit, Indexierung oder ' +
        'Transport-Sicherheit. Ohne `base_url` läuft die Prüfung gegen die für ' +
        'diesen Agenten konfigurierte Domain.',
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
        'Crawlt eine Domain per BFS und aggregiert die On-Page-Issues über alle ' +
        'gefundenen Seiten. Nutze das Tool für domainweite Fragen; für eine ' +
        'einzelne Seite `analyze_page`. Der Crawl ist immer begrenzt: maximal ' +
        '100 Seiten und Tiefe 5, höhere Werte werden auf diese Grenzen gekappt. ' +
        'Ohne `start_url` startet er auf der konfigurierten Domain.',
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
      // Fetcher is stateless — nothing to close. Hook remains for future
      // client pools (persistent HTTP-Agent, cache).
    },
  };
}
