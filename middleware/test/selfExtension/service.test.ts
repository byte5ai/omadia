import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import type { BuildPipeline, PipelineRunResult } from '../../src/plugins/builder/buildPipeline.js';
import type { PackageUploadService } from '../../src/plugins/packageUploadService.js';
import { OperatorGate } from '../../src/plugins/selfExtension/operatorGate.js';
import { materializeApprovedProposal } from '../../src/plugins/selfExtension/service.js';
import { parseExtensionProposal } from '../../src/plugins/selfExtension/extensionProposal.js';
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
    if (res.ok) {
      assert.equal(res.install.publishedAgentId, PLUGIN_ID);
      assert.equal(res.install.version, '0.2.0');
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
