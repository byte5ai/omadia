import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildUiRouteArtifacts } from '../../src/plugins/builder/codegenUiRoute.js';
import {
  parseAgentSpec,
  type AgentSpec,
} from '../../src/plugins/builder/agentSpec.js';
import { generate, CodegenError } from '../../src/plugins/builder/codegen.js';

const baseSpec = {
  id: 'de.byte5.agent.test',
  name: 'Test Agent',
  description: 'Test agent description',
  category: 'productivity',
  domain: 'dev.test',
  skill: { role: 'tester' },
  playbook: {
    when_to_use: 'when testing',
    not_for: ['not used for unit tests'],
    example_prompts: ['test prompt 1', 'test prompt 2'],
  },
  network: { outbound: ['api.example.com'] },
  tools: [{ id: 'list_items', description: 'List things', input: {} }],
} as const;

const libraryRoute = {
  id: 'inbox',
  path: '/dashboard',
  tab_label: 'Inbox',
  page_title: 'Test Inbox',
  refresh_seconds: 60,
  render_mode: 'library' as const,
  ui_template: 'list-card' as const,
  interactive: false,
  data_binding: { source: 'tool' as const, tool_id: 'list_items' },
  item_template: { title: '${item.title}' },
};

function specWithRoutes(routes: unknown[], extra: Record<string, unknown> = {}): AgentSpec {
  return parseAgentSpec({ ...baseSpec, ...extra, ui_routes: routes });
}

describe('buildUiRouteArtifacts — empty', () => {
  it('returns empty artifacts when spec.ui_routes is empty', () => {
    const spec = parseAgentSpec(baseSpec);
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    assert.equal(artifacts.imports, '');
    assert.equal(artifacts.init, '');
    assert.equal(artifacts.files.size, 0);
    assert.deepEqual(artifacts.peerDependencies, {});
  });
});

describe('buildUiRouteArtifacts — library mode', () => {
  it('emits a routes/<id>UiRouter.ts file', () => {
    const spec = specWithRoutes([libraryRoute]);
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const file = artifacts.files.get('routes/inboxUiRouter.ts');
    assert.ok(file, 'expected routes/inboxUiRouter.ts');
    const text = file.toString('utf-8');
    assert.ok(text.includes("import { Router } from 'express'"));
    assert.ok(text.includes('renderListCard'));
    assert.ok(text.includes('router.get("/dashboard"'));
    assert.ok(text.includes('Test Inbox'));
    assert.ok(text.includes('refreshSeconds: 60'));
    assert.ok(text.includes('"list_items"'));
  });

  it('factory + interface names are PascalCase', () => {
    const spec = specWithRoutes([{ ...libraryRoute, id: 'pr-board' }]);
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const file = artifacts.files.get('routes/prBoardUiRouter.ts');
    assert.ok(file);
    const text = file.toString('utf-8');
    assert.ok(text.includes('export function createPrBoardUiRouter'));
    assert.ok(text.includes('PrBoardUiRouterOptions'));
  });

  it('emits kpi-tiles helper import when ui_template=kpi-tiles', () => {
    const spec = specWithRoutes([
      { ...libraryRoute, ui_template: 'kpi-tiles', item_template: undefined },
    ]);
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const file = artifacts.files.get('routes/inboxUiRouter.ts');
    assert.ok(file);
    const text = file.toString('utf-8');
    assert.ok(text.includes('renderKpiTiles'));
    assert.ok(!text.includes('renderListCard'));
  });

  it('inlines item_template into the helper call', () => {
    const spec = specWithRoutes([libraryRoute]);
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const text = artifacts.files.get('routes/inboxUiRouter.ts')!.toString('utf-8');
    assert.ok(text.includes('${item.title}'));
  });

  it('builds imports + init slot bodies', () => {
    const spec = specWithRoutes([libraryRoute]);
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    // Production-bug fix: NO `import { Router } from 'express'` at the
    // plugin.ts level — Router lives only in the routes/* files. The
    // earlier version emitted it here and tsc flagged it as TS6133
    // because plugin.ts doesn't reference Router directly.
    assert.ok(
      !artifacts.imports.includes("import { Router } from 'express';"),
      'Router must NOT be imported at plugin.ts level (unused there)',
    );
    assert.ok(
      artifacts.imports.includes(
        "import { createInboxUiRouter } from './routes/inboxUiRouter.js';",
      ),
    );
    assert.ok(artifacts.init.includes('__runTool'));
    assert.ok(artifacts.init.includes('ctx.routes.register'));
    assert.ok(artifacts.init.includes('ctx.uiRoutes.register'));
    assert.ok(artifacts.init.includes("routeId: \"inbox\""));
    assert.ok(artifacts.init.includes("path: \"/dashboard\""));
    assert.ok(artifacts.init.includes("title: \"Inbox\""));
  });

  it('B.12-fix — library router file references opts so noUnusedParameters passes', () => {
    // Test BOTH the with-data_binding and without-data_binding shapes:
    // before the fix, the no-binding shape left `opts` untouched.
    const withBinding = specWithRoutes([libraryRoute]);
    const withoutBinding = specWithRoutes([
      {
        ...libraryRoute,
        data_binding: undefined,
        ui_template: 'kpi-tiles',
        item_template: undefined,
      },
    ]);
    for (const spec of [withBinding, withoutBinding]) {
      const artifacts = buildUiRouteArtifacts(spec, spec.slots);
      const text = artifacts.files
        .get('routes/inboxUiRouter.ts')!
        .toString('utf-8');
      assert.ok(
        text.includes('void opts;'),
        'library router must include `void opts;` (defensive against TS6133)',
      );
    }
  });

  it('adds @omadia/plugin-ui-helpers to peerDependencies', () => {
    const spec = specWithRoutes([libraryRoute]);
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    assert.equal(artifacts.peerDependencies['@omadia/plugin-ui-helpers'], '*');
  });

  it('emits multiple files for multiple routes', () => {
    const spec = specWithRoutes([
      libraryRoute,
      {
        ...libraryRoute,
        id: 'second',
        path: '/second',
        tab_label: 'Second',
        page_title: 'Second Page',
      },
    ]);
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    assert.equal(artifacts.files.size, 2);
    assert.ok(artifacts.files.has('routes/inboxUiRouter.ts'));
    assert.ok(artifacts.files.has('routes/secondUiRouter.ts'));
  });
});

describe('buildUiRouteArtifacts — free-form-html mode', () => {
  const freeFormRoute = {
    id: 'custom',
    path: '/page',
    tab_label: 'Custom',
    page_title: 'Custom Page',
    refresh_seconds: 0,
    render_mode: 'free-form-html' as const,
    interactive: false,
  };

  it('emits routes file with operator-provided slot body', () => {
    const spec = specWithRoutes([freeFormRoute], {
      slots: { 'ui-custom-render': 'return htmlDoc({ title: "X", body: html`<h1>Hi</h1>` });' },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const file = artifacts.files.get('routes/customUiRouter.ts');
    assert.ok(file);
    const text = file.toString('utf-8');
    assert.ok(text.includes('return htmlDoc({ title: "X", body: html`<h1>Hi</h1>` });'));
    assert.ok(text.includes('router.get("/page"'));
  });

  it('throws CodegenError when render-slot is missing', () => {
    const spec = specWithRoutes([freeFormRoute], {
      slots: {},
    });
    assert.throws(
      () => buildUiRouteArtifacts(spec, spec.slots),
      (err: unknown) =>
        err instanceof CodegenError &&
        err.issues.some((i) => i.code === 'missing_required_slot'),
    );
  });

  it('imports html-helper utilities (htmlDoc, html, safe) regardless of slot content', () => {
    const spec = specWithRoutes([freeFormRoute], {
      slots: { 'ui-custom-render': 'return html`<div>X</div>`;' },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const text = artifacts.files.get('routes/customUiRouter.ts')!.toString('utf-8');
    assert.ok(text.includes("from '@omadia/plugin-ui-helpers'"));
    assert.ok(text.includes('htmlDoc'));
    assert.ok(text.includes('html'));
    assert.ok(text.includes('safe'));
  });
});

describe('buildUiRouteArtifacts — react-ssr + interactive (B.13)', () => {
  const interactiveRoute = {
    id: 'inbox',
    path: '/dashboard',
    tab_label: 'Inbox',
    page_title: 'Interactive Inbox',
    refresh_seconds: 0,
    render_mode: 'react-ssr' as const,
    interactive: true,
    data_binding: { source: 'tool' as const, tool_id: 'list_items' },
  };

  const componentSlot = `export default function Page() {
  return <div data-omadia-page="inbox" className="p-6">interactive</div>;
}`;

  it('emits static-mount + import for express/path/fileURLToPath in routerSrc', () => {
    const spec = specWithRoutes([interactiveRoute], {
      slots: { 'ui-inbox-component': componentSlot },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const routerText = artifacts.files
      .get('routes/inboxUiRouter.tsx')!
      .toString('utf-8');
    assert.ok(routerText.includes("import express from 'express'"));
    assert.ok(routerText.includes("import path from 'node:path'"));
    assert.ok(routerText.includes("import { fileURLToPath } from 'node:url'"));
    assert.ok(routerText.includes("router.use(\n    '/static/components'"));
    assert.ok(routerText.includes('express.static(__componentsDir'));
  });

  it('passes hydration option into renderReactRoute call', () => {
    const spec = specWithRoutes([interactiveRoute], {
      slots: { 'ui-inbox-component': componentSlot },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const routerText = artifacts.files
      .get('routes/inboxUiRouter.tsx')!
      .toString('utf-8');
    assert.ok(routerText.includes('hydration: {'));
    assert.ok(routerText.includes('pageId: "inbox"'));
    assert.ok(
      routerText.includes(
        "componentUrl: '/p/' + opts.pluginId + '/static/components/inboxPage.js'",
      ),
    );
  });

  it('non-interactive react-ssr does NOT include static-mount', () => {
    const spec = specWithRoutes(
      [{ ...interactiveRoute, interactive: false }],
      { slots: { 'ui-inbox-component': componentSlot } },
    );
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const routerText = artifacts.files
      .get('routes/inboxUiRouter.tsx')!
      .toString('utf-8');
    assert.ok(!routerText.includes('express.static'));
    assert.ok(!routerText.includes('hydration: {'));
  });

  it('docstring reflects interactive flag', () => {
    const spec = specWithRoutes([interactiveRoute], {
      slots: { 'ui-inbox-component': componentSlot },
    });
    const routerText = artifactsFor(spec, 'routes/inboxUiRouter.tsx');
    assert.ok(routerText.includes('interactive: true'));
  });

  it('B.12-fix — react-ssr router references opts so noUnusedParameters passes', () => {
    const withBinding = specWithRoutes([interactiveRoute], {
      slots: { 'ui-inbox-component': componentSlot },
    });
    const withoutBinding = specWithRoutes(
      [{ ...interactiveRoute, interactive: false, data_binding: undefined }],
      { slots: { 'ui-inbox-component': componentSlot } },
    );
    for (const spec of [withBinding, withoutBinding]) {
      const artifacts = buildUiRouteArtifacts(spec, spec.slots);
      const text = artifacts.files
        .get('routes/inboxUiRouter.tsx')!
        .toString('utf-8');
      assert.ok(
        text.includes('void opts;'),
        'react-ssr router must include `void opts;` (defensive against TS6133)',
      );
    }
  });
});

function artifactsFor(spec: AgentSpec, key: string): string {
  const out = buildUiRouteArtifacts(spec, spec.slots);
  const buf = out.files.get(key);
  if (!buf) throw new Error(`file ${key} not in artifacts`);
  return buf.toString('utf-8');
}

describe('buildUiRouteArtifacts — react-ssr mode (B.12-4)', () => {
  const reactSsrRoute = {
    id: 'inbox',
    path: '/dashboard',
    tab_label: 'Inbox',
    page_title: 'React Inbox',
    refresh_seconds: 60,
    render_mode: 'react-ssr' as const,
    interactive: false,
    data_binding: { source: 'tool' as const, tool_id: 'list_items' },
  };

  const componentSlot = `export interface PageProps { data: unknown; fetchError: string | null }
export default function Page(props: PageProps) {
  return <main className="p-6">items={JSON.stringify(props.data)}</main>;
}`;

  it('emits routes/<id>UiRouter.tsx + components/<id>Page.tsx', () => {
    const spec = specWithRoutes([reactSsrRoute], {
      slots: { 'ui-inbox-component': componentSlot },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    assert.ok(artifacts.files.has('routes/inboxUiRouter.tsx'));
    assert.ok(artifacts.files.has('components/inboxPage.tsx'));
  });

  it('Express-Glue file uses renderReactRoute + default-imports the Page component', () => {
    const spec = specWithRoutes([reactSsrRoute], {
      slots: { 'ui-inbox-component': componentSlot },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const routerText = artifacts.files.get('routes/inboxUiRouter.tsx')!.toString('utf-8');
    assert.ok(routerText.includes("import InboxPage from '../components/inboxPage.js'"));
    assert.ok(routerText.includes("import { renderReactRoute } from '@omadia/plugin-ui-helpers'"));
    assert.ok(routerText.includes('renderReactRoute(InboxPage,'));
    assert.ok(routerText.includes('"list_items"'));
    assert.ok(routerText.includes('refreshSeconds: 60'));
  });

  it('Component file inlines the operator slot verbatim, NO auto-React-import', () => {
    // Regression guard: a prior version of the codegen prepended
    // `import * as React from 'react'` unconditionally. With
    // `jsx: 'react-jsx'` (mergeTsconfigForReactSsr) that import is
    // unused → TS6133, AND collides with operator-supplied imports →
    // TS2300. The fix is to omit the auto-import entirely; the operator
    // imports React only if they need the namespace explicitly.
    const spec = specWithRoutes([reactSsrRoute], {
      slots: { 'ui-inbox-component': componentSlot },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const compText = artifacts.files.get('components/inboxPage.tsx')!.toString('utf-8');
    assert.ok(
      !compText.includes("import * as React from 'react'"),
      'codegen must NOT prepend `import * as React` — breaks TS6133 / TS2300',
    );
    assert.ok(compText.includes('export default function Page'));
    assert.ok(compText.includes('export interface PageProps'));
  });

  it('Component file is safe to fill with an operator React import (no duplicate)', () => {
    const withReactImport = `import React from 'react';
export default function Page(props: { data: unknown; fetchError: string | null }): React.ReactElement {
  return <main>{props.fetchError ?? 'ok'}</main>;
}`;
    const spec = specWithRoutes([reactSsrRoute], {
      slots: { 'ui-inbox-component': withReactImport },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    const compText = artifacts.files.get('components/inboxPage.tsx')!.toString('utf-8');
    // The operator's React import should appear exactly once.
    const matches = compText.match(/import\s+React\s+from\s+'react'/g) ?? [];
    assert.equal(
      matches.length,
      1,
      'operator-supplied React import must NOT collide with a codegen-injected one',
    );
  });

  it('hasReactSsr is true + adds react + react-dom peerDeps', () => {
    const spec = specWithRoutes([reactSsrRoute], {
      slots: { 'ui-inbox-component': componentSlot },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    assert.equal(artifacts.hasReactSsr, true);
    assert.equal(artifacts.peerDependencies['react'], '^18.3.1');
    assert.equal(artifacts.peerDependencies['react-dom'], '^18.3.1');
  });

  it('library-only spec has hasReactSsr=false and no react peerDeps', () => {
    const spec = specWithRoutes([libraryRoute]);
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    assert.equal(artifacts.hasReactSsr, false);
    assert.equal(artifacts.peerDependencies['react'], undefined);
  });

  it('throws CodegenError when component slot is missing', () => {
    const spec = specWithRoutes([reactSsrRoute], { slots: {} });
    assert.throws(
      () => buildUiRouteArtifacts(spec, spec.slots),
      (err: unknown) =>
        err instanceof CodegenError &&
        err.issues.some((i) => i.code === 'missing_required_slot'),
    );
  });

  it('plugin.ts import line resolves to UiRouter.js (not .tsx)', () => {
    const spec = specWithRoutes([reactSsrRoute], {
      slots: { 'ui-inbox-component': componentSlot },
    });
    const artifacts = buildUiRouteArtifacts(spec, spec.slots);
    // The runtime import in plugin.ts references the .js compiled output
    // regardless of source .ts vs .tsx — tsc emits .js for both.
    assert.ok(
      artifacts.imports.includes("from './routes/inboxUiRouter.js'"),
      'plugin.ts import should reference .js',
    );
  });
});

describe('generate() — react-ssr integration', () => {
  it('emits TSX files + patches tsconfig.json with jsx: react-jsx', async () => {
    const spec = specWithRoutes(
      [
        {
          id: 'react-page',
          path: '/page',
          tab_label: 'React',
          page_title: 'React Page',
          refresh_seconds: 30,
          render_mode: 'react-ssr',
          interactive: false,
          data_binding: { source: 'tool', tool_id: 'list_items' },
        },
      ],
      {
        slots: {
          'ui-react-page-component':
            'export default function P() { return <div>Hi</div>; }',
        },
      },
    );
    const files = await generate({ spec, slots: minimalSlots() });
    assert.ok(files.has('routes/reactPageUiRouter.tsx'));
    assert.ok(files.has('components/reactPagePage.tsx'));
    const tsconfig = JSON.parse(files.get('tsconfig.json')!.toString('utf-8'));
    assert.equal(tsconfig.compilerOptions.jsx, 'react-jsx');
    assert.equal(tsconfig.compilerOptions.jsxImportSource, 'react');
  });

  it('legacy spec (no ui_routes) leaves tsconfig.json untouched (no jsx key)', async () => {
    const spec = parseAgentSpec(baseSpec);
    const files = await generate({ spec, slots: minimalSlots() });
    const tsconfig = JSON.parse(files.get('tsconfig.json')!.toString('utf-8'));
    assert.equal(tsconfig.compilerOptions.jsx, undefined);
  });

  it('library-only spec leaves tsconfig.json without jsx setting', async () => {
    const spec = specWithRoutes([libraryRoute]);
    const files = await generate({ spec, slots: minimalSlots() });
    const tsconfig = JSON.parse(files.get('tsconfig.json')!.toString('utf-8'));
    assert.equal(tsconfig.compilerOptions.jsx, undefined);
  });

  it('react-ssr package.json gains react + react-dom peerDeps', async () => {
    const spec = specWithRoutes(
      [
        {
          ...libraryRoute,
          render_mode: 'react-ssr',
          ui_template: undefined,
          item_template: undefined,
        },
      ],
      { slots: { 'ui-inbox-component': 'export default () => <div/>;' } },
    );
    const files = await generate({ spec, slots: minimalSlots() });
    const pkg = JSON.parse(files.get('package.json')!.toString('utf-8'));
    assert.equal(pkg.peerDependencies['react'], '^18.3.1');
    assert.equal(pkg.peerDependencies['react-dom'], '^18.3.1');
  });
});

describe('generate() integration — codegen output for ui_routes', () => {
  it('produces no ui_route files for spec.ui_routes=[]', async () => {
    const spec = parseAgentSpec(baseSpec);
    const files = await generate({ spec, slots: minimalSlots() });
    const routeFiles = [...files.keys()].filter((p) => p.startsWith('routes/'));
    assert.deepEqual(routeFiles, [], 'expected no routes/* files');
  });

  it('emits routes/<id>UiRouter.ts for library-mode route + injects plugin.ts slots', async () => {
    const spec = specWithRoutes([libraryRoute]);
    const files = await generate({ spec, slots: minimalSlots() });
    assert.ok(files.has('routes/inboxUiRouter.ts'));
    const pluginText = files.get('plugin.ts')!.toString('utf-8');
    assert.ok(pluginText.includes('createInboxUiRouter'));
    assert.ok(pluginText.includes('__uiRouteDisposers.push'));
    assert.ok(pluginText.includes('ctx.uiRoutes.register'));
  });

  it('package.json includes @omadia/plugin-ui-helpers peerDep when ui_routes present', async () => {
    const spec = specWithRoutes([libraryRoute]);
    const files = await generate({ spec, slots: minimalSlots() });
    const pkg = JSON.parse(files.get('package.json')!.toString('utf-8'));
    assert.equal(pkg.peerDependencies['@omadia/plugin-ui-helpers'], '*');
  });

  it('legacy specs (ui_routes=[]) produce regions-empty plugin.ts (no codegen-injected wiring)', async () => {
    const spec = parseAgentSpec(baseSpec);
    const files = await generate({ spec, slots: minimalSlots() });
    const pluginText = files.get('plugin.ts')!.toString('utf-8');
    // The 3 new region markers exist but bodies are empty
    assert.ok(pluginText.includes('// #region builder:ui-routes-imports'));
    assert.ok(pluginText.includes('// #region builder:ui-routes-init'));
    // No factory references (since no ui_routes)
    assert.ok(!pluginText.includes('createInboxUiRouter'));
    // B.12 production-fix — plugin-ui-helpers IS declared in the boilerplate
    // peerDeps so the build-template can symlink it for tsc. The codegen-
    // managed peerDep flow is unaffected (still only emits the entry when
    // ui_routes.length > 0); the boilerplate flow + the codegen flow both
    // converge on "always *" for this package now.
    const pkg = JSON.parse(files.get('package.json')!.toString('utf-8'));
    assert.equal(pkg.peerDependencies['@omadia/plugin-ui-helpers'], '*');
    assert.equal(pkg.peerDependencies['express'], '^5.1.0');
  });
});

function minimalSlots(): Record<string, string> {
  return {
    'client-impl': '// client stub\nreturn { async ping() {}, async dispose() {} } as unknown as Client;',
    'toolkit-impl': '// toolkit stub\nconst tools: ToolDescriptor<unknown, unknown>[] = [];\nreturn { tools, async close() {} };',
    'skill-prompt': '# Test Skill\nTest prompt body.',
  };
}
