import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Severity } from './skillVerdict.js';

/**
 * Static code scanning for executable plugin packages (issue #453).
 *
 * `PluginScanner` is the seam between the ingest pipeline and the NVIDIA
 * SkillSpector sidecar: one method, directory in, normalized `ScanResult`
 * out. Two implementations ship — `HttpSkillSpectorScanner` posts the
 * package's file tree to the sidecar's `POST /scan` shim (which runs
 * `skillspector scan <dir> --no-llm --format json`), and
 * `NullPluginScanner` covers deployments without a configured sidecar.
 *
 * Contract: `scan()` NEVER throws. Every failure mode (sidecar down,
 * timeout, malformed response, unreadable package dir) degrades to a
 * `scan_failed` result — the caller persists it as an advisory verdict and
 * ingest is never affected. See docs/security-architecture.md.
 */

/**
 * Scanner identity persisted with each verdict row. Bump when the sidecar
 * image / detector set changes in a way that should invalidate cached
 * verdicts (mirrors `CURRENT_VERIFIER_VERSION` in skillVerdict.ts).
 */
export const PLUGIN_SCANNER_VERSION = 'skillspector-v1';

/** Caps for the file tree posted to the sidecar. Packages beyond these
 *  bounds report `too_large_to_scan` instead of a partial (misleading)
 *  scan. Extraction is already capped upstream (PACKAGE_UPLOAD_MAX_-
 *  EXTRACTED_BYTES, default 80 MB), so these only bite on outliers. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
/** Directories that carry no scannable plugin code. */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

export interface ScanFinding {
  /** SkillSpector detector id, e.g. 'E2', 'YR1', 'LP3', 'OH1'. */
  readonly code: string;
  /** SkillSpector-native severity: CRITICAL | HIGH | MEDIUM | LOW. */
  readonly severity: string;
  readonly message: string;
  readonly file: string | null;
}

export interface ScanResult {
  /** 'skipped' = no scanner configured; 'failed' = scanner errored. */
  readonly status: 'scanned' | 'skipped' | 'failed';
  readonly severity: Severity;
  readonly findings: readonly ScanFinding[];
  readonly scannerVersion: string;
  readonly rationale: string | null;
}

export interface PluginScanner {
  /** Scan the extracted package at `dir`. Never throws. */
  scan(dir: string): Promise<ScanResult>;
}

/**
 * Map SkillSpector finding severities onto the shared verdict scale.
 * CRITICAL/HIGH (YARA malware/webshell/miner, exfiltration) → `high_risk`;
 * MEDIUM/LOW (permission mismatch, output hygiene) → `flagged`; an empty
 * finding list → `no_signals`.
 */
export function mapSkillSpectorSeverity(findings: readonly ScanFinding[]): Severity {
  if (findings.length === 0) return 'no_signals';
  const hasHigh = findings.some((f) => {
    const s = f.severity.toUpperCase();
    return s === 'CRITICAL' || s === 'HIGH';
  });
  return hasHigh ? 'high_risk' : 'flagged';
}

function failed(rationale: string): ScanResult {
  return {
    status: 'failed',
    severity: 'scan_failed',
    findings: [],
    scannerVersion: PLUGIN_SCANNER_VERSION,
    rationale,
  };
}

/**
 * No-op scanner for deployments without a SkillSpector sidecar
 * (`SKILLSPECTOR_URL` unset) and for tests. Reports `scan_failed` with a
 * `skipped` status so the verdict row is honest about why there is no
 * signal — installs proceed unaffected either way (advisory-only v1).
 */
export class NullPluginScanner implements PluginScanner {
  async scan(_dir: string): Promise<ScanResult> {
    return {
      status: 'skipped',
      severity: 'scan_failed',
      findings: [],
      scannerVersion: PLUGIN_SCANNER_VERSION,
      rationale: 'No code scanner configured (SKILLSPECTOR_URL is unset).',
    };
  }
}

export interface HttpSkillSpectorScannerOptions {
  /** Base URL of the sidecar, e.g. http://skillspector:8811 */
  baseUrl: string;
  timeoutMs: number;
  log?: (msg: string) => void;
}

/**
 * Posts the package file tree as JSON (`{ files: [{path, content_b64}] }`)
 * to the sidecar shim. A file-tree POST instead of a shared volume keeps
 * the middleware and the sidecar deployable as independent machines (the
 * fly.io topology has no shared filesystem between processes).
 */
export class HttpSkillSpectorScanner implements PluginScanner {
  constructor(private readonly opts: HttpSkillSpectorScannerOptions) {}

  async scan(dir: string): Promise<ScanResult> {
    const log = this.opts.log ?? (() => undefined);

    let collected: CollectedFiles;
    try {
      collected = await collectFiles(dir);
    } catch (err) {
      return failed(
        `Package directory unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (collected.tooLarge) {
      return {
        status: 'scanned',
        severity: 'too_large_to_scan',
        findings: [],
        scannerVersion: PLUGIN_SCANNER_VERSION,
        rationale: `Package exceeds the scan size cap (${MAX_TOTAL_BYTES} bytes total / ${MAX_FILE_BYTES} bytes per file).`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: collected.files }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return failed(`Scanner sidecar responded ${res.status}.`);
      }
      const body: unknown = await res.json();
      return parseSidecarResponse(body);
    } catch (err) {
      const reason =
        controller.signal.aborted
          ? `Scanner sidecar timed out after ${this.opts.timeoutMs}ms.`
          : `Scanner sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`;
      log(`[plugin-scan] ${reason}`);
      return failed(reason);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface CollectedFiles {
  files: { path: string; content_b64: string }[];
  tooLarge: boolean;
}

async function collectFiles(dir: string): Promise<CollectedFiles> {
  const out: { path: string; content_b64: string }[] = [];
  let totalBytes = 0;

  async function walk(current: string, relBase: string): Promise<boolean> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(current, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        if (!(await walk(abs, rel))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) return false;
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) return false;
      const content = await fs.readFile(abs);
      out.push({ path: rel, content_b64: content.toString('base64') });
    }
    return true;
  }

  const ok = await walk(dir, '');
  return { files: out, tooLarge: !ok };
}

/**
 * Tolerant mapping of the sidecar's JSON onto `ScanResult`. The shim
 * forwards SkillSpector's `--format json` output; we read the common field
 * spellings defensively so a minor upstream schema change degrades to
 * `scan_failed` (or a finding with an empty code) rather than a throw.
 */
export function parseSidecarResponse(body: unknown): ScanResult {
  if (!body || typeof body !== 'object') {
    return failed('Scanner sidecar returned a non-object response.');
  }
  const record = body as Record<string, unknown>;
  if (record['ok'] === false) {
    const message =
      typeof record['error'] === 'string' ? record['error'] : 'unknown scanner error';
    return failed(`Scanner reported failure: ${message}`);
  }
  const rawFindings = firstArray(record, ['findings', 'results', 'detections']);
  if (!rawFindings) {
    return failed('Scanner sidecar response carries no findings array.');
  }
  const findings: ScanFinding[] = [];
  for (const raw of rawFindings) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    findings.push({
      code: firstString(f, ['code', 'id', 'detector']) ?? 'unknown',
      severity: firstString(f, ['severity', 'level']) ?? 'LOW',
      message: firstString(f, ['message', 'description', 'title']) ?? '',
      file: firstString(f, ['file', 'path', 'location']),
    });
  }
  const scannerVersion =
    typeof record['scanner_version'] === 'string' && record['scanner_version']
      ? `${PLUGIN_SCANNER_VERSION} (${record['scanner_version']})`
      : PLUGIN_SCANNER_VERSION;
  return {
    status: 'scanned',
    severity: mapSkillSpectorSeverity(findings),
    findings,
    scannerVersion,
    rationale: null,
  };
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function firstArray(
  record: Record<string, unknown>,
  keys: string[],
): unknown[] | null {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}
