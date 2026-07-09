import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HttpSkillSpectorScanner,
  mapSkillSpectorSeverity,
  NullPluginScanner,
  parseSidecarResponse,
  PLUGIN_SCANNER_VERSION,
  type ScanFinding,
} from '../src/services/pluginScanner.js';

function finding(severity: string, code = 'E2'): ScanFinding {
  return { code, severity, message: 'test finding', file: null };
}

describe('mapSkillSpectorSeverity', () => {
  it('maps an empty finding list to no_signals', () => {
    assert.equal(mapSkillSpectorSeverity([]), 'no_signals');
  });

  it('maps CRITICAL/HIGH findings to high_risk (case-insensitive)', () => {
    assert.equal(mapSkillSpectorSeverity([finding('CRITICAL')]), 'high_risk');
    assert.equal(mapSkillSpectorSeverity([finding('high')]), 'high_risk');
    assert.equal(
      mapSkillSpectorSeverity([finding('LOW'), finding('HIGH')]),
      'high_risk',
    );
  });

  it('maps MEDIUM/LOW-only findings to flagged', () => {
    assert.equal(mapSkillSpectorSeverity([finding('MEDIUM')]), 'flagged');
    assert.equal(mapSkillSpectorSeverity([finding('LOW'), finding('MEDIUM')]), 'flagged');
  });
});

describe('parseSidecarResponse', () => {
  it('maps a well-formed sidecar response', () => {
    const result = parseSidecarResponse({
      ok: true,
      scanner_version: '1.2.3',
      findings: [
        { code: 'YR1', severity: 'CRITICAL', message: 'webshell signature', file: 'dist/plugin.js' },
      ],
    });
    assert.equal(result.status, 'scanned');
    assert.equal(result.severity, 'high_risk');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.code, 'YR1');
    assert.equal(result.findings[0]!.file, 'dist/plugin.js');
    assert.equal(result.scannerVersion, `${PLUGIN_SCANNER_VERSION} (1.2.3)`);
  });

  it('tolerates alternate field spellings', () => {
    const result = parseSidecarResponse({
      results: [{ id: 'LP2', level: 'MEDIUM', description: 'permission mismatch' }],
    });
    assert.equal(result.severity, 'flagged');
    assert.equal(result.findings[0]!.code, 'LP2');
    assert.equal(result.findings[0]!.severity, 'MEDIUM');
    assert.equal(result.findings[0]!.message, 'permission mismatch');
  });

  it('degrades to scan_failed on ok:false, non-objects, and missing findings', () => {
    assert.equal(parseSidecarResponse({ ok: false, error: 'boom' }).severity, 'scan_failed');
    assert.equal(parseSidecarResponse(null).severity, 'scan_failed');
    assert.equal(parseSidecarResponse('nope').severity, 'scan_failed');
    assert.equal(parseSidecarResponse({ ok: true }).severity, 'scan_failed');
  });
});

describe('NullPluginScanner', () => {
  it('reports skipped + scan_failed without touching the directory', async () => {
    const result = await new NullPluginScanner().scan('/does/not/exist');
    assert.equal(result.status, 'skipped');
    assert.equal(result.severity, 'scan_failed');
    assert.equal(result.findings.length, 0);
  });
});

describe('HttpSkillSpectorScanner', () => {
  it('never throws on an unreachable sidecar — degrades to scan_failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-test-'));
    await fs.writeFile(path.join(dir, 'manifest.yaml'), 'schema_version: "1"\n');
    try {
      const scanner = new HttpSkillSpectorScanner({
        // Reserved TEST-NET-1 address — guaranteed unreachable, and the
        // 500ms timeout keeps the failure fast either way.
        baseUrl: 'http://192.0.2.1:1',
        timeoutMs: 500,
        log: () => undefined,
      });
      const result = await scanner.scan(dir);
      assert.equal(result.status, 'failed');
      assert.equal(result.severity, 'scan_failed');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports scan_failed for an unreadable package directory', async () => {
    const scanner = new HttpSkillSpectorScanner({
      baseUrl: 'http://192.0.2.1:1',
      timeoutMs: 500,
      log: () => undefined,
    });
    const result = await scanner.scan(path.join(os.tmpdir(), 'scan-test-missing-dir'));
    assert.equal(result.status, 'failed');
    assert.equal(result.severity, 'scan_failed');
  });
});
