import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectScanPayload,
  findUnscannableSegment,
  HttpSkillSpectorScanner,
  mapSkillSpectorSeverity,
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

  it('fails CLOSED on any schema the shim did not promise (no guessing)', () => {
    // Second-review fix: an unrecognized schema must surface as
    // `scan_failed`, never as an implicit all-clear.
    const result = parseSidecarResponse({
      results: [{ id: 'LP2', level: 'MEDIUM', description: 'permission mismatch' }],
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.severity, 'scan_failed');
  });

  it('degrades to scan_failed on ok:false, non-objects, and missing findings', () => {
    assert.equal(parseSidecarResponse({ ok: false, error: 'boom' }).severity, 'scan_failed');
    assert.equal(parseSidecarResponse(null).severity, 'scan_failed');
    assert.equal(parseSidecarResponse('nope').severity, 'scan_failed');
    assert.equal(parseSidecarResponse({ ok: true }).severity, 'scan_failed');
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

describe('findUnscannableSegment (#453 codex review fix)', () => {
  it('flags node_modules, .git, and hidden segments', () => {
    assert.equal(findUnscannableSegment('node_modules/payload/plugin.js'), 'node_modules');
    assert.equal(findUnscannableSegment('dist/node_modules/x.js'), 'node_modules');
    assert.equal(findUnscannableSegment('.git/hooks/plugin.js'), '.git');
    assert.equal(findUnscannableSegment('.hidden/plugin.js'), '.hidden');
  });

  it('accepts the boilerplate layout', () => {
    assert.equal(findUnscannableSegment('dist/plugin.js'), null);
    assert.equal(findUnscannableSegment('dist/sub/plugin.js'), null);
  });
});

describe('collectScanPayload — entry-point coverage guard (#453 codex review fix)', () => {
  async function withTmpDir(
    files: Record<string, string>,
    fn: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-coverage-'));
    try {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
      await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  const manifestWithEntry = (entry: string): string =>
    `schema_version: "1"\nlifecycle:\n  entry: "${entry}"\n`;

  it('force-includes an entry the directory walk skipped (node_modules)', async () => {
    await withTmpDir(
      {
        'manifest.yaml': manifestWithEntry('node_modules/payload/plugin.js'),
        'node_modules/payload/plugin.js': 'module.exports = { activate() {} };\n',
        'dist/other.js': '// decoy the walk does collect\n',
      },
      async (dir) => {
        const payload = await collectScanPayload(dir);
        assert.equal(payload.coverageError, null);
        assert.ok(
          payload.files.some((f) => f.path === 'node_modules/payload/plugin.js'),
          'the executed entry point must be part of the scan payload',
        );
        // The rest of node_modules stays skipped — only the entry is pulled in.
        assert.equal(
          payload.files.filter((f) => f.path.startsWith('node_modules/')).length,
          1,
        );
      },
    );
  });

  it('fails closed when the declared entry file is absent', async () => {
    await withTmpDir(
      { 'manifest.yaml': manifestWithEntry('dist/plugin.js') },
      async (dir) => {
        const payload = await collectScanPayload(dir);
        assert.ok(payload.coverageError, 'missing entry must be a coverage error');
        // End-to-end: the scanner surfaces it as scan_failed WITHOUT any
        // sidecar round-trip (never as a no_signals all-clear).
        const scanner = new HttpSkillSpectorScanner({
          baseUrl: 'http://192.0.2.1:1',
          timeoutMs: 500,
          log: () => undefined,
        });
        const result = await scanner.scan(dir);
        assert.equal(result.status, 'failed');
        assert.equal(result.severity, 'scan_failed');
        assert.ok(result.rationale?.includes('coverage'));
      },
    );
  });

  it('fails closed when the entry is a symlink (never silently included)', async () => {
    await withTmpDir(
      {
        'manifest.yaml': manifestWithEntry('node_modules/payload/plugin.js'),
        'real.js': 'module.exports = {};\n',
      },
      async (dir) => {
        await fs.mkdir(path.join(dir, 'node_modules/payload'), { recursive: true });
        await fs.symlink(
          path.join(dir, 'real.js'),
          path.join(dir, 'node_modules/payload/plugin.js'),
        );
        const payload = await collectScanPayload(dir);
        assert.ok(payload.coverageError, 'a symlinked entry must be a coverage error');
      },
    );
  });

  it('covers the normal boilerplate layout without a coverage error', async () => {
    await withTmpDir(
      {
        'manifest.yaml': manifestWithEntry('dist/plugin.js'),
        'dist/plugin.js': 'module.exports = { activate() {} };\n',
      },
      async (dir) => {
        const payload = await collectScanPayload(dir);
        assert.equal(payload.coverageError, null);
        assert.ok(payload.files.some((f) => f.path === 'dist/plugin.js'));
      },
    );
  });
});
