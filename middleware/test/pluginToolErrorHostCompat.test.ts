import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as pluginApi from '@omadia/plugin-api';
import { DiagramRenderError, DiagramTool, type DiagramService } from '@omadia/diagrams';
import * as diagramsCompat from '@omadia/diagrams/dist/toolErrorCompat.js';
import {
  createDiscussionPartnersHandler,
  createDiscussionStartHandler,
  type DiscussionsCapability,
} from '@omadia/plugin-discussion';
import * as discussionCompat from '@omadia/plugin-discussion/dist/toolErrorCompat.js';
import {
  WebSearchError,
  WebSearchProviderError,
  type WebSearchService,
} from '@omadia/plugin-web-search';
import { createWebSearchToolHandler } from '@omadia/plugin-web-search/dist/searchTool.js';
import * as webSearchCompat from '@omadia/plugin-web-search/dist/toolErrorCompat.js';

/**
 * A plugin's `@omadia/plugin-api` is the HOST's copy. `newToolErrorRef` and
 * `toolErrorFromException` exist from plugin-api 1.20.0 on, while the
 * manifests of web-search, diagrams and discussion admit older hosts. A named
 * import of either helper is an ESM link error there: the plugin does not load
 * at all. So each plugin reads them off the namespace and, where they are
 * missing, answers with a fixed text that names the tool and a log ref and
 * carries nothing of the error. The suite runs against the built dist/.
 * Synthetic values throughout.
 */

const HELPERS: readonly string[] = ['newToolErrorRef', 'toolErrorFromException'];

/** The namespace a host before plugin-api 1.20.0 hands a plugin: today's
 *  exports without the two helpers. */
const pre120Api: Readonly<Record<string, unknown>> = Object.fromEntries(
  Object.entries(pluginApi).filter(([name]) => !HELPERS.includes(name)),
);

const COMPAT_MODULES = [
  { pkg: '@omadia/plugin-web-search', compat: webSearchCompat, uses: HELPERS },
  { pkg: '@omadia/diagrams', compat: diagramsCompat, uses: HELPERS },
  { pkg: '@omadia/plugin-discussion', compat: discussionCompat, uses: ['toolErrorFromException'] },
] as const;

function failingSearch(err: unknown): WebSearchService {
  return { search: () => Promise.reject(err) } as unknown as WebSearchService;
}

function failingRender(err: unknown): DiagramService {
  return { render: () => Promise.reject(err) } as unknown as DiagramService;
}

function failingDiscussions(err: unknown): DiscussionsCapability {
  return {
    startHere: () => Promise.reject(err),
    partnersHere: () => Promise.reject(err),
  } as unknown as DiscussionsCapability;
}

const quiet = (): void => {};
const DIAGRAM = { kind: 'mermaid', source: 'graph TD; A-->B' };
const DISCUSSION = { with_agents: ['accounting'], topic: 'Weiterbildungsbudgets' };

/**
 * Asserts that `out` is exactly the answer a tool gives on a host before
 * plugin-api 1.20.0 (so nothing of the error reaches the model) and returns
 * its log ref.
 */
function assertLegacyAnswer(out: string, toolName: string, errorTexts: readonly string[]): string {
  const ref = new RegExp(
    `^Error: ${toolName} failed; details are in the server log \\(ref (err_[0-9a-f]{12})\\)$`,
    'u',
  ).exec(out)?.[1];
  assert.ok(ref !== undefined, `not the fixed old-host answer: ${out}`);
  for (const text of errorTexts) {
    assert.ok(!out.includes(text), `error text reached the model: ${out}`);
  }
  return ref;
}

/** Runs `fn` with console.error captured; returns its result and the calls. */
async function capturingConsoleError<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; calls: unknown[][] }> {
  const errorLog = mock.method(console, 'error', () => {});
  try {
    const result = await fn();
    return { result, calls: errorLog.mock.calls.map((call) => [...call.arguments]) };
  } finally {
    errorLog.mock.restore();
  }
}

/** True when a captured console.error call logged `err` under `ref`. */
function loggedUnder(calls: readonly unknown[][], ref: string, err: unknown): boolean {
  return calls.some(
    ([line, logged]) => typeof line === 'string' && line.includes(`ref=${ref}`) && logged === err,
  );
}

describe('resolveToolErrorHelpers', () => {
  for (const { pkg, compat, uses } of COMPAT_MODULES) {
    it(`${pkg}: takes the helpers from a plugin-api that exports them`, () => {
      const helpers = compat.resolveToolErrorHelpers(pluginApi) as unknown as Readonly<
        Record<string, unknown>
      > | null;
      assert.ok(helpers, 'a current plugin-api resolves');
      const api = pluginApi as unknown as Readonly<Record<string, unknown>>;
      for (const name of uses) assert.equal(helpers[name], api[name], name);
      assert.notEqual(compat.hostToolErrorHelpers, null, 'this host has them');
    });

    it(`${pkg}: resolves nothing from a plugin-api before 1.20.0`, () => {
      assert.equal(compat.resolveToolErrorHelpers(pre120Api), null);
      assert.equal(compat.resolveToolErrorHelpers({}), null);
    });
  }

  it('web-search and diagrams need both helpers, not one of them', () => {
    const onlyOne = { toolErrorFromException: pluginApi.toolErrorFromException };
    assert.equal(webSearchCompat.resolveToolErrorHelpers(onlyOne), null);
    assert.equal(diagramsCompat.resolveToolErrorHelpers(onlyOne), null);
  });
});

describe('web_search on a host before plugin-api 1.20.0', () => {
  const helpers = webSearchCompat.resolveToolErrorHelpers(pre120Api);
  const cases: ReadonlyArray<readonly [string, Error, readonly string[]]> = [
    ['an exception it did not author', new TypeError('socket hang up'), ['socket hang up']],
    ['a bare WebSearchError', new WebSearchError('[tavily] empty answer'), ['empty answer']],
    [
      'a provider failure',
      new WebSearchProviderError('brave', 'HTTP 502', 502, 'upstream body'),
      ['HTTP 502', 'upstream body'],
    ],
  ];

  for (const [what, err, errorTexts] of cases) {
    it(`answers ${what} with the fixed text and logs the full error under its ref`, async () => {
      const handler = createWebSearchToolHandler(failingSearch(err), helpers);
      const { result, calls } = await capturingConsoleError(() => handler({ query: 'q' }));
      const ref = assertLegacyAnswer(result, 'web_search', errorTexts);
      assert.ok(loggedUnder(calls, ref, err), 'the full error is logged under the ref');
    });
  }

  it('keeps the withheld notice where the host has the helpers', async () => {
    const handler = createWebSearchToolHandler(failingSearch(new TypeError('socket hang up')));
    const { result } = await capturingConsoleError(() => handler({ query: 'q' }));
    assert.ok(pluginApi.isWithheldToolErrorNotice(result), result);
    assert.ok(!result.includes('socket hang up'), result);
  });
});

describe('render_diagram on a host before plugin-api 1.20.0', () => {
  const helpers = diagramsCompat.resolveToolErrorHelpers(pre120Api);
  const cases: ReadonlyArray<readonly [string, Error, readonly string[]]> = [
    ['an exception it did not author', new Error('bucket unavailable'), ['bucket unavailable']],
    [
      'a renderer failure',
      new DiagramRenderError('Kroki mermaid/png responded 400', 400, 'syntax error near A'),
      ['responded 400', 'syntax error near A'],
    ],
  ];

  for (const [what, err, errorTexts] of cases) {
    it(`answers ${what} with the fixed text and logs the full error under its ref`, async () => {
      const lines: string[] = [];
      const log = (line: string): void => {
        lines.push(line);
      };
      const tool = new DiagramTool(failingRender(err), undefined, log, helpers);
      const ref = assertLegacyAnswer(await tool.handle(DIAGRAM), 'render_diagram', errorTexts);
      const logged = lines.find((line) => line.includes(`ref=${ref}`));
      assert.ok(logged !== undefined, 'logged under the ref');
      for (const text of errorTexts) assert.ok(logged.includes(text), `the log carries ${text}`);
    });
  }

  it('keeps the withheld notice where the host has the helpers', async () => {
    const tool = new DiagramTool(failingRender(new Error('bucket unavailable')), undefined, quiet);
    const out = await tool.handle(DIAGRAM);
    assert.ok(pluginApi.isWithheldToolErrorNotice(out), out);
    assert.ok(!out.includes('bucket unavailable'), out);
  });
});

describe('discussion tools on a host before plugin-api 1.20.0', () => {
  const toolErrorHelpers = discussionCompat.resolveToolErrorHelpers(pre120Api);
  const err = new Error('connection refused');

  it('discussion_start answers with the fixed text and logs the full error under its ref', async () => {
    const start = createDiscussionStartHandler({
      resolveDiscussions: () => failingDiscussions(err),
      toolErrorHelpers,
    });
    const { result, calls } = await capturingConsoleError(() => start(DISCUSSION));
    const ref = assertLegacyAnswer(result, 'discussion_start', ['connection refused']);
    assert.ok(loggedUnder(calls, ref, err), 'the full error is logged under the ref');
  });

  it('discussion_partners answers with the fixed text and logs the full error under its ref', async () => {
    const partners = createDiscussionPartnersHandler({
      resolveDiscussions: () => failingDiscussions(err),
      toolErrorHelpers,
    });
    const { result, calls } = await capturingConsoleError(() => partners({}));
    const ref = assertLegacyAnswer(result, 'discussion_partners', ['connection refused']);
    assert.ok(loggedUnder(calls, ref, err), 'the full error is logged under the ref');
  });

  it('keeps the withheld notice where the host has the helpers', async () => {
    const start = createDiscussionStartHandler({
      resolveDiscussions: () => failingDiscussions(err),
    });
    const { result } = await capturingConsoleError(() => start(DISCUSSION));
    assert.ok(pluginApi.isWithheldToolErrorNotice(result), result);
    assert.ok(!result.includes('connection refused'), result);
  });
});

// ---------------------------------------------------------------------------
// The real thing: the built dist/, linked against an older host's plugin-api.
// With named imports of the helpers, importing dist/plugin.js here throws
// "SyntaxError: The requested module '@omadia/plugin-api' does not provide an
// export named 'newToolErrorRef'" (or 'toolErrorFromException').
// ---------------------------------------------------------------------------

const MIDDLEWARE = fileURLToPath(new URL('..', import.meta.url));
const HOST_MODULES = path.join(MIDDLEWARE, 'node_modules');
const HOST_PLUGIN_API = path.join(HOST_MODULES, '@omadia', 'plugin-api', 'dist', 'index.js');

/**
 * Installs a plugin package's built `dist/` beside a host whose
 * `@omadia/plugin-api` predates 1.20.0. Every other package links to this
 * host's copy, the way an uploaded package resolves the host's node_modules.
 * Returns the plugin directory.
 */
async function installOnPre120Host(root: string, packageDir: string): Promise<string> {
  const modules = path.join(root, 'node_modules');
  const api = path.join(modules, '@omadia', 'plugin-api');
  await fs.mkdir(api, { recursive: true });
  for (const scope of ['', '@omadia']) {
    for (const name of await fs.readdir(path.join(HOST_MODULES, scope))) {
      if (name.startsWith('.') || name === '@omadia' || (scope !== '' && name === 'plugin-api')) {
        continue;
      }
      await fs.symlink(path.join(HOST_MODULES, scope, name), path.join(modules, scope, name));
    }
  }
  await fs.writeFile(
    path.join(api, 'package.json'),
    JSON.stringify({
      name: '@omadia/plugin-api',
      version: '1.19.2',
      type: 'module',
      exports: './index.js',
    }),
  );
  await fs.writeFile(
    path.join(api, 'index.js'),
    `export { ${Object.keys(pre120Api).join(', ')} } from '${pathToFileURL(HOST_PLUGIN_API).href}';\n`,
  );
  const plugin = path.join(root, 'plugin');
  await fs.cp(path.join(packageDir, 'dist'), path.join(plugin, 'dist'), { recursive: true });
  await fs.copyFile(path.join(packageDir, 'package.json'), path.join(plugin, 'package.json'));
  return plugin;
}

const LOAD_CASES: ReadonlyArray<{
  readonly dir: string;
  readonly answersWithFixedText: (moduleUrl: (file: string) => string) => Promise<void>;
}> = [
  {
    dir: 'harness-plugin-web-search',
    answersWithFixedText: async (moduleUrl) => {
      const mod = (await import(
        moduleUrl('searchTool.js')
      )) as typeof import('@omadia/plugin-web-search/dist/searchTool.js');
      const handler = mod.createWebSearchToolHandler(failingSearch(new TypeError('socket hang up')));
      const { result } = await capturingConsoleError(() => handler({ query: 'q' }));
      assertLegacyAnswer(result, 'web_search', ['socket hang up']);
    },
  },
  {
    dir: 'harness-diagrams',
    answersWithFixedText: async (moduleUrl) => {
      const mod = (await import(
        moduleUrl('diagramTool.js')
      )) as typeof import('@omadia/diagrams/dist/diagramTool.js');
      const tool = new mod.DiagramTool(failingRender(new Error('bucket unavailable')), undefined, quiet);
      assertLegacyAnswer(await tool.handle(DIAGRAM), 'render_diagram', ['bucket unavailable']);
    },
  },
  {
    dir: 'harness-plugin-discussion',
    answersWithFixedText: async (moduleUrl) => {
      const mod = (await import(
        moduleUrl('discussionTool.js')
      )) as typeof import('@omadia/plugin-discussion/dist/discussionTool.js');
      const start = mod.createDiscussionStartHandler({
        resolveDiscussions: () => failingDiscussions(new Error('connection refused')),
      });
      const { result } = await capturingConsoleError(() => start(DISCUSSION));
      assertLegacyAnswer(result, 'discussion_start', ['connection refused']);
    },
  },
];

describe('built plugin on a host before plugin-api 1.20.0', () => {
  for (const { dir, answersWithFixedText } of LOAD_CASES) {
    it(`${dir}: dist/plugin.js links and its tools answer with the fixed text`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omadia-pre120-host-'));
      try {
        const plugin = await installOnPre120Host(root, path.join(MIDDLEWARE, 'packages', dir));
        const moduleUrl = (file: string): string =>
          pathToFileURL(path.join(plugin, 'dist', file)).href;
        const entry = (await import(moduleUrl('plugin.js'))) as { activate?: unknown };
        assert.equal(typeof entry.activate, 'function');
        await answersWithFixedText(moduleUrl);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
