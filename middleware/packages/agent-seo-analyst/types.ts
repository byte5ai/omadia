/**
 * PluginContext kommt aus dem shared Kontrakt @omadia/plugin-api.
 * Re-Export hier, damit lokale Files weiter `./types.js`-Imports nutzen
 * können — kein Strukturtyp-Duplikat mehr, keine Cross-Package-Drift.
 */
export type { PluginContext } from '@omadia/plugin-api';

export interface PageMeta {
  title: string | null;
  title_length: number;
  description: string | null;
  description_length: number;
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  charset: string | null;
  og: Record<string, string>;
  twitter: Record<string, string>;
  hreflang: { lang: string; href: string }[];
}

export interface HeadingReport {
  counts: Record<'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', number>;
  h1_texts: string[];
  order: string[];
}

export interface LinkReport {
  total: number;
  internal: number;
  external: number;
  nofollow: number;
  empty_anchors: number;
  samples: { href: string; text: string; rel: string | null; external: boolean }[];
}

export interface ImageReport {
  total: number;
  missing_alt: number;
  empty_src: number;
  lazy_loaded: number;
  samples: { src: string; alt: string | null; loading: string | null }[];
}

export interface SeoIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  hint?: string;
}

export interface SeoScore {
  value: number;
  max: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: { area: string; points: number; max: number }[];
}

export interface PageReport {
  url: string;
  status: number;
  bytes: number;
  fetched_at: string;
  content_type: string | null;
  meta: PageMeta;
  headings: HeadingReport;
  links: LinkReport;
  images: ImageReport;
  structured_data: unknown[];
  issues: SeoIssue[];
  score: SeoScore;
}

export interface RobotsReport {
  fetched: boolean;
  status: number | null;
  sitemaps: string[];
  user_agents: string[];
  disallows_root: boolean;
  allows_our_ua: boolean;
  raw_length: number;
}

export interface SitemapEntry {
  url: string;
  status: number;
  url_count: number | null;
  is_index: boolean;
  errors: string[];
}

export interface TechnicalReport {
  base_url: string;
  robots: RobotsReport;
  sitemaps: SitemapEntry[];
  https: {
    uses_https: boolean;
    http_redirects_to_https: boolean | null;
  };
  headers: {
    x_robots_tag: string | null;
    strict_transport_security: string | null;
    content_security_policy_present: boolean;
    x_frame_options: string | null;
  };
  issues: SeoIssue[];
  score: SeoScore;
}

export interface SiteAuditReport {
  start_url: string;
  pages_analyzed: number;
  max_pages: number;
  max_depth: number;
  stopped_reason: 'budget' | 'no_more_links' | 'error';
  per_page: { url: string; status: number; score: number; issue_count: number }[];
  aggregate_issues: { code: string; count: number; severity: SeoIssue['severity']; message: string }[];
  score: SeoScore;
}
