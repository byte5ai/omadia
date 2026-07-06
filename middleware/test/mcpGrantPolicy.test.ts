import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  isMcpGrantBlocked,
  MCP_SEVERITIES_NEEDING_ACK,
  mcpDispatchDenial,
  refreshMcpGrantPolicy,
  resetMcpGrantPolicyForTests,
} from '../src/services/mcpGrantPolicy.js';
import { CURRENT_VERIFIER_VERSION, type Severity } from '../src/services/skillVerdict.js';

import type { AgentGraphStore, McpToolVerdictAckRow, McpToolVerdictRow } from '@omadia/orchestrator';

const SERVER = '00000000-0000-4000-8000-0000000000aa';

function verdict(toolName: string, severity: Severity, contentHash = 'h1'): McpToolVerdictRow {
  return {
    serverId: SERVER,
    toolName,
    verifierVersion: CURRENT_VERIFIER_VERSION,
    contentHash,
    severity,
    riskCodes: [],
    computedAt: new Date(),
  };
}

function ack(toolName: string, contentHash = 'h1'): McpToolVerdictAckRow {
  return {
    serverId: SERVER,
    toolName,
    verifierVersion: CURRENT_VERIFIER_VERSION,
    contentHash,
    ackedBy: 'op@example.com',
    ackedAt: new Date(),
  };
}

function fakeGraph(
  verdicts: McpToolVerdictRow[],
  acks: McpToolVerdictAckRow[],
): AgentGraphStore {
  return {
    listMcpToolVerdicts: async () => verdicts,
    listMcpToolVerdictAcks: async () => acks,
  } as unknown as AgentGraphStore;
}

afterEach(() => resetMcpGrantPolicyForTests());

describe('mcpGrantPolicy', () => {
  it('blocks high_risk without ack, allows benign', async () => {
    await refreshMcpGrantPolicy(fakeGraph([verdict('evil', 'high_risk'), verdict('sum', 'no_signals')], []));
    assert.equal(isMcpGrantBlocked(SERVER, 'evil'), true);
    assert.equal(isMcpGrantBlocked(SERVER, 'sum'), false);
  });

  it('unblocks a hash-matching ack, keeps blocking a stale one', async () => {
    await refreshMcpGrantPolicy(
      fakeGraph(
        [verdict('acked', 'high_risk', 'h1'), verdict('stale', 'high_risk', 'h2')],
        [ack('acked', 'h1'), ack('stale', 'h-old')],
      ),
    );
    assert.equal(isMcpGrantBlocked(SERVER, 'acked'), false);
    assert.equal(isMcpGrantBlocked(SERVER, 'stale'), true);
  });

  it('treats scan_failed and too_large_to_scan as ack-requiring, not silently clean', async () => {
    assert.ok(MCP_SEVERITIES_NEEDING_ACK.has('scan_failed'));
    assert.ok(MCP_SEVERITIES_NEEDING_ACK.has('too_large_to_scan'));
    await refreshMcpGrantPolicy(fakeGraph([verdict('crashy', 'scan_failed')], []));
    assert.equal(isMcpGrantBlocked(SERVER, 'crashy'), true);
  });

  it('a refresh replaces the previous blocklist wholesale', async () => {
    await refreshMcpGrantPolicy(fakeGraph([verdict('evil', 'high_risk')], []));
    assert.equal(isMcpGrantBlocked(SERVER, 'evil'), true);
    await refreshMcpGrantPolicy(fakeGraph([verdict('evil', 'no_signals')], []));
    assert.equal(isMcpGrantBlocked(SERVER, 'evil'), false);
  });

  it('unknown pairs are not hydration-blocked (specs stay visible on existing installs)', async () => {
    await refreshMcpGrantPolicy(fakeGraph([], []));
    assert.equal(isMcpGrantBlocked(SERVER, 'never_scanned'), false);
  });

  it('dispatch denial: blocked pair names the severity, unscanned pair demands discover, clean pair passes', async () => {
    await refreshMcpGrantPolicy(
      fakeGraph([verdict('evil', 'high_risk'), verdict('sum', 'no_signals')], []),
    );
    assert.ok(mcpDispatchDenial(SERVER, 'evil')?.includes('high_risk'));
    assert.ok(mcpDispatchDenial(SERVER, 'never_scanned')?.includes('no current scan verdict'));
    assert.equal(mcpDispatchDenial(SERVER, 'sum'), null);
  });

  it('an older refresh finishing late cannot overwrite a newer blocklist (generation race)', async () => {
    let releaseOld: () => void = () => undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    // Old refresh: reads CLEAN data, but its reads resolve only after the gate.
    const oldGraph = {
      listMcpToolVerdicts: async () => {
        await oldGate;
        return [verdict('evil', 'no_signals')];
      },
      listMcpToolVerdictAcks: async () => [],
    } as unknown as AgentGraphStore;
    // New refresh: sees the tool as high_risk, resolves immediately.
    const newGraph = fakeGraph([verdict('evil', 'high_risk')], []);

    const oldRefresh = refreshMcpGrantPolicy(oldGraph);
    await refreshMcpGrantPolicy(newGraph);
    assert.equal(isMcpGrantBlocked(SERVER, 'evil'), true);
    releaseOld();
    await oldRefresh;
    // The stale result must NOT have reopened the tool.
    assert.equal(isMcpGrantBlocked(SERVER, 'evil'), true);
  });
});
