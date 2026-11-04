/**
 * Codegen — `spec.ui_routes[]` artifacts (B.12-2).
 *
 * For each UI-route in the spec, synthesise:
 *
 *   - A standalone `routes/<id>UiRouter.ts` (or `.tsx` for react-ssr) file
 *     that exports a `create<Id>UiRouter` factory returning an Express
 *     `Router` instance.
 *
 *   - An auto-managed line-block for the `ui-routes-imports` slot in
 *     plugin.ts (factory imports + `Router` import).
 *
 *   - An auto-managed line-block for the `ui-routes-init` slot in
 *     plugin.ts (factory instantiation, `ctx.routes.register(...)` mount,
 *     `ctx.uiRoutes.register(...)` descriptor wiring, disposer push).
 *
 *   - #1620 — one `routes/teamsTabRouter.ts` per plugin with ≥ 1 ui_route:
 *     the Teams-tab surface under `/p/<slug>/teams` (see
 *     {@link TEAMS_TAB_SEGMENT}). A data-free shell page per route
 *     (`auth: 'public'`) fetches the rendered page from the same ui_route
 *     routers re-mounted under `/p/<slug>/teams/_data` with
 *     `auth: 'teams-sso'`. Codegen also declares `/p/<slug>/teams` in
 *     `manifest.permissions.public_paths` ({@link teamsTabPublicPath}); the
 *     operator still has to grant it.
 *
 *   - Conditional peerDependency additions:
 *       - `@omadia/plugin-ui-helpers` whenever ≥ 1 ui_route exists
 *       - `react` + `react-dom` when ≥ 1 route uses render_mode='react-ssr'
 *         (NOT YET — B.12-2b will land that branch)
 *
 * Render-mode handling in this commit:
 *
 *   - `library`         — fully implemented (list-card + kpi-tiles)
 *   - `free-form-html`  — fully implemented (operator-provided
 *                         `ui-<id>-render` slot interpolated into the
 *                         renderRoute callback body)
 *   - `react-ssr`       — throws CodegenError(NotImplemented). Schema +
 *                         lint reserve the mode; B.12-2b adds the
 *                         renderReactRoute helper + Tailwind-PostCSS-Build.
 */

import { CodegenError } from './codegen.js';
import type { AgentSpec } from './agentSpec.js';
import type { UiRoute } from './uiRouteSchema.js';

export interface UiRouteArtifacts {
  /** Body for the `ui-routes-imports` slot in plugin.ts. Empty when
   *  spec.ui_routes is empty. */
  readonly imports: string;
  /** Body for the `ui-routes-init` slot in plugin.ts. Empty when
   *  spec.ui_routes is empty. */
  readonly init: string;
  /** Files to emit alongside the boilerplate output. Keys are plugin-root-
   *  relative (e.g. `routes/inboxUiRouter.ts`). */
  readonly files: ReadonlyMap<string, Buffer>;
  /** peerDependencies to merge into package.json. Empty when ui_routes
   *  is empty. */
  readonly peerDependencies: Readonly<Record<string, string>>;
  /** True when ≥1 ui_route uses render_mode='react-ssr'. Codegen uses
   *  this to flip jsx: 'react-jsx' in the plugin's tsconfig.json. */
  readonly hasReactSsr: boolean;
}

/**
 * #1620 — the Teams-tab surface of a Builder plugin lives under
 * `/p/<slug>/teams`: one declaration, one operator grant. The session-gated
 * pages at `/p/<slug>/<path>` stay as they are for operators in a browser.
 */
export const TEAMS_TAB_SEGMENT = 'teams';

/** Data routes under the Teams surface. The `_` cannot collide with a
 *  ui_route path — `UiRoutePathSchema` allows only `[a-z0-9-]`. */
export const TEAMS_TAB_DATA_SEGMENT = '_data';

/** `@scope/agent-foo` → `agent-foo`: the `/p/` mount slug, same rule as the
 *  generated `AGENT_ID.replace(/^@[^/]+\//, '')`. */
export function uiRouteMountSlug(agentId: string): string {
  return agentId.replace(/^@[^/]+\//, '');
}

/** `compat.core` of a generated plugin with ui_routes: `'teams-sso'` exists
 *  since `@omadia/plugin-api` 1.51.0. */
export const TEAMS_SSO_MIN_CORE = '>=1.51.0 <2.0';

/** The `permissions.public_paths` entry codegen declares for a plugin with
 *  ui_routes, so its Teams tabs can be granted. */
export function teamsTabPublicPath(agentId: string): string {
  return `/p/${uiRouteMountSlug(agentId)}/${TEAMS_TAB_SEGMENT}`;
}

const EMPTY: UiRouteArtifacts = {
  imports: '',
  init: '',
  files: new Map(),
  peerDependencies: {},
  hasReactSsr: false,
};

/**
 * Top-level entry. Pass `spec`; receive everything codegen needs to
 * splice ui_routes into the output bundle.
 */
export function buildUiRouteArtifacts(
  spec: AgentSpec,
  slots: Readonly<Record<string, string>>,
): UiRouteArtifacts {
  if (spec.ui_routes.length === 0) return EMPTY;

  const files = new Map<string, Buffer>();
  const hasReactSsr = spec.ui_routes.some((r) => r.render_mode === 'react-ssr');

  // plugin.ts-level imports: ONLY the factory functions are needed here.
  // Router itself lives in the routes/* files (it's both type + value
  // there). Earlier versions of this codegen injected `import { Router }
  // from 'express';` at plugin.ts level, which tsc flagged as TS6133
  // (Router declared but never read) — plugin.ts doesn't use Router
  // directly, the factories abstract it.
  const importLines: string[] = [];
  const initLines: string[] = [
    '// Auto-generated by codegen from spec.ui_routes — do not edit by hand.',
    "const __uiMountPath = '/p/' + AGENT_ID.replace(/^@[^/]+\\//, '');",
    'const __runTool = async (id: string, args?: unknown): Promise<unknown> => {',
    '  const tool = toolkit.tools.find((t) => t.id === id);',
    '  if (!tool) {',
    "    throw new Error('ui-route data-binding: tool ' + id + ' not found in toolkit');",
    '  }',
    '  return tool.run((args ?? {}) as never);',
    '};',
    '',
  ];

  const teamsTabPages: string[] = [];
  const teamsTabDataRouters: string[] = [];

  for (const route of spec.ui_routes) {
    const factoryName = factoryNameFor(route.id);

    let routeFileExt: 'ts' | 'tsx';
    switch (route.render_mode) {
      case 'library': {
        const fileContent = renderLibraryFile(route);
        files.set(`routes/${camelize(route.id)}UiRouter.ts`, Buffer.from(fileContent, 'utf-8'));
        routeFileExt = 'ts';
        break;
      }
      case 'free-form-html': {
        const fileContent = renderFreeFormFile(route, slots);
        files.set(`routes/${camelize(route.id)}UiRouter.ts`, Buffer.from(fileContent, 'utf-8'));
        routeFileExt = 'ts';
        break;
      }
      case 'react-ssr': {
        const { routerSrc, componentSrc } = renderReactSsrFiles(route, slots);
        files.set(`routes/${camelize(route.id)}UiRouter.tsx`, Buffer.from(routerSrc, 'utf-8'));
        files.set(`components/${camelize(route.id)}Page.tsx`, Buffer.from(componentSrc, 'utf-8'));
        routeFileExt = 'tsx';
        break;
      }
      default: {
        const _exhaustive: never = route.render_mode;
        throw new CodegenError([
          {
            code: 'spec_validation',
            detail: `unknown render_mode '${String(_exhaustive)}' for route '${route.id}'`,
          },
        ]);
      }
    }

    // The runtime import always references `.js` regardless of source extension;
    // tsc with NodeNext resolves both `.ts` and `.tsx` to `.js` after build.
    importLines.push(
      `import { ${factoryName} } from './routes/${camelize(route.id)}UiRouter.js';`,
    );
    void routeFileExt;

    initLines.push(
      `// ui_route: ${route.id} (mode=${route.render_mode}, path=${route.path})`,
      `const __uiRoute_${camelize(route.id)} = ${factoryName}({ runTool: __runTool, pluginId: AGENT_ID });`,
      `__uiRouteDisposers.push(`,
      // Strip the `@scope/` prefix so the mount path matches the URL
      // convention used by channel-teams' Hub + Tab-Config (uiRouter.ts:56,
      // `pluginId.replace(/^@[^/]+\\//, '')`). Without this, scoped plugin
      // ids like `@omadia/agent-foo` mount at `/p/@omadia/agent-foo/...`
      // while consumers GET `/p/agent-foo/...` → 404.
      // #1596: ui_routes render tool data (employee lists, absences, …), so
      // the browser pages stay behind the omadia session — spelled out
      // instead of relying on the default, so nobody "fixes" a 401 inside a
      // Teams tab by flipping this to 'custom'. Teams reaches the same router
      // through the teams-sso mount below (#1620).
      `  ctx.routes.register(__uiMountPath, __uiRoute_${camelize(route.id)}, { auth: 'session' }),`,
      `);`,
      `__uiRouteDisposers.push(`,
      `  ctx.uiRoutes.register({`,
      `    routeId: ${JSON.stringify(route.id)},`,
      // The descriptor is what channel-teams pins as the tab URL, so it
      // points at the Teams shell, not at the session-gated page.
      `    path: ${JSON.stringify(`/${TEAMS_TAB_SEGMENT}${route.path}`)},`,
      `    title: ${JSON.stringify(route.tab_label)},`,
      `  }),`,
      `);`,
      '',
    );
    teamsTabPages.push(
      `    { path: ${JSON.stringify(route.path)}, title: ${JSON.stringify(route.page_title)} },`,
    );
    teamsTabDataRouters.push(`    __uiRoute_${camelize(route.id)},`);
  }

  // #1620 — Teams tabs. A Teams tab loads its URL as a plain GET without a
  // bearer, so the page itself is a data-free shell ('public'); the data
  // leaves only the 'teams-sso' mount, which the kernel opens for a verified
  // Teams SSO token and nothing else (no session fallback). Both prefixes sit
  // under the ONE declared, operator-granted `public_paths` entry
  // `/p/<slug>/teams`; without the grant neither is served.
  importLines.push(
    "import { createTeamsTabRouters } from './routes/teamsTabRouter.js';",
  );
  files.set('routes/teamsTabRouter.ts', Buffer.from(renderTeamsTabFile(), 'utf-8'));
  initLines.push(
    '// Teams tabs (#1620): data-free shell + teams-sso data mount.',
    `const __teamsTab = createTeamsTabRouters({`,
    `  mountPath: __uiMountPath + ${JSON.stringify(`/${TEAMS_TAB_SEGMENT}`)},`,
    `  dataSegment: ${JSON.stringify(`/${TEAMS_TAB_DATA_SEGMENT}`)},`,
    `  pages: [`,
    ...teamsTabPages,
    `  ],`,
    `  dataRouters: [`,
    ...teamsTabDataRouters,
    `  ],`,
    `});`,
    `__uiRouteDisposers.push(`,
    `  ctx.routes.register(__uiMountPath + ${JSON.stringify(`/${TEAMS_TAB_SEGMENT}`)}, __teamsTab.shell, { auth: 'public' }),`,
    `);`,
    `__uiRouteDisposers.push(`,
    `  ctx.routes.register(__uiMountPath + ${JSON.stringify(`/${TEAMS_TAB_SEGMENT}/${TEAMS_TAB_DATA_SEGMENT}`)}, __teamsTab.data, { auth: 'teams-sso' }),`,
    `);`,
  );

  // Trim trailing blank line in init body
  while (initLines.length > 0 && initLines[initLines.length - 1] === '') {
    initLines.pop();
  }

  // peerDependencies — every ui_route needs plugin-ui-helpers. React +
  // react-dom are added only when ≥1 route uses react-ssr (the
  // peerDependenciesMeta on plugin-ui-helpers marks them optional, so
  // library-/free-form-html-only plugins don't carry the React surface).
  const peerDependencies: Record<string, string> = {
    '@omadia/plugin-ui-helpers': '*',
  };
  if (hasReactSsr) {
    peerDependencies['react'] = '^18.3.1';
    peerDependencies['react-dom'] = '^18.3.1';
  }

  return {
    imports: importLines.join('\n'),
    init: initLines.join('\n'),
    files,
    peerDependencies,
    hasReactSsr,
  };
}

// --- File-content generators per render-mode ------------------------------

function renderLibraryFile(route: UiRoute): string {
  const factoryName = factoryNameFor(route.id);
  const interfaceName = `${pascalize(route.id)}UiRouterOptions`;
  const template = route.ui_template ?? 'list-card';
  const dataBinding = route.data_binding;
  const toolCallArgs = dataBinding?.args
    ? JSON.stringify(dataBinding.args)
    : '{}';

  const renderImport =
    template === 'kpi-tiles' ? 'renderKpiTiles' : 'renderListCard';

  let bodyContent: string;
  if (template === 'kpi-tiles') {
    // renderKpiTiles auto-unwraps `{ tiles: [...] }` / `{ kpis: [...] }`
    // wrappers — pass the raw tool output straight through.
    bodyContent = `body: renderKpiTiles({
        tiles: result,
        fetchError,
      })`;
  } else {
    // list-card — emit item_template literally so the helper interpolates
    // at render-time against each item. renderListCard auto-unwraps
    // wrapper-objects (e.g. `{ prs: [...] }`) and auto-promotes bare-
    // identifier template values (e.g. `"title"` → `"\${item.title}"`).
    const itemTemplate = route.item_template ?? { title: '${item.title}' };
    bodyContent = `body: renderListCard({
        items: result,
        itemTemplate: ${JSON.stringify(itemTemplate, null, 2).replace(/\n/g, '\n        ')},
        fetchError,
      })`;
  }

  const toolId = dataBinding?.tool_id ?? '';
  const dataFetchBlock = toolId
    ? `let result: unknown = [];
    let fetchError: string | null = null;
    try {
      result = await opts.runTool(${JSON.stringify(toolId)}, ${toolCallArgs});
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }`
    : `const result: unknown = [];
    const fetchError: string | null = null;`;

  return `/**
 * Auto-generated by codegen from spec.ui_routes['${route.id}'] (B.12-2).
 * DO NOT EDIT BY HAND — re-run codegen if you need to change the route.
 *
 * render_mode: library
 * ui_template: ${template}
 * path:        ${route.path}
 * tab_label:   ${route.tab_label}
 */

import { Router } from 'express';
import { renderRoute, htmlDoc, ${renderImport} } from '@omadia/plugin-ui-helpers';

export type ToolRunner = (id: string, args?: unknown) => Promise<unknown>;

export interface ${interfaceName} {
  readonly runTool: ToolRunner;
  readonly pluginId: string;
}

export function ${factoryName}(opts: ${interfaceName}): Router {
  // Reference opts so tsc's noUnusedParameters is satisfied even when
  // the route has no data_binding (= no opts.runTool call). pluginId is
  // also part of the contract but only consumed by react-ssr-interactive
  // routes; the void here keeps the signature stable across all
  // library-mode variants without forcing a per-shape conditional.
  void opts;
  const router = Router();
  router.get(${JSON.stringify(route.path)}, renderRoute(async () => {
    ${dataFetchBlock}
    return htmlDoc({
      title: ${JSON.stringify(route.page_title)},
      refreshSeconds: ${String(route.refresh_seconds)},
      ${bodyContent},
    });
  }));
  return router;
}
`;
}

function renderReactSsrFiles(
  route: UiRoute,
  slots: Readonly<Record<string, string>>,
): { routerSrc: string; componentSrc: string } {
  const factoryName = factoryNameFor(route.id);
  const interfaceName = `${pascalize(route.id)}UiRouterOptions`;
  const componentName = `${pascalize(route.id)}Page`;
  const slotKey = `ui-${route.id}-component`;
  const componentSlot = slots[slotKey];
  // B.13 — interactive=true unlocks client-side hydration. The lint-pass
  // gates this to react-ssr-mode (other modes throw a CodegenIssue).
  const hydratable = route.interactive === true;
  if (componentSlot === undefined || componentSlot.trim().length === 0) {
    // Lint catches this earlier (ui_route_react_ssr_missing_component_slot),
    // but defending here keeps the codegen-direct-call path honest.
    throw new CodegenError([
      {
        code: 'missing_required_slot',
        detail:
          `ui_routes['${route.id}'] render_mode='react-ssr' requires slot ` +
          `'${slotKey}' to be filled with a default-exported React Component.`,
      },
    ]);
  }

  const dataBinding = route.data_binding;
  const toolId = dataBinding?.tool_id ?? '';
  const toolCallArgs = dataBinding?.args ? JSON.stringify(dataBinding.args) : '{}';

  const dataFetchBlock = toolId
    ? `let data: unknown = [];
    let fetchError: string | null = null;
    try {
      data = await opts.runTool(${JSON.stringify(toolId)}, ${toolCallArgs});
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }`
    : `const data: unknown = [];
    const fetchError: string | null = null;`;

  const hydrationBlock = hydratable
    ? `,
        hydration: {
          pageId: ${JSON.stringify(route.id)},
          componentUrl: '/p/' + opts.pluginId + '/static/components/${camelize(route.id)}Page.js',
        }`
    : '';

  const staticMountImports = hydratable
    ? `import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
`
    : '';

  const staticMountBody = hydratable
    ? `
  // B.13 — static-serve the compiled component module so the browser-side
  // hydration script can import the SAME default-export the server SSR'd.
  // import.meta.url-derived path resolves to dist/routes/ at runtime; ../
  // walks up to dist/, then /components is the tsc-output dir.
  const __here = path.dirname(fileURLToPath(import.meta.url));
  const __componentsDir = path.resolve(__here, '..', 'components');
  router.use(
    '/static/components',
    express.static(__componentsDir, {
      setHeaders: (res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      },
    }),
  );
`
    : '';

  const routerSrc = `/**
 * Auto-generated by codegen from spec.ui_routes['${route.id}'] (B.12-4 / B.13).
 * DO NOT EDIT BY HAND — re-run codegen if you need to change the route.
 *
 * render_mode: react-ssr
 * interactive: ${String(hydratable)}
 * path:        ${route.path}
 * tab_label:   ${route.tab_label}
 *
 * The accompanying components/${camelize(route.id)}Page.tsx holds the
 * operator-authored Component body (slot '${slotKey}').${
    hydratable
      ? `\n * Hydratable: the SSR HTML carries an importmap (esm.sh React) +\n * a module-script that imports the component from\n * /p/<id>/static/components/${camelize(route.id)}Page.js (served below).`
      : ''
  }
 */

import { Router } from 'express';
${staticMountImports}import { renderReactRoute } from '@omadia/plugin-ui-helpers';
import ${componentName} from '../components/${camelize(route.id)}Page.js';

export type ToolRunner = (id: string, args?: unknown) => Promise<unknown>;

export interface ${interfaceName} {
  readonly runTool: ToolRunner;
  readonly pluginId: string;
}

export function ${factoryName}(opts: ${interfaceName}): Router {
  // Reference opts so tsc's noUnusedParameters is satisfied across all
  // react-ssr shape variants (interactive + non-interactive, with and
  // without data_binding). The hydratable branch references
  // opts.pluginId in the componentUrl; the non-interactive + no-binding
  // branch otherwise wouldn't touch opts at all.
  void opts;
  const router = Router();
${staticMountBody}  router.get(${JSON.stringify(route.path)}, async (req, res, next) => {
    try {
      ${dataFetchBlock}
      const handler = renderReactRoute(${componentName}, {
        props: { data, fetchError },
        pageTitle: ${JSON.stringify(route.page_title)},
        refreshSeconds: ${String(route.refresh_seconds)}${hydrationBlock},
      });
      await handler({ req, res, params: req.params, query: req.query });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
`;

  // Component file: operator-authored TSX inlined verbatim. Default-export
  // contract is enforced by the imports above (default-import only works
  // when the slot exports default). NO automatic React import — jsx-runtime
  // (`jsx: 'react-jsx'` from mergeTsconfigForReactSsr) handles JSX implicitly,
  // so prepending `import * as React from 'react'` would trip `noUnusedLocals`
  // (TS6133) when the operator doesn't reference the React namespace
  // directly, AND collide with an operator-supplied React import (TS2300
  // Duplicate identifier). If the operator wants to use `React.<Type>` they
  // import it themselves — standard React+TS practice.
  const componentSrc = `/**
 * Auto-generated by codegen from spec.ui_routes['${route.id}'] (B.12-4).
 * Body comes from the operator-filled slot '${slotKey}' — re-run codegen
 * after editing via fill_slot. The default-export contract MUST be kept;
 * the Express-Glue file imports this module as a default-import.
 *
 * Props contract (passed by routes/${camelize(route.id)}UiRouter.tsx):
 *   { data: unknown; fetchError: string | null }
 * If you change the Component signature, the router's renderReactRoute call
 * will fail tsc. Keep the shape stable or update both sides together.
 */

${componentSlot.trim()}
`;

  return { routerSrc, componentSrc };
}

function renderFreeFormFile(
  route: UiRoute,
  slots: Readonly<Record<string, string>>,
): string {
  const factoryName = factoryNameFor(route.id);
  const interfaceName = `${pascalize(route.id)}UiRouterOptions`;
  const slotKey = `ui-${route.id}-render`;
  const renderSlot = slots[slotKey];
  if (renderSlot === undefined || renderSlot.trim().length === 0) {
    // lintSpec already catches this earlier; defensive throw here keeps
    // the failure-mode predictable even when codegen is called directly.
    throw new CodegenError([
      {
        code: 'missing_required_slot',
        detail:
          `ui_routes['${route.id}'] render_mode='free-form-html' requires slot ` +
          `'${slotKey}' to be filled.`,
      },
    ]);
  }

  // Re-indent the slot body so it sits cleanly inside the renderRoute
  // callback. The slot is expected to RETURN an HtmlFragment (e.g.
  // `return htmlDoc({...})`).
  const indented = renderSlot
    .split('\n')
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join('\n');

  return `/**
 * Auto-generated by codegen from spec.ui_routes['${route.id}'] (B.12-2).
 * The render body comes from the LLM-filled slot '${slotKey}' — see spec.slots.
 *
 * render_mode: free-form-html
 * path:        ${route.path}
 * tab_label:   ${route.tab_label}
 */

import { Router } from 'express';
import { renderRoute, htmlDoc, html, safe } from '@omadia/plugin-ui-helpers';
import type { HtmlFragment } from '@omadia/plugin-ui-helpers';

export type ToolRunner = (id: string, args?: unknown) => Promise<unknown>;

export interface ${interfaceName} {
  readonly runTool: ToolRunner;
  readonly pluginId: string;
}

export function ${factoryName}(opts: ${interfaceName}): Router {
  // Reference unused imports so tsc doesn't strip them when the LLM slot
  // happens not to use them.
  void htmlDoc; void html; void safe; void opts;
  const router = Router();
  router.get(${JSON.stringify(route.path)}, renderRoute(async () => {
    const __slotBody: HtmlFragment = await (async () => {
${indented}
    })();
    return __slotBody;
  }));
  return router;
}
`;
}

/**
 * #1620 — `routes/teamsTabRouter.ts`. Static: the route list arrives at
 * runtime from plugin.ts, so this file is identical for every plugin.
 *
 * The shell is DATA-FREE by construction — it renders only the page title and
 * a status line, never calls a tool. In Teams it asks for an SSO token
 * (`authentication.getAuthToken()`) and fetches the rendered page from the
 * teams-sso data mount, then swaps it in with `document.write`: the page keeps
 * its own scripts, its `<meta refresh>` reloads the shell (and so fetches a
 * fresh token), and relative URLs resolve against the shell's location.
 */
function renderTeamsTabFile(): string {
  return `/**
 * Auto-generated by codegen (#1620). DO NOT EDIT BY HAND.
 *
 * Teams-tab surface for this plugin's ui_routes:
 *
 *   <mountPath>/<path>            data-free shell, auth:'public'
 *   <mountPath>/_data/<path>      the ui_route page, auth:'teams-sso'
 *
 * The kernel serves both only while the operator grants the
 * permissions.public_paths entry <mountPath>. The data mount opens for a
 * verified Microsoft Teams SSO token and for nothing else — an omadia
 * session cookie does not open it. The shell never touches data.
 */

import { Router } from 'express';
import { renderRoute, htmlDoc, html, safe } from '@omadia/plugin-ui-helpers';

const TEAMS_JS_URL =
  'https://res.cdn.office.net/teams-js/2.34.0/js/MicrosoftTeams.min.js';
/** Subresource integrity of exactly that file — the script runs in the
 *  plugin's origin, so a swapped CDN file must not load. */
const TEAMS_JS_INTEGRITY =
  'sha384-brW9AazbKR2dYw2DucGgWCCcmrm2oBFV4HQidyuyZRI/TnAkmOOnTARSTdps3Hwt';

export interface TeamsTabPage {
  readonly path: string;
  readonly title: string;
}

export interface TeamsTabRouterOptions {
  /** Absolute mount of the shell router, e.g. \`/p/agent-foo/teams\`. */
  readonly mountPath: string;
  /** Data mount below mountPath, e.g. \`/_data\`. */
  readonly dataSegment: string;
  readonly pages: readonly TeamsTabPage[];
  /** The ui_route routers; each serves its own path. */
  readonly dataRouters: readonly Router[];
}

function shellScript(dataUrl: string): string {
  return \`
    (function () {
      var status = document.getElementById('omadia-status');
      var show = function (message) { if (status) status.textContent = message; };
      var sdk = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = \${JSON.stringify(TEAMS_JS_URL)};
        s.integrity = \${JSON.stringify(TEAMS_JS_INTEGRITY)};
        s.crossOrigin = 'anonymous';
        s.onload = function () { resolve(window.microsoftTeams); };
        s.onerror = function () { reject(new Error('Teams SDK failed to load.')); };
        document.head.appendChild(s);
      });
      var outsideTeams = new Promise(function (_resolve, reject) {
        setTimeout(function () {
          reject(new Error('Open this page inside Microsoft Teams.'));
        }, 8000);
      });
      Promise.race([
        sdk.then(function (t) { return t.app.initialize().then(function () { return t; }); }),
        outsideTeams,
      ]).then(function (t) {
        return t.authentication.getAuthToken().then(null, function (err) {
          throw new Error('Teams sign-in failed: ' + ((err && err.message) || err));
        });
      }).then(function (token) {
        return fetch(\${JSON.stringify(dataUrl)} + window.location.search, {
          headers: { Authorization: 'Bearer ' + token },
          credentials: 'omit',
          cache: 'no-store',
        });
      }).then(function (res) {
        if (!res.ok) throw new Error('Not authorised (' + res.status + ').');
        return res.text();
      }).then(function (page) {
        document.open();
        document.write(page);
        document.close();
      }).catch(function (err) {
        show((err && err.message) || String(err));
      });
    })();
  \`;
}

export function createTeamsTabRouters(opts: TeamsTabRouterOptions): {
  shell: Router;
  data: Router;
} {
  const shell = Router();
  for (const page of opts.pages) {
    const dataUrl = opts.mountPath + opts.dataSegment + page.path;
    shell.get(page.path, renderRoute(() => htmlDoc({
      title: page.title,
      body: html\`
        <main class="max-w-3xl mx-auto p-6">
          <p id="omadia-status" class="text-sm text-slate-500">Loading…</p>
          <script>\${safe(shellScript(dataUrl))}</script>
        </main>
      \`,
    })));
  }

  // ONE router for the data mount: the kernel dispatches a granted path to a
  // single live route entry, so the ui_route routers are merged here instead
  // of being registered one by one under the same prefix.
  const data = Router();
  // Fail closed: only the kernel's teams-sso gate sets teamsSsoUser. A host
  // that does not know the mode (or mounted this router some other way) never
  // sets it, so the page is refused instead of served without auth.
  data.use((req, res, next) => {
    if (!(req as { teamsSsoUser?: unknown }).teamsSsoUser) {
      res.status(401).json({ code: 'auth.teams_sso_required' });
      return;
    }
    next();
  });
  for (const router of opts.dataRouters) data.use(router);
  return { shell, data };
}
`;
}

// --- Name helpers ---------------------------------------------------------

function camelize(id: string): string {
  return id
    .split('-')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

function pascalize(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function factoryNameFor(id: string): string {
  return `create${pascalize(id)}UiRouter`;
}
