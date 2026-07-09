import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { Severity } from './skillVerdict.js';

/**
 * Static code scanning for executable plugin packages (issue #453).
 *
 * `PluginScanner` is the seam between the ingest pipeline and the NVIDIA
 * SkillSpector sidecar: one method, directory in, normalized `ScanResult`
 * out. `HttpSkillSpectorScanner` posts the package's file tree to the
 * sidecar's `POST /scan` shim (which runs `skillspector scan <dir>
 * --no-llm --format json`). Deployments without a configured sidecar
 * (`SKILLSPECTOR_URL` unset) wire NO scanner and NO scheduler at all — no
 * verdict rows are written, store pages show no badge; `scan_failed` is
 * reserved for REAL scanner failures.
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

/**
 * #453 (codex review fix) — shared skip predicate for `lifecycle.entry`
 * validation. Returns the first path segment that makes the path
 * unscannable (a `SKIPPED_DIRS` member or any hidden `.`-prefixed
 * segment), or `null` when every segment is scannable. Upload validation
 * uses this to REJECT packages whose entry point the scanner would never
 * see; no legitimate omadia plugin places its entry there (the boilerplate
 * uses `dist/plugin.js`). Deliberately broader than `collectFiles`' own
 * walk (which only skips `SKIPPED_DIRS`): hidden segments are rejected
 * up-front too, so the accepted surface stays conservative.
 */
export function findUnscannableSegment(relPath: string): string | null {
  for (const segment of relPath.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (SKIPPED_DIRS.has(segment) || segment.startsWith('.')) return segment;
  }
  return null;
}

export interface ScanFinding {
  /** SkillSpector detector id, e.g. 'E2', 'YR1', 'LP3', 'OH1'. */
  readonly code: string;
  /** SkillSpector-native severity: CRITICAL | HIGH | MEDIUM | LOW. */
  readonly severity: string;
  readonly message: string;
  readonly file: string | null;
}

export interface ScanResult {
  /** 'failed' = the scanner errored (sidecar down/timeout/bad schema). */
  readonly status: 'scanned' | 'failed';
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

    let collected: ScanPayload;
    try {
      collected = await collectScanPayload(dir);
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
    // #453 (codex review fix) — fail CLOSED when the executed entry point is
    // not part of the payload: a package whose `lifecycle.entry` the scanner
    // never saw must surface as `scan_failed`, never as a `no_signals`
    // all-clear.
    if (collected.coverageError !== null) {
      return failed(collected.coverageError);
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

export interface ScanPayload extends CollectedFiles {
  /** `null` when the manifest's `lifecycle.entry` file is guaranteed to be
   *  part of `files`; otherwise the reason coverage cannot be guaranteed
   *  (the caller degrades to `scan_failed`). Undefined semantics only when
   *  `tooLarge` is set (the payload is discarded then anyway). */
  coverageError: string | null;
}

/**
 * #453 (codex review fix) — collect the file tree AND guarantee coverage of
 * the executed entry point. `collectFiles` skips `SKIPPED_DIRS`
 * (node_modules, .git) because they carry no scannable plugin code — but
 * the manifest's `lifecycle.entry` may point exactly there, and the runtime
 * would import it. Upload validation rejects such entries for NEW packages
 * (`findUnscannableSegment`); this is the defense-in-depth layer behind it:
 * when the walk dropped the entry file, it is force-included in the
 * payload, and when it cannot be included (missing, symlink, oversize,
 * escapes the root, undeterminable manifest) the scan fails CLOSED.
 */
export async function collectScanPayload(dir: string): Promise<ScanPayload> {
  const collected = await collectFiles(dir);
  if (collected.tooLarge) return { ...collected, coverageError: null };
  const coverageError = await ensureEntryCovered(dir, collected.files);
  return { ...collected, coverageError };
}

/** Read `lifecycle.entry` from the package manifest; defaults to
 *  `dist/plugin.js` (mirroring `packageUploadService`). Returns `null` when
 *  the manifest is missing or unparseable — the entry point cannot be
 *  determined then, so coverage cannot be guaranteed. */
async function readManifestEntry(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.yaml'), 'utf-8');
    const manifest: unknown = parseYaml(raw);
    if (!manifest || typeof manifest !== 'object') return null;
    const lifecycle = (manifest as Record<string, unknown>)['lifecycle'];
    const entry =
      lifecycle && typeof lifecycle === 'object'
        ? (lifecycle as Record<string, unknown>)['entry']
        : undefined;
    return typeof entry === 'string' && entry.length > 0
      ? entry
      : 'dist/plugin.js';
  } catch {
    return null;
  }
}

/** Returns `null` when the entry file is covered by `files` (force-including
 *  it when the walk skipped it), or the fail-closed reason otherwise. */
async function ensureEntryCovered(
  dir: string,
  files: { path: string; content_b64: string }[],
): Promise<string | null> {
  const entryRel = await readManifestEntry(dir);
  if (entryRel === null) {
    return (
      'manifest.yaml is missing or unparseable — the executed entry point ' +
      'cannot be determined, so scan coverage cannot be guaranteed.'
    );
  }
  const root = path.resolve(dir);
  const absEntry = path.resolve(root, entryRel);
  if (!absEntry.startsWith(root + path.sep)) {
    return `lifecycle.entry '${entryRel}' escapes the package root — scan coverage cannot be guaranteed.`;
  }
  const relPosix = path.relative(root, absEntry).split(path.sep).join('/');
  if (files.some((f) => f.path === relPosix)) return null;
  // The walk dropped it (skipped dir / symlink) or it is absent: force-
  // include plain, in-cap regular files; anything else fails closed.
  let stat;
  try {
    stat = await fs.lstat(absEntry);
  } catch {
    return `lifecycle.entry '${entryRel}' does not exist in the package — scan coverage cannot be guaranteed.`;
  }
  if (!stat.isFile()) {
    return `lifecycle.entry '${entryRel}' is not a regular file — scan coverage cannot be guaranteed.`;
  }
  if (stat.size > MAX_FILE_BYTES) {
    return `lifecycle.entry '${entryRel}' exceeds the per-file scan cap — scan coverage cannot be guaranteed.`;
  }
  const content = await fs.readFile(absEntry);
  files.push({ path: relPosix, content_b64: content.toString('base64') });
  return null;
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
 * FAIL-CLOSED mapping of the sidecar shim's JSON onto `ScanResult`
 * (second-review fix). The shim's contract is exactly
 * `{ok: true, scanner_version, findings: [{code, severity, message, file}]}`
 * (the shim itself positively verifies SkillSpector's report schema and
 * answers `ok: false` on any mismatch — see
 * middleware/sidecars/skillspector/server.py). No alternate field spellings
 * are guessed here: anything that is not the promised contract degrades to
 * `scan_failed`, never to an implicit `no_signals` all-clear.
 */
export function parseSidecarResponse(body: unknown): ScanResult {
  if (!body || typeof body !== 'object') {
    return failed('Scanner sidecar returned a non-object response.');
  }
  const record = body as Record<string, unknown>;
  if (record['ok'] !== true) {
    const message =
      typeof record['error'] === 'string' ? record['error'] : 'unknown scanner error';
    return failed(`Scanner reported failure: ${message}`);
  }
  const rawFindings = record['findings'];
  if (!Array.isArray(rawFindings)) {
    return failed('Scanner sidecar response carries no findings array.');
  }
  const findings: ScanFinding[] = [];
  for (const raw of rawFindings) {
    if (!raw || typeof raw !== 'object') {
      return failed('Scanner sidecar response carries a non-object finding.');
    }
    const f = raw as Record<string, unknown>;
    findings.push({
      code: firstString(f, ['code']) ?? 'unknown',
      severity: firstString(f, ['severity']) ?? 'LOW',
      message: firstString(f, ['message']) ?? '',
      file: firstString(f, ['file']),
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
