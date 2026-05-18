import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';

import { zodToJsonSchema } from '../../src/plugins/zodToJsonSchema.js';

/**
 * In-process check against the geo-analyst toolkit-impl pattern.
 *
 * The geo-analyst draft uses the same external-constant + `as` cast pattern
 * as seo-analyst (which passed `zodToJsonSchemaSeoAnalyst.test.ts`). The
 * difference: `discuss_recommendation` carries a `z.unknown().optional()`
 * field. `ZodUnknown` is not in the walker's switch and falls into the
 * default branch → `return {}`.
 *
 * Hypothesis to test: does the `z.unknown()` field's `{}` schema corrupt
 * the *whole* tool's input_schema (would explain the geo-analyst symptom
 * where all four tools come through with empty properties), or does it
 * only affect that one field (acceptable — produces a free-form parameter
 * for the LLM)?
 */
describe('zodToJsonSchema — geo-analyst tool input patterns', () => {
  it('analyze_page_geo pattern → url property preserved', () => {
    const analyzePageInput = z.object({
      url: z.string().url().describe('Vollständige URL'),
    });
    const schema = zodToJsonSchema(analyzePageInput as z.ZodType<unknown>);
    assert.equal(schema.type, 'object');
    assert.ok(
      schema.properties?.['url'],
      `expected url property, got: ${JSON.stringify(schema)}`,
    );
    assert.equal(schema.properties?.['url']?.format, 'uri');
    assert.deepEqual(schema.required, ['url']);
  });

  it('audit_site_geo pattern → start_url/max_pages/max_depth', () => {
    const auditSiteInput = z.object({
      start_url: z.string().url().describe('Start-URL'),
      max_pages: z.number().int().min(1).max(100).optional(),
      max_depth: z.number().int().min(1).max(5).optional(),
    });
    const schema = zodToJsonSchema(auditSiteInput as z.ZodType<unknown>);
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties?.['start_url']);
    assert.ok(schema.properties?.['max_pages']);
    assert.ok(schema.properties?.['max_depth']);
    assert.equal(schema.properties?.['max_pages']?.type, 'integer');
    // start_url is required, max_pages/max_depth optional
    assert.deepEqual(schema.required, ['start_url']);
  });

  it('discuss_recommendation pattern with z.unknown().optional() → does NOT empty whole schema', () => {
    const discussRecommendationInput = z.object({
      measure: z.string().min(3).max(500).describe('Klartext-Maßnahme'),
      current_report: z.unknown().optional().describe('Optional context'),
    });
    const schema = zodToJsonSchema(discussRecommendationInput as z.ZodType<unknown>);

    const diag = {
      typeName: (discussRecommendationInput as { _def?: { typeName?: string } })._def?.typeName,
      ctor: (discussRecommendationInput as object).constructor?.name,
      jsonSchema: schema,
    };

    assert.equal(schema.type, 'object', `unexpected: ${JSON.stringify(diag)}`);
    assert.ok(
      schema.properties && Object.keys(schema.properties).length > 0,
      `properties must not be empty even with z.unknown() field, got: ${JSON.stringify(diag)}`,
    );
    assert.ok(
      schema.properties?.['measure'],
      `measure property should be present, got: ${JSON.stringify(schema.properties)}`,
    );
    assert.equal(schema.properties?.['measure']?.type, 'string');
    // current_report goes through default branch → {} — that's OK
    assert.ok(
      'current_report' in (schema.properties ?? {}),
      'current_report should be present (as free-form {})',
    );
    // measure is required, current_report optional
    assert.deepEqual(schema.required, ['measure']);
  });

  it('check_technical_geo pattern → base_url required (no .optional() in geo)', () => {
    // Note: geo-analyst's checkTechnicalInput does NOT make base_url optional
    // (unlike seo-analyst). Verify the walker reflects that.
    const checkTechnicalInput = z.object({
      base_url: z.string().url().describe('Basis-URL der Domain'),
    });
    const schema = zodToJsonSchema(checkTechnicalInput as z.ZodType<unknown>);
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties?.['base_url']);
    assert.equal(schema.properties?.['base_url']?.format, 'uri');
    assert.deepEqual(schema.required, ['base_url']);
  });
});
