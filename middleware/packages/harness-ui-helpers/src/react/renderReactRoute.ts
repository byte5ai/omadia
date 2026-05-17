/**
 * renderReactRoute (B.12-4) — React-SSR helper for plugin UI-routes.
 *
 * Bridges the React-Component world to the Express-Plugin world. Plugin
 * authors write a TSX component (typed Props in, JSX out); this helper
 * renders it to a complete HTML document via `react-dom/server`'s
 * `renderToString`, wraps in the same iframe-safe Tailwind shell that
 * `renderRoute` uses for HTML pages, and sets the same CSP headers.
 *
 * Pilot-phase choices (consistent with SPIKE-2026-05-15 Finding 7):
 *   - `renderToString` (sync). Acceptable for Pilot. Phase 2 migrates to
 *     `renderToPipeableStream` if concurrent-tab-load latency becomes
 *     measurable.
 *   - Tailwind via CDN — same as library/free-form-html modes. Phase 2
 *     adds a per-plugin PostCSS-build that purges + bundles, served as
 *     `/p/<id>/static/<id>.css`. The schema is forward-compatible.
 *   - No client-side hydration (B.12 enforces `interactive=false`).
 *     `renderToString` output is statically delivered; B.13 will swap in
 *     hydratable output when a use-case lands.
 *
 * The factory signature returns an Express `RouteHandler` so the codegen-
 * emitted UiRouter can wire it straight into `router.get(...)` — symmetric
 * to `renderRoute()` for html-string handlers.
 */

import type { ComponentType, ReactElement } from 'react';
import type * as ReactNS from 'react';
import type * as ReactDOMServerNS from 'react-dom/server';

import { withIframeSafeHeaders, type RouteHandler } from '../route.js';
import { escapeHtml } from '../html.js';

// B.12-4 / B.13 — react + react-dom are OPTIONAL peerDependencies (see
// package.json peerDependenciesMeta). Plugins without react-ssr ui_routes
// never call renderReactRoute(), so they should never trigger the react
// resolution. Importing `react` at the top of this module would fail at
// MODULE-LOAD time for those plugins (the helper's index.js re-exports
// renderReactRoute and that re-export triggers evaluation of this file).
//
// To keep the no-react path zero-cost we defer the react imports until
// renderReactRoute() is actually invoked. Plugins that DO use react-ssr
// have react/react-dom@^18 declared in their codegen-emitted package.json
// peerDeps, and the host's BUILD_TIME_ONLY_DEPS provisions them at install
// time so this dynamic import succeeds in production.
let reactModule: typeof ReactNS | null = null;
let reactDomServerModule: typeof ReactDOMServerNS | null = null;

async function loadReact(): Promise<{
  createElement: (typeof ReactNS)['createElement'];
  renderToString: (typeof ReactDOMServerNS)['renderToString'];
}> {
  if (!reactModule) reactModule = await import('react');
  if (!reactDomServerModule) reactDomServerModule = await import('react-dom/server');
  return {
    createElement: reactModule.createElement,
    renderToString: reactDomServerModule.renderToString,
  };
}

const TAILWIND_CDN_URL = 'https://cdn.tailwindcss.com';

export interface RenderReactRouteOptions<P> {
  /** Props passed to the Component when SSR renders. */
  readonly props: P;
  /** `<title>` content + page heading. */
  readonly pageTitle: string;
  /** Auto-refresh interval (seconds). 0 disables. Maps to a
   *  `<meta http-equiv="refresh">` — same simple full-reload mechanism
   *  as `htmlDoc({ refreshSeconds })`. */
  readonly refreshSeconds?: number;
  /** Optional external stylesheet URL — when Phase 2 adds a built
   *  Tailwind bundle per plugin, codegen passes the static-asset URL
   *  here and `tailwind: 'none'` to drop the CDN. */
  readonly cssHref?: string;
  /** Tailwind delivery. Default: 'cdn'. */
  readonly tailwind?: 'cdn' | 'none';
  /** HTML <html lang="…"> attribute. Default 'en'. */
  readonly lang?: string;
  /** B.13 — Client-Side-Hydration. When set, the SSR output gets an
   *  importmap (esm.sh → React + ReactDOM/client) plus a module-script
   *  that imports the component from `componentUrl` and calls
   *  `hydrateRoot(...)` against the SSR'd DOM. Without this, the page
   *  is SSR-only and `interactive=false` in the spec stays in effect.
   *
   *  Constraints:
   *    - `componentUrl` MUST be an absolute path served by the plugin
   *      (e.g. `/p/de.byte5.agent.foo/static/components/inboxPage.js`).
   *      The codegen wires `express.static(...)` to make this URL live.
   *    - The component's default export must accept `props` as its
   *      first argument — same signature as the SSR call. Hydration
   *      passes a JSON-roundtrip of the SSR props so server + client
   *      Component see the same input.
   *    - React 18 + react-dom@18 are loaded via esm.sh CDN (matches
   *      the plugin's peerDep range). No per-plugin bundler step.
   */
  readonly hydration?: {
    /** Stable id for the hydration root container. Matches the
     *  `data-omadia-page` attribute that codegen adds at the component
     *  root — used by the client script to find the mount node. */
    readonly pageId: string;
    /** Absolute URL where the plugin serves the compiled component
     *  module (default-export the React component). */
    readonly componentUrl: string;
    /** React version pinned in the importmap. Default '18.3.1'. */
    readonly reactVersion?: string;
  };
}

/**
 * Render a React component to a complete HTML document, suitable as the
 * return value of an Express `router.get(...)` handler.
 *
 * Returns a `RouteHandler` (the same type `renderRoute` produces) so the
 * codegen-emitted UiRouter wires it identically: `router.get(path,
 * renderReactRoute(Page, opts))`.
 */
export function renderReactRoute<P>(
  Component: ComponentType<P>,
  opts: RenderReactRouteOptions<P>,
): RouteHandler {
  return async ({ res }) => {
    withIframeSafeHeaders(res);
    const { createElement, renderToString } = await loadReact();
    const element: ReactElement = createElement(
      Component as ComponentType<unknown>,
      opts.props as unknown as Record<string, unknown>,
    );
    const rendered = renderToString(element);
    const wrapped = wrapInHtmlDocument(rendered, opts);
    // Write the response here instead of relying on the caller. The codegen-
    // emitted route handler (`routes/<id>UiRouter.tsx`) does
    //   `await renderReactRoute(...)({ req, res, params, query })`
    // and treats the returned value as unused — without an explicit `res.send`
    // the Express response would never end and the client would hang until
    // its timeout fired (verified live: SSR completed in 2ms, proxy still
    // hung for the full 30s). `renderRoute` (the library/free-form-html
    // wrapper) does the same dance — `res.type('html').send(result)` after
    // the handler returns — so this aligns the two render modes.
    // Defensive: if the operator's component (via a nested handler call)
    // already wrote to res, don't double-send.
    if (!res.headersSent && !res.writableEnded) {
      res.type('html').send(wrapped);
    }
    return wrapped;
  };
}

const DEFAULT_REACT_VERSION = '18.3.1';

/**
 * Builds the importmap + module-script block that turns an SSR'd page
 * into a hydrated one. Exported for tests; renderReactRoute calls this
 * internally when `opts.hydration` is set.
 *
 * Security note: `props` are JSON-stringified into a `<script type=
 * "application/json">` block. `JSON.stringify` with no replacer is
 * safe from `</script>` injection only when we additionally escape the
 * literal `</` sequence. We do that here so even an operator-controlled
 * string field can't break out of the script tag.
 */
export function buildHydrationScripts<P>(
  hydration: NonNullable<RenderReactRouteOptions<P>['hydration']>,
  props: P,
): string {
  const reactVersion = hydration.reactVersion ?? DEFAULT_REACT_VERSION;
  // Escape both `<` and `>` in the JSON-block: even with the JSON content-
  // type, browser-parsers historically treat `</` as an early script-tag
  // close. Belt-and-braces — the same `<` → `<` escape is also
  // standard for `<script type="application/json">` blocks.
  const propsJson = JSON.stringify(props ?? {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
  return [
    `<script type="application/json" id="__OMADIA_PROPS_${escapeHtml(hydration.pageId)}">${propsJson}</script>`,
    '<script type="importmap">',
    JSON.stringify({
      imports: {
        react: `https://esm.sh/react@${reactVersion}`,
        'react/jsx-runtime': `https://esm.sh/react@${reactVersion}/jsx-runtime`,
        'react-dom/client': `https://esm.sh/react-dom@${reactVersion}/client`,
      },
    }),
    '</script>',
    `<script type="module">`,
    `Promise.all([`,
    `  import('react'),`,
    `  import('react-dom/client'),`,
    `  import(${JSON.stringify(hydration.componentUrl)}),`,
    `]).then(([React, ReactDOMClient, PageModule]) => {`,
    `  const propsEl = document.getElementById('__OMADIA_PROPS_${hydration.pageId}');`,
    `  const props = propsEl ? JSON.parse(propsEl.textContent || '{}') : {};`,
    `  const root = document.querySelector('[data-omadia-page=' + JSON.stringify(${JSON.stringify(hydration.pageId)}) + ']');`,
    `  if (root) {`,
    `    ReactDOMClient.hydrateRoot(root, React.createElement(PageModule.default, props));`,
    `  }`,
    `}).catch((err) => {`,
    `  console.error('[omadia] hydration failed', err);`,
    `});`,
    `</script>`,
  ].join('');
}

/**
 * Exported for tests + advanced callers that want the assembled HTML
 * without going through Express (e.g. building static snapshots). The
 * runtime path uses `renderReactRoute` above which calls this internally.
 */
export function wrapInHtmlDocument<P>(
  innerHtml: string,
  opts: RenderReactRouteOptions<P>,
): string {
  const lang = opts.lang ?? 'en';
  const title = escapeHtml(opts.pageTitle);
  // B.13 — meta-refresh and client-side hydration are mutually exclusive:
  // a meta-refresh blows away any hydrated React state every N seconds.
  // When `hydration` is set, the client owns refresh semantics (SWR /
  // event-driven re-render). The refresh setting is silently dropped.
  const refresh =
    !opts.hydration &&
    typeof opts.refreshSeconds === 'number' &&
    opts.refreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${Math.floor(opts.refreshSeconds)}">`
      : '';
  const tailwind = opts.tailwind ?? 'cdn';
  const tailwindTag =
    tailwind === 'cdn' ? `<script src="${TAILWIND_CDN_URL}"></script>` : '';
  const cssLink = opts.cssHref
    ? `<link rel="stylesheet" href="${escapeHtml(opts.cssHref)}">`
    : '';
  const hydrationBlock = opts.hydration
    ? buildHydrationScripts(opts.hydration, opts.props)
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
    cssLink,
    '</head>',
    '<body class="bg-slate-50 text-slate-900 antialiased">',
    innerHtml,
    hydrationBlock,
    '</body>',
    '</html>',
  ].join('');
}
