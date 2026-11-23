/**
 * Spec 2042 §5.11 / §6 criterion 17 with declared tool effects: which plugin
 * tool calls are checked against the integration's readership.
 *
 *  - declared `write` (manifest `side_effects`): checked against every label;
 *  - declared `read` / `none`: not checked;
 *  - declared nothing (`unknown`): like a write since the contract step
 *    (S3b), checked against every label.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { readersOf, unionLabels, type DiscretionLabel, type LabelSet } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import type { DiscretionPort } from '../../packages/harness-orchestrator/src/discretion/port.js';
import { createDiscretionTurnState } from '../../packages/harness-orchestrator/src/discretion/turnLabels.js';
import { guardIntegrationEgress } from '../../packages/harness-orchestrator/src/discretion/toolFlow.js';

const hrRecord: DiscretionLabel = { kind: 'source', system: '@omadia/odoo-hr', restricted: true };
const otherRoom: DiscretionLabel = { kind: 'context', key: 'teams:dm-ab', readers: readersOf(['a', 'b']) };

const EFFECTS: Record<string, 'read' | 'write' | 'none'> = {
  crm_create_note: 'write',
  crm_search: 'read',
  crm_format: 'none',
};

const port: DiscretionPort = {
  declarationOf: async () => undefined,
  labelsOf: async () => new Map(),
  persistLabels: async () => undefined,
  audit: () => undefined,
  toolEffectOf: (system, toolName) => (system === '@omadia/crm' ? (EFFECTS[toolName] ?? 'unknown') : 'unknown'),
  pluginEffectOf: (system) => (system === '@omadia/crm' ? 'write' : 'unknown'),
};

function call(toolName: string, labels: LabelSet) {
  const discretion = createDiscretionTurnState({
    contextKey: 'teams:sales',
    resolveReaders: async () => readersOf(['a', 'b', 'c']),
    initial: labels,
  });
  return turnContext.run({ turnId: 't', turnDate: '2026-11-20', discretion }, () =>
    guardIntegrationEgress(port, toolName, { system: '@omadia/crm', effect: 'unknown' }),
  );
}

describe('declared tool effects at the integration egress (criterion 17)', () => {
  it('a declared write is checked against every label', async () => {
    assert.ok(await call('crm_create_note', unionLabels([hrRecord])));
    assert.ok(await call('crm_create_note', unionLabels([otherRoom])));
  });

  it('declared read and none are not checked', async () => {
    assert.equal(await call('crm_search', unionLabels([hrRecord, otherRoom])), undefined);
    assert.equal(await call('crm_format', unionLabels([hrRecord])), undefined);
  });

  it('a tool that declared nothing is checked like a write (contract step, S3b)', async () => {
    assert.ok(await call('crm_legacy', unionLabels([hrRecord])), 'HR data never reaches an undeclared tool');
    assert.ok(await call('crm_legacy', unionLabels([{ kind: 'classification', class: 'personal' }])));
    assert.ok(await call('crm_legacy', unionLabels([otherRoom])), 'another room’s context does not reach it either');
  });

  it('a plugin\'s sub-agent (domain tool) counts as a write when any of its tools declared one', async () => {
    const discretion = createDiscretionTurnState({
      contextKey: 'teams:sales',
      resolveReaders: async () => readersOf(['a', 'b', 'c']),
      initial: unionLabels([otherRoom]),
    });
    const run = (system: string) =>
      turnContext.run({ turnId: 't', turnDate: '2026-11-20', discretion }, () =>
        guardIntegrationEgress(port, `query_${system}`, { system, effect: 'unknown', subAgent: true }),
      );
    assert.ok(await run('@omadia/crm'), 'a declared write in the plugin: checked against every label');
    assert.ok(await run('@omadia/wiki'), 'nothing declared: like a write');
  });
});
