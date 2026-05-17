export { html, escapeHtml, safe } from './html.js';
export type { HtmlFragment } from './html.js';
export { htmlDoc } from './document.js';
export type { HtmlDocOptions } from './document.js';
export { renderRoute, withIframeSafeHeaders } from './route.js';
export type { RouteHandler, RouteContext } from './route.js';

// B.12 — library-mode templates for codegen-generated UiRouters.
export { renderListCard, unwrapItems } from './templates/listCard.js';
export type { ListCardOptions, ListCardItemTemplate } from './templates/listCard.js';
export { renderKpiTiles } from './templates/kpiTiles.js';
export type { KpiTilesOptions, KpiTile } from './templates/kpiTiles.js';
export { interpolate, resolveExpression } from './templates/interpolate.js';
export type { InterpolateOptions } from './templates/interpolate.js';

// B.12-4 — React-SSR helper for codegen-generated react-ssr UiRouters.
// React + react-dom are optional peer-dependencies; the import below is
// only evaluated when a plugin actually uses this helper.
export { renderReactRoute, wrapInHtmlDocument } from './react/renderReactRoute.js';
export type { RenderReactRouteOptions } from './react/renderReactRoute.js';
