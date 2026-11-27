/**
 * #2338 / ADR-0298 — Office renders in-process and delivers its file only
 * into the turn's own answer, so it declares `side_effects: none` and the integration
 * egress lets them run whatever the turn read; the answer's people egress then
 * decides whether the file goes out (`guardAnswerEgress` drops it with a
 * withheld answer). Before, it declared nothing, so a fresh web chat that
 * carried any label from another conversation (recall, memory) refused every
 * export with `integration_undeclared`.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { CREATE_DOCX_TOOL_NAME, CREATE_XLSX_TOOL_NAME } from '../../packages/harness-plugin-office/src/officeTool.js';
import { readersOf, unionLabels, type DiscretionLabel } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import type { DiscretionPort } from '../../packages/harness-orchestrator/src/discretion/port.js';
import { guardIntegrationEgress } from '../../packages/harness-orchestrator/src/discretion/toolFlow.js';
import { createDiscretionTurnState } from '../../packages/harness-orchestrator/src/discretion/turnLabels.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { loadManifestFromPath } from '../../src/plugins/manifestLoader.js';
import { declaredToolEffect } from '../../src/plugins/toolSideEffects.js';

const OFFICE = '@omadia/plugin-office';

async function manifest(pkg: string) {
  const path = fileURLToPath(new URL(`../../packages/${pkg}/manifest.yaml`, import.meta.url));
  const entry = await loadManifestFromPath(path);
  assert.ok(entry, `${pkg} manifest did not load`);
  return entry.plugin;
}

// The web chat's own context and a label recalled from another conversation
// of the same person (another chat, a Teams thread).
const OWN_KEY = 'http:personal:user-1';
const otherConversation: DiscretionLabel = { kind: 'context', key: 'owner:user-1', readers: readersOf(['user-1']) };

describe('file tools are no integration egress (#2338)', () => {
  it('Office declares `none` for every tool it registers', async () => {
    const office = await manifest('harness-plugin-office');
    assert.equal(office.id, OFFICE);
    for (const tool of [CREATE_XLSX_TOOL_NAME, CREATE_DOCX_TOOL_NAME]) {
      assert.equal(declaredToolEffect(office, tool), 'none', tool);
    }
  });

  it('Diagrams declares nothing in its manifest: its effect follows the Kroki endpoint at activation (ADR-0299)', async () => {
    const diagrams = await manifest('harness-diagrams');
    assert.equal(diagrams.tool_side_effects, undefined);
  });

  it('a web-chat turn with a label from another conversation may export; an undeclared tool may not', async () => {
    const office = await manifest('harness-plugin-office');
    const port: DiscretionPort = {
      declarationOf: async () => undefined,
      labelsOf: async () => new Map(),
      persistLabels: async () => undefined,
      audit: () => undefined,
      toolEffectOf: (system, toolName) => (system === OFFICE ? declaredToolEffect(office, toolName) : 'unknown'),
    };
    const discretion = createDiscretionTurnState({
      contextKey: OWN_KEY,
      resolveReaders: async () => readersOf(['user-1']),
      initial: unionLabels([otherConversation]),
    });
    const call = (toolName: string, system: string) =>
      turnContext.run({ turnId: 't', turnDate: '2026-11-27', discretion }, () =>
        guardIntegrationEgress(port, toolName, { system, effect: 'unknown' }),
      );
    assert.equal(await call(CREATE_XLSX_TOOL_NAME, OFFICE), undefined);
    assert.equal(await call(CREATE_DOCX_TOOL_NAME, OFFICE), undefined);
    assert.match((await call('crm_create_note', '@acme/crm')) ?? '', /was not called/);
  });
});
