import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { zodToJsonSchema } from '../../src/plugins/zodToJsonSchema.js';

/**
 * Dynamic-import bridge test — closest possible reproduction of the
 * PreviewRuntime / dynamicAgentRuntime activation path without spinning
 * up a real preview workspace.
 *
 * Loads the BUILT `dist/toolkit.js` of seo-analyst via dynamic import
 * (just like `previewRuntime.activate()` does with the extracted ZIP)
 * and walks the input schemas of the resulting toolkit tools.
 *
 * If this test passes, the bug is NOT in the dynamic-import + JS-vs-TS
 * boundary, and definitely not in the walker. Then the only remaining
 * Preview-Runtime hypothesis is something downstream (LocalSubAgent
 * options pipeline, prompt-cache spec mutation, etc.).
 */
describe('zodToJsonSchema — seo-analyst built dist/ loaded via dynamic import', () => {
  const distToolkitPath = path.resolve(
    process.cwd(),
    'packages/agent-seo-analyst/dist/toolkit.js',
  );
  const distFetcherPath = path.resolve(
    process.cwd(),
    'packages/agent-seo-analyst/dist/fetcher.js',
  );

  it('dynamically imports dist/toolkit.js and bridges schemas correctly', async () => {
    const toolkitMod = (await import(pathToFileURL(distToolkitPath).href)) as {
      createToolkit: (opts: unknown) => {
        tools: ReadonlyArray<{ id: string; input: unknown }>;
      };
    };
    const fetcherMod = (await import(pathToFileURL(distFetcherPath).href)) as {
      createFetcher: (opts: unknown) => unknown;
    };

    const log = (..._args: unknown[]) => {};
    const fetcher = fetcherMod.createFetcher({
      userAgent: 'test/0.0',
      timeoutMs: 1_000,
      log,
    });
    const toolkit = toolkitMod.createToolkit({
      fetcher,
      targetBaseUrl: 'https://example.com',
      userAgent: 'test/0.0',
      crawlMaxPages: 1,
      crawlMaxDepth: 1,
      log,
    });

    const analyzePageTool = toolkit.tools.find((t) => t.id === 'analyze_page');
    assert.ok(analyzePageTool, 'analyze_page tool must be present');

    // Diagnostic: what's the typeName / ctor of the input schema coming
    // out of a dynamically-imported plugin?
    const td = analyzePageTool as { input: { _def?: { typeName?: string } } };
    const diag = {
      typeName: td.input._def?.typeName,
      ctor: (td.input as object).constructor?.name,
      hasUnderscoreDef: '_def' in (td.input as object),
    };

    const schema = zodToJsonSchema(td.input as Parameters<typeof zodToJsonSchema>[0]);
    assert.equal(
      schema.type,
      'object',
      `expected object, got: ${JSON.stringify({ diag, schema })}`,
    );
    assert.ok(
      schema.properties && Object.keys(schema.properties).length > 0,
      `properties empty — diag=${JSON.stringify(diag)} schema=${JSON.stringify(schema)}`,
    );
    assert.ok(schema.properties?.['url']);
    assert.equal(schema.properties?.['url']?.type, 'string');
    assert.equal(schema.properties?.['url']?.format, 'uri');
    assert.deepEqual(schema.required, ['url']);
  });
});
