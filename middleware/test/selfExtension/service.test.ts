import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import type { BuildPipeline, PipelineRunResult } from '../../src/plugins/builder/buildPipeline.js';
import type { PackageUploadService } from '../../src/plugins/packageUploadService.js';
import { OperatorGate } from '../../src/plugins/selfExtension/operatorGate.js';
import { ExtensionStore } from '../../src/plugins/selfExtension/extensionStore.js';
import { materializeApprovedProposal } from '../../src/plugins/selfExtension/service.js';
import {
  parseExtensionProposal,
  parseTemplateProposal,
} from '../../src/plugins/selfExtension/extensionProposal.js';
import type { ExtensionTemplate } from '@omadia/plugin-api';
import type { Plugin } from '../../src/api/admin-v1.js';
import { baseSpec } from './_fixtures.js';

const PLUGIN_ID = 'de.byte5.agent.dynamics';
const USER = 'op@byte5.de';

function fakePipeline(buildOk: boolean): BuildPipeline {
  const buildResult = buildOk
    ? { ok: true as const, zip: Buffer.from('PK-fake'), zipPath: '/tmp/x.zip', durationMs: 1 }
    : {
        ok: false as const,
        errors: [],
        exitCode: 1,
        stdoutTail: '',
        stderrTail: 'tsc error',
        durationMs: 1,
        reason: 'tsc' as const,
      };
  return {
    run: async (): Promise<PipelineRunResult> =>
      ({
        buildN: 1,
        draft: { id: 'ignored', spec: { id: PLUGIN_ID, version: '0.1.0' } },
        buildResult,
      }) as unknown as PipelineRunResult,
  } as unknown as BuildPipeline;
}

function fakeUploadService(): PackageUploadService {
  return {
    ingest: async () => ({
      ok: true as const,
      plugin_id: PLUGIN_ID,
      version: '0.2.0',
      package: { zip_bytes: 7 },
    }),
  } as unknown as PackageUploadService;
}

function approvedGate(): { gate: OperatorGate; proposalId: string } {
  let n = 0;
  const gate = new OperatorGate({ now: () => 1, genId: () => `p${++n}` });
  const proposal = parseExtensionProposal({
    pluginId: PLUGIN_ID,
    rationale: 'add aggregation tool',
    patches: [{ op: 'add', path: '/tools/-', value: { id: 'dynamics_aggregate', description: 'agg', input: {} } }],
  });
  const rec = gate.submit({ pluginId: PLUGIN_ID, currentSpec: baseSpec(), proposal, submittedBy: 'agent:dynamics' });
  gate.approve({ id: rec.id, decidedBy: USER });
  return { gate, proposalId: rec.id };
}

describe('materializeApprovedProposal', () => {
  let dir: string;
  let store: DraftStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'selfext-svc-'));
    store = new DraftStore({ dbPath: path.join(dir, 'drafts.db') });
    await store.open();
  });
  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drives an approved proposal through install and marks it installed', async () => {
    const { gate, proposalId } = approvedGate();
    const res = await materializeApprovedProposal(
      { proposalId, userEmail: USER },
      { gate, draftStore: store, buildPipeline: fakePipeline(true), packageUploadService: fakeUploadService() },
    );
    assert.equal(res.ok, true);
    if (res.ok && res.kind === 'spec') {
      assert.equal(res.install.publishedAgentId, PLUGIN_ID);
      assert.equal(res.install.version, '0.2.0');
    } else {
      assert.fail('expected a spec-kind install result');
    }
    assert.equal(gate.get(proposalId)?.status, 'installed');
  });

  it('reflects a build failure back onto the record as install_failed', async () => {
    const { gate, proposalId } = approvedGate();
    const res = await materializeApprovedProposal(
      { proposalId, userEmail: USER },
      { gate, draftStore: store, buildPipeline: fakePipeline(false), packageUploadService: fakeUploadService() },
    );
    assert.equal(res.ok, false);
    assert.equal(gate.get(proposalId)?.status, 'install_failed');
  });

  it('materialises a template proposal: persists the extension + reactivates', async () => {
    const gate = new OperatorGate({ now: () => 1, genId: () => 'pt1' });
    const plugin = {
      id: PLUGIN_ID,
      depends_on: [],
      privacy_class: 'strict',
      permissions_summary: {
        memory_reads: [], memory_writes: [], graph_reads: [], graph_writes: [],
        network_outbound: ['api.dynamics.com'],
      },
    } as unknown as Plugin;
    const template: ExtensionTemplate = {
      id: 'odata.delta', title: 'Delta', description: 'd', paramsSchema: { type: 'object' },
      requires: { networkOutbound: ['api.dynamics.com'] },
    };
    const proposal = parseTemplateProposal({ pluginId: PLUGIN_ID, rationale: 'delta', templateId: 'odata.delta', params: { entitySet: 'salesorders' } });
    const rec = gate.submit({ kind: 'template', pluginId: PLUGIN_ID, plugin, template, proposal, submittedBy: 'agent' });
    gate.approve({ id: rec.id, decidedBy: USER });

    const extStore = new ExtensionStore(path.join(dir, 'ext.json'));
    await extStore.load();
    const reactivated: string[] = [];

    const res = await materializeApprovedProposal(
      { proposalId: rec.id, userEmail: USER },
      { gate, extensionStore: extStore, reactivate: async (id) => { reactivated.push(id); } },
    );
    assert.equal(res.ok, true);
    if (res.ok && res.kind === 'template') {
      assert.equal(res.templateId, 'odata.delta');
    } else {
      assert.fail('expected a template-kind result');
    }
    assert.deepEqual(reactivated, [PLUGIN_ID]);
    assert.equal(extStore.list(PLUGIN_ID).length, 1);
    assert.equal(gate.get(rec.id)?.status, 'installed');
  });

  it('refuses to materialise a proposal that is not approved', async () => {
    const gate = new OperatorGate({ now: () => 1, genId: () => 'p1' });
    const proposal = parseExtensionProposal({
      pluginId: PLUGIN_ID,
      rationale: 'x',
      patches: [{ op: 'add', path: '/tools/-', value: { id: 't', description: 'd', input: {} } }],
    });
    const rec = gate.submit({ pluginId: PLUGIN_ID, currentSpec: baseSpec(), proposal, submittedBy: 'agent' });
    const res = await materializeApprovedProposal(
      { proposalId: rec.id, userEmail: USER },
      { gate, draftStore: store, buildPipeline: fakePipeline(true), packageUploadService: fakeUploadService() },
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.stage, 'precondition');
  });
});
