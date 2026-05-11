import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { suggestDependsOnTool } from '../../../src/plugins/builder/tools/suggestDependsOn.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

describe('suggestDependsOnTool', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('suggests odoo for accounting intent', async () => {
    const result = await suggestDependsOnTool.run(
      { intent: 'invoice automation in Odoo accounting' },
      harness.context(),
    );
    assert.ok(result.suggestions.some((s) => s.agentId === 'de.byte5.integration.odoo'));
  });

  it('suggests confluence for playbook intent', async () => {
    const result = await suggestDependsOnTool.run(
      { intent: 'summarise our Confluence playbooks for new staff' },
      harness.context(),
    );
    assert.ok(
      result.suggestions.some((s) => s.agentId === 'de.byte5.integration.confluence'),
    );
  });

  it('suggests microsoft365 for calendar intent (German)', async () => {
    const result = await suggestDependsOnTool.run(
      { intent: 'Meeting im Kalender finden und Outlook-Mail versenden' },
      harness.context(),
    );
    assert.ok(
      result.suggestions.some((s) => s.agentId === 'de.byte5.integration.microsoft365'),
    );
  });

  it('returns empty suggestions for an unrelated intent', async () => {
    const result = await suggestDependsOnTool.run(
      { intent: 'render markdown to pdf' },
      harness.context(),
    );
    assert.deepEqual(result.suggestions, []);
  });

  it('deduplicates when multiple keywords map to the same agent', async () => {
    const result = await suggestDependsOnTool.run(
      { intent: 'Odoo Buchhaltung mit Rechnung-Workflow' },
      harness.context(),
    );
    const odooHits = result.suggestions.filter(
      (s) => s.agentId === 'de.byte5.integration.odoo',
    );
    assert.equal(odooHits.length, 1);
  });

  it('rejects empty intent via Zod', () => {
    assert.throws(() => suggestDependsOnTool.input.parse({ intent: '' }));
  });
});
