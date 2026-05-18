import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';

import { zodToJsonSchema } from '../../src/plugins/zodToJsonSchema.js';
import { createToolkit } from '@omadia/agent-seo-analyst/toolkit.js';
import { createFetcher } from '@omadia/agent-seo-analyst/fetcher.js';

/**
 * In-process Bridge-reality check.
 *
 * Loads the real `@omadia/agent-seo-analyst` toolkit (which lives in the
 * same workspace and imports its own `zod`) and runs each tool's
 * Zod input schema through the platform's `zodToJsonSchema` walker — the
 * exact thing `bridgeTool()` / `bridgePreviewTool()` do at activation
 * time.
 *
 * Purpose: trap the empty-input_schema bug that geo-analyst hits in the
 * Builder-Preview (reported 2026-05-18). If seo-analyst's tools survive
 * the walker with their properties intact in-process, then the bug is
 * specific to the dynamic-import / module-boundary path the Preview-
 * Runtime takes — and not the walker itself.
 *
 * Conversely, if even this in-process load produces `properties: {}`,
 * the walker has a regression and the fix is in zodToJsonSchema.ts.
 */
describe('zodToJsonSchema — real seo-analyst toolkit (in-process)', () => {
  function buildToolkit() {
    const log = (..._args: unknown[]) => {};
    const fetcher = createFetcher({
      userAgent: 'test-agent/0.0',
      timeoutMs: 1_000,
      log,
    });
    return createToolkit({
      fetcher,
      targetBaseUrl: 'https://example.com',
      userAgent: 'test-agent/0.0',
      crawlMaxPages: 1,
      crawlMaxDepth: 1,
      log,
    });
  }

  it('analyze_page → input_schema has url property', () => {
    const toolkit = buildToolkit();
    const tool = toolkit.tools.find((t) => t.id === 'analyze_page');
    assert.ok(tool, 'analyze_page tool present');

    const schema = zodToJsonSchema(tool.input);

    // Diagnostic dump — if this test fails, the printout pinpoints
    // exactly where the walker dropped the properties.
    const diag = {
      typeName: (tool.input as { _def?: { typeName?: string } })._def?.typeName,
      ctor: (tool.input as object).constructor?.name,
      jsonSchema: schema,
    };
    assert.equal(
      schema.type,
      'object',
      `expected type=object, got: ${JSON.stringify(diag)}`,
    );
    assert.ok(
      schema.properties && Object.keys(schema.properties).length > 0,
      `expected non-empty properties, got: ${JSON.stringify(diag)}`,
    );
    assert.ok(
      schema.properties?.['url'],
      `expected properties.url, got: ${JSON.stringify(schema.properties)}`,
    );
    assert.equal(schema.properties?.['url']?.type, 'string');
    assert.equal(schema.properties?.['url']?.format, 'uri');
    assert.deepEqual(schema.required, ['url']);
  });

  it('check_technical_seo → input_schema has base_url property (optional)', () => {
    const toolkit = buildToolkit();
    const tool = toolkit.tools.find((t) => t.id === 'check_technical_seo');
    assert.ok(tool, 'check_technical_seo tool present');

    const schema = zodToJsonSchema(tool.input);
    assert.equal(schema.type, 'object');
    assert.ok(
      schema.properties?.['base_url'],
      `expected properties.base_url, got: ${JSON.stringify(schema)}`,
    );
    assert.equal(schema.properties?.['base_url']?.type, 'string');
    assert.equal(schema.properties?.['base_url']?.format, 'uri');
    // base_url is .optional() — must NOT be in required[]
    assert.ok(
      !(schema.required ?? []).includes('base_url'),
      `base_url must be optional, required=${JSON.stringify(schema.required)}`,
    );
  });

  it('audit_site → input_schema has start_url/max_pages/max_depth', () => {
    const toolkit = buildToolkit();
    const tool = toolkit.tools.find((t) => t.id === 'audit_site');
    assert.ok(tool, 'audit_site tool present');

    const schema = zodToJsonSchema(tool.input);
    assert.equal(schema.type, 'object');
    assert.ok(
      schema.properties?.['start_url'],
      `expected start_url, got: ${JSON.stringify(schema)}`,
    );
    assert.ok(
      schema.properties?.['max_pages'],
      `expected max_pages, got: ${JSON.stringify(schema)}`,
    );
    assert.ok(
      schema.properties?.['max_depth'],
      `expected max_depth, got: ${JSON.stringify(schema)}`,
    );
    assert.equal(schema.properties?.['max_pages']?.type, 'integer');
    assert.equal(schema.properties?.['max_depth']?.type, 'integer');
  });

  it('walker on a fresh in-test z.object → produces the same shape', () => {
    // Control: a Zod schema constructed in the test file itself (so the
    // `z` import here points at the *same* `zod` module the walker sees).
    // If the seo-analyst tests above fail but this one passes, the
    // walker is fine — the failure is a module-boundary effect.
    const control = z.object({
      url: z.string().url().describe('control url'),
    });
    const schema = zodToJsonSchema(control);
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties?.['url']);
    assert.equal(schema.properties?.['url']?.type, 'string');
    assert.equal(schema.properties?.['url']?.format, 'uri');
    assert.deepEqual(schema.required, ['url']);
  });
});
