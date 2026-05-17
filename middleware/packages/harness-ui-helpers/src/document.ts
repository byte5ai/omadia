import { escapeHtml, type HtmlFragment } from './html.js';

export interface HtmlDocOptions {
  title: string;
  body: HtmlFragment;
  lang?: string;
  /** Inline <style> block injected into <head>, after Tailwind. */
  inlineCss?: string;
  /** Tailwind delivery strategy. CDN is fine for SSR-only sketch phase;
   *  swap to a built bundle for production. */
  tailwind?: 'cdn' | 'none';
  /**
   * If set, emits a `<meta http-equiv="refresh" content="N">` so the
   * browser re-fetches the page every N seconds. This is the simplest
   * "self-filling tab" mechanism — the SSR handler renders fresh data
   * each request, so a periodic reload surfaces new state without any
   * client-side JS. Set to a positive integer (seconds); omit for
   * static pages.
   *
   * Note: meta-refresh resets scroll position and any client form
   * state. For richer scenarios swap in a polling fetch+swap pattern
   * later — but for an MVP "show me the latest data" Tab this is
   * one line and zero deps.
   */
  refreshSeconds?: number;
}

const TAILWIND_CDN_URL = 'https://cdn.tailwindcss.com';

/**
 * Wraps a body fragment in a minimal HTML5 document. Tailwind CDN is loaded
 * by default so plugin authors can sketch UIs with utility classes without
 * a per-plugin build step. For production, switch `tailwind: 'none'` and
 * provide a built CSS bundle via inlineCss or a separate route.
 */
export function htmlDoc(options: HtmlDocOptions): string {
  const lang = options.lang ?? 'en';
  const title = escapeHtml(options.title);
  const tailwindTag =
    options.tailwind === 'none'
      ? ''
      : `<script src="${TAILWIND_CDN_URL}"></script>`;
  const inlineCssTag = options.inlineCss
    ? `<style>${options.inlineCss}</style>`
    : '';
  const refresh =
    typeof options.refreshSeconds === 'number' && options.refreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${Math.floor(options.refreshSeconds)}">`
      : '';
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    refresh,
    `<title>${title}</title>`,
    tailwindTag,
    inlineCssTag,
    '</head>',
    '<body class="bg-slate-50 text-slate-900 antialiased">',
    options.body.value,
    '</body>',
    '</html>',
  ].join('');
}
