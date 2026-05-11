import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  PLUGIN_DOMAIN_REGEX,
  validatePluginDomain,
} from '@omadia/plugin-api';

/**
 * OB-77 (Palaia Phase 8) — Plugin Domain Naming-Convention.
 *
 * Validates the contract that the manifest loader, the orchestrator's
 * NudgePipeline ToolTrace builder, and the Operator Admin UI all read
 * from the same source. Examples track the conventions called out in the
 * PluginContext doc-block.
 */

describe('validatePluginDomain — accepts valid identifiers', () => {
  const cases: Array<[string, string]> = [
    ['flat', 'confluence'],
    ['flat odoo', 'odoo'],
    ['dotted two-level', 'odoo.hr'],
    ['dotted two-level accounting', 'odoo.accounting'],
    ['dotted with vendor namespace', 'm365.calendar'],
    ['dotted three-level', 'infra.unifi.devices'],
    ['kebab-case mid-segment', 'core.knowledge-graph'],
    ['kebab-case multi-hyphen', 'quality.response-guard'],
    ['kebab-case flat', 'web-search'],
    ['fallback shape (loader auto-prefixes "unknown." onto dotted id)', 'unknown.de.byte5.tool.foo'],
  ];

  for (const [label, value] of cases) {
    it(label, () => {
      const result = validatePluginDomain(value);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.domain, value);
    });
  }
});

describe('validatePluginDomain — rejects invalid identifiers', () => {
  const cases: Array<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['uppercase', 'Confluence'],
    ['leading digit', '1odoo'],
    ['trailing dot', 'odoo.'],
    ['leading dot', '.odoo'],
    ['double dot', 'odoo..hr'],
    ['underscore', 'odoo_hr'],
    ['leading hyphen', '-odoo'],
    ['trailing hyphen', 'odoo-'],
    ['double hyphen', 'odoo--hr'],
    ['hyphen at segment boundary', 'odoo-.hr'],
    ['space', 'odoo hr'],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', { domain: 'odoo' }],
  ];

  for (const [label, value] of cases) {
    it(label, () => {
      const result = validatePluginDomain(value);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.message.length > 0);
    });
  }
});

describe('PLUGIN_DOMAIN_REGEX — direct regex shape', () => {
  it('matches the exported regex against a flat identifier', () => {
    assert.match('confluence', PLUGIN_DOMAIN_REGEX);
  });
  it('matches a dotted hierarchy', () => {
    assert.match('odoo.hr.contracts', PLUGIN_DOMAIN_REGEX);
  });
  it('does not match an empty string', () => {
    assert.doesNotMatch('', PLUGIN_DOMAIN_REGEX);
  });
});
