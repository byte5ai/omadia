import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  PLUGIN_SCANNER_VERSION,
  type PluginScanner,
  type ScanResult,
} from '../src/services/pluginScanner.js';
import {
  createPluginScanScheduler,
  createPluginVerdictLookup,
  type PluginVerdictRow,
  type PluginVerdictStore,
} from '../src/services/pluginVerdict.js';

/** Mirrors the SQL severity rank in agentGraphStore.upsertPluginVerdict. */
const SEVERITY_ORDER: Record<string, number> = {
  no_signals: 0,
  pending: 1,
  scan_failed: 2,
  too_large_to_scan: 3,
  flagged: 4,
  high_risk: 5,
};

class FakePluginVerdictStore implements PluginVerdictStore {
  readonly rows = new Map<string, PluginVerdictRow>();
  /** Severity at ack time, keyed like `rows` — mirrors `ack_severity`. */
  readonly ackSeverities = new Map<string, string>();
  upsertCalls = 0;

  async getPluginVerdict(
    contentHash: string,
    verifierVersion: string,
  ): Promise<PluginVerdictRow | undefined> {
    return this.rows.get(`${contentHash}:${verifierVersion}`);
  }

  async getLatestPluginVerdict(
    pluginId: string,
    verifierVersion: string,
  ): Promise<PluginVerdictRow | undefined> {
    let latest: PluginVerdictRow | undefined;
    for (const row of this.rows.values()) {
      if (row.pluginId !== pluginId || row.verifierVersion !== verifierVersion) continue;
      if (!latest || row.computedAt > latest.computedAt) latest = row;
    }
    return latest;
  }

  async upsertPluginVerdict(row: PluginVerdictRow): Promise<void> {
    this.upsertCalls += 1;
    const key = `${row.contentHash}:${row.verifierVersion}`;
    // Mirror the SQL upsert: scan columns are rewritten; the ack survives
    // only while the new severity is equal or BETTER than the severity the
    // operator acknowledged (a worse re-scan result clears the ack).
    const existing = this.rows.get(key);
    const ackedSeverity =
      this.ackSeverities.get(key) ?? (existing ? existing.severity : undefined);
    const ackSurvives =
      existing?.ackBy != null &&
      ackedSeverity !== undefined &&
      SEVERITY_ORDER[row.severity]! <= SEVERITY_ORDER[ackedSeverity]!;
    if (!ackSurvives) this.ackSeverities.delete(key);
    this.rows.set(key, {
      ...row,
      ackBy: ackSurvives ? existing.ackBy : null,
      ackAt: ackSurvives ? existing.ackAt : null,
    });
  }

  async getPluginVerdictsByShas(
    contentHashes: readonly string[],
    verifierVersion: string,
  ): Promise<Map<string, PluginVerdictRow>> {
    const out = new Map<string, PluginVerdictRow>();
    for (const hash of contentHashes) {
      const row = this.rows.get(`${hash}:${verifierVersion}`);
      if (row) out.set(hash, row);
    }
    return out;
  }

  async upsertPluginVerdictAck(
    contentHash: string,
    verifierVersion: string,
    ackedBy: string,
  ): Promise<{ ackBy: string; ackAt: Date } | undefined> {
    const key = `${contentHash}:${verifierVersion}`;
    const existing = this.rows.get(key);
    if (!existing) return undefined;
    const ack = { ackBy: ackedBy, ackAt: new Date() };
    this.ackSeverities.set(key, existing.severity);
    this.rows.set(key, { ...existing, ackBy: ack.ackBy, ackAt: ack.ackAt });
    return ack;
  }
}

class FakeScanner implements PluginScanner {
  scans = 0;
  constructor(private readonly result: ScanResult) {}
  async scan(_dir: string): Promise<ScanResult> {
    this.scans += 1;
    return this.result;
  }
}

const HIGH_RISK_RESULT: ScanResult = {
  status: 'scanned',
  severity: 'high_risk',
  findings: [{ code: 'E2', severity: 'HIGH', message: 'exfil pattern', file: 'dist/plugin.js' }],
  scannerVersion: PLUGIN_SCANNER_VERSION,
  rationale: null,
};

function scanInput(sha = 'sha-1') {
  return { sha256: sha, pluginId: '@test/plugin', installedDir: '/tmp/pkg' };
}

describe('createPluginScanScheduler', () => {
  it('persists the resolved verdict keyed on sha + scanner version', async () => {
    const store = new FakePluginVerdictStore();
    const scanner = new FakeScanner(HIGH_RISK_RESULT);
    const scheduler = createPluginScanScheduler({ store, scanner, log: () => undefined });

    await scheduler.scheduleScan(scanInput());

    const row = await store.getPluginVerdict('sha-1', PLUGIN_SCANNER_VERSION);
    assert.ok(row);
    assert.equal(row.severity, 'high_risk');
    assert.equal(row.pluginId, '@test/plugin');
    assert.equal(row.findings.length, 1);
    // pending row + resolved row
    assert.equal(store.upsertCalls, 2);
  });

  it('is a cache hit for an already-scanned sha (no rescan)', async () => {
    const store = new FakePluginVerdictStore();
    const scanner = new FakeScanner(HIGH_RISK_RESULT);
    const scheduler = createPluginScanScheduler({ store, scanner, log: () => undefined });

    await scheduler.scheduleScan(scanInput());
    await scheduler.scheduleScan(scanInput());

    assert.equal(scanner.scans, 1);
  });

  it('retries operational states (scan_failed) on the next install', async () => {
    const store = new FakePluginVerdictStore();
    const failing = new FakeScanner({
      status: 'failed',
      severity: 'scan_failed',
      findings: [],
      scannerVersion: PLUGIN_SCANNER_VERSION,
      rationale: 'sidecar down',
    });
    const scheduler = createPluginScanScheduler({ store, scanner: failing, log: () => undefined });
    await scheduler.scheduleScan(scanInput());
    assert.equal(
      (await store.getPluginVerdict('sha-1', PLUGIN_SCANNER_VERSION))?.severity,
      'scan_failed',
    );

    const recovered = new FakeScanner(HIGH_RISK_RESULT);
    const scheduler2 = createPluginScanScheduler({ store, scanner: recovered, log: () => undefined });
    await scheduler2.scheduleScan(scanInput());
    assert.equal(recovered.scans, 1);
    assert.equal(
      (await store.getPluginVerdict('sha-1', PLUGIN_SCANNER_VERSION))?.severity,
      'high_risk',
    );
  });

  it('never rejects when the store throws', async () => {
    const store = new FakePluginVerdictStore();
    store.getPluginVerdict = async () => {
      throw new Error('db down');
    };
    const scheduler = createPluginScanScheduler({
      store,
      scanner: new FakeScanner(HIGH_RISK_RESULT),
      log: () => undefined,
    });
    await assert.doesNotReject(() => scheduler.scheduleScan(scanInput()));
  });

  it('clears an ack when a re-scan WORSENS the verdict (scan_failed → high_risk)', async () => {
    const store = new FakePluginVerdictStore();
    const failing = new FakeScanner({
      status: 'failed',
      severity: 'scan_failed',
      findings: [],
      scannerVersion: PLUGIN_SCANNER_VERSION,
      rationale: null,
    });
    await createPluginScanScheduler({ store, scanner: failing, log: () => undefined })
      .scheduleScan(scanInput());
    await store.upsertPluginVerdictAck('sha-1', PLUGIN_SCANNER_VERSION, 'op@example.com');

    // scan_failed is retried; the operator acked a FAILED scan, never these
    // findings — a high_risk upgrade must invalidate the ack.
    await createPluginScanScheduler({
      store,
      scanner: new FakeScanner(HIGH_RISK_RESULT),
      log: () => undefined,
    }).scheduleScan(scanInput());

    const row = await store.getPluginVerdict('sha-1', PLUGIN_SCANNER_VERSION);
    assert.equal(row?.severity, 'high_risk');
    assert.equal(row?.ackBy, null);
    assert.equal(row?.ackAt, null);
  });

  it('keeps an ack when a re-scan is equal or BETTER (scan_failed → no_signals)', async () => {
    const store = new FakePluginVerdictStore();
    const failing = new FakeScanner({
      status: 'failed',
      severity: 'scan_failed',
      findings: [],
      scannerVersion: PLUGIN_SCANNER_VERSION,
      rationale: null,
    });
    await createPluginScanScheduler({ store, scanner: failing, log: () => undefined })
      .scheduleScan(scanInput());
    await store.upsertPluginVerdictAck('sha-1', PLUGIN_SCANNER_VERSION, 'op@example.com');

    // The interim `pending` write of the retry must not destroy the
    // comparison baseline either — the clean result keeps the ack.
    await createPluginScanScheduler({
      store,
      scanner: new FakeScanner({
        status: 'scanned',
        severity: 'no_signals',
        findings: [],
        scannerVersion: PLUGIN_SCANNER_VERSION,
        rationale: null,
      }),
      log: () => undefined,
    }).scheduleScan(scanInput());

    const row = await store.getPluginVerdict('sha-1', PLUGIN_SCANNER_VERSION);
    assert.equal(row?.severity, 'no_signals');
    assert.equal(row?.ackBy, 'op@example.com');
  });
});

describe('createPluginVerdictLookup', () => {
  function seededStore(): FakePluginVerdictStore {
    const store = new FakePluginVerdictStore();
    store.rows.set(`sha-1:${PLUGIN_SCANNER_VERSION}`, {
      contentHash: 'sha-1',
      verifierVersion: PLUGIN_SCANNER_VERSION,
      pluginId: '@test/plugin',
      severity: 'flagged',
      findings: [],
      scannerVersion: PLUGIN_SCANNER_VERSION,
      rationale: null,
      computedAt: new Date('2026-07-09T00:00:00Z'),
      ackBy: null,
      ackAt: null,
    });
    return store;
  }

  it('resolves plugin id → sha256 → verdict view', async () => {
    const lookup = createPluginVerdictLookup({
      store: seededStore(),
      packages: { get: (id) => (id === '@test/plugin' ? { sha256: 'sha-1' } : undefined) },
    });
    const view = await lookup.getForPlugin('@test/plugin');
    assert.equal(view?.severity, 'flagged');
    assert.equal(view?.ack, null);
  });

  it('falls back to the latest verdict when the package record is gone', async () => {
    const lookup = createPluginVerdictLookup({
      store: seededStore(),
      packages: { get: () => undefined },
    });
    const view = await lookup.getForPlugin('@test/plugin');
    assert.equal(view?.severity, 'flagged');
  });

  it('returns undefined for a never-scanned plugin', async () => {
    const lookup = createPluginVerdictLookup({
      store: new FakePluginVerdictStore(),
      packages: { get: () => ({ sha256: 'sha-unknown' }) },
    });
    assert.equal(await lookup.getForPlugin('@test/other'), undefined);
  });

  it('acks via the sha and reports the recorded ack', async () => {
    const store = seededStore();
    const lookup = createPluginVerdictLookup({
      store,
      packages: { get: () => ({ sha256: 'sha-1' }) },
    });
    const ack = await lookup.ack('@test/plugin', 'op@example.com');
    assert.equal(ack?.by, 'op@example.com');
    const view = await lookup.getForPlugin('@test/plugin');
    assert.equal(view?.ack?.by, 'op@example.com');
  });

  it('ack returns undefined when nothing was scanned', async () => {
    const lookup = createPluginVerdictLookup({
      store: new FakePluginVerdictStore(),
      packages: { get: () => ({ sha256: 'sha-unscanned' }) },
    });
    assert.equal(await lookup.ack('@test/plugin', 'op@example.com'), undefined);
  });
});
