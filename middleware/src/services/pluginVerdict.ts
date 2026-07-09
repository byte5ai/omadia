import {
  PLUGIN_SCANNER_VERSION,
  type PluginScanner,
  type ScanFinding,
} from './pluginScanner.js';
import type { Severity } from './skillVerdict.js';

/**
 * Plugin code-scan verdicts (issue #453) — persistence port + fire-and-forget
 * scheduler around the `PluginScanner` seam.
 *
 * Mirrors `skillVerdict.ts`: verdicts are derived artifacts keyed on
 * content_hash (the ingested ZIP's sha256) + verifier_version, cached
 * cache-aside so re-installing the same bytes never re-scans. The graph-
 * backed implementation lives in
 * `middleware/packages/harness-orchestrator/src/registry/agentGraphStore.ts`.
 *
 * Advisory-only v1: `scheduleScan` runs strictly AFTER a successful ingest,
 * never inline, and never throws — a scanner outage degrades to a
 * `scan_failed` verdict row, not a failed install.
 */

export interface PluginVerdictRow {
  readonly contentHash: string;
  readonly verifierVersion: string;
  readonly pluginId: string;
  readonly severity: Severity;
  readonly findings: readonly ScanFinding[];
  readonly scannerVersion: string;
  readonly rationale: string | null;
  readonly computedAt: Date;
  readonly ackBy: string | null;
  readonly ackAt: Date | null;
}

export interface PluginVerdictStore {
  getPluginVerdict(
    contentHash: string,
    verifierVersion: string,
  ): Promise<PluginVerdictRow | undefined>;
  /** Latest verdict for a plugin id, regardless of content hash. */
  getLatestPluginVerdict(
    pluginId: string,
    verifierVersion: string,
  ): Promise<PluginVerdictRow | undefined>;
  upsertPluginVerdict(row: PluginVerdictRow): Promise<void>;
  getPluginVerdictsByShas(
    contentHashes: readonly string[],
    verifierVersion: string,
  ): Promise<Map<string, PluginVerdictRow>>;
  /** Returns undefined when no verdict row exists to acknowledge. */
  upsertPluginVerdictAck(
    contentHash: string,
    verifierVersion: string,
    ackedBy: string,
  ): Promise<{ ackBy: string; ackAt: Date } | undefined>;
}

export interface ScheduleScanInput {
  sha256: string;
  pluginId: string;
  /** Absolute path of the extracted package (post atomic move). */
  installedDir: string;
}

export interface PluginScanScheduler {
  /**
   * Fire-and-forget: persists a `pending` row, runs the scanner, persists
   * the resolved verdict. Resolves when the scan settles; callers are free
   * to `void` the promise. Never rejects.
   */
  scheduleScan(input: ScheduleScanInput): Promise<void>;
}

export interface PluginScanSchedulerDeps {
  store: PluginVerdictStore;
  scanner: PluginScanner;
  log?: (msg: string) => void;
}

export function createPluginScanScheduler(
  deps: PluginScanSchedulerDeps,
): PluginScanScheduler {
  const log = deps.log ?? ((m) => console.log(m));
  return {
    async scheduleScan(input: ScheduleScanInput): Promise<void> {
      try {
        // Cache-aside on (sha256, scanner version). Operational states
        // (`pending` from a crashed run, `scan_failed` from a sidecar
        // outage) are retried on the next install; real scan outcomes are
        // final for this scanner version.
        const cached = await deps.store.getPluginVerdict(
          input.sha256,
          PLUGIN_SCANNER_VERSION,
        );
        if (cached && cached.severity !== 'pending' && cached.severity !== 'scan_failed') {
          return;
        }

        await deps.store.upsertPluginVerdict({
          contentHash: input.sha256,
          verifierVersion: PLUGIN_SCANNER_VERSION,
          pluginId: input.pluginId,
          severity: 'pending',
          findings: [],
          scannerVersion: PLUGIN_SCANNER_VERSION,
          rationale: null,
          computedAt: new Date(),
          ackBy: null,
          ackAt: null,
        });

        const result = await deps.scanner.scan(input.installedDir);
        await deps.store.upsertPluginVerdict({
          contentHash: input.sha256,
          verifierVersion: PLUGIN_SCANNER_VERSION,
          pluginId: input.pluginId,
          severity: result.severity,
          findings: result.findings,
          scannerVersion: result.scannerVersion,
          rationale: result.rationale,
          computedAt: new Date(),
          ackBy: null,
          ackAt: null,
        });
        log(
          `[plugin-scan] verdict id=${input.pluginId} sha=${input.sha256.slice(0, 12)} severity=${result.severity} findings=${result.findings.length}`,
        );
      } catch (err) {
        // Persistence failures must never surface into the ingest path.
        log(
          `[plugin-scan] scan for ${input.pluginId} failed to persist: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/** Read-model for route serializers (store detail, packages list). */
export interface PluginVerdictView {
  readonly severity: Severity;
  readonly findings: readonly ScanFinding[];
  readonly scanner_version: string;
  readonly rationale: string | null;
  readonly computed_at: string;
  readonly ack: { by: string; at: string } | null;
}

export function toPluginVerdictView(row: PluginVerdictRow): PluginVerdictView {
  return {
    severity: row.severity,
    findings: row.findings,
    scanner_version: row.scannerVersion,
    rationale: row.rationale,
    computed_at: row.computedAt.toISOString(),
    ack: row.ackBy && row.ackAt ? { by: row.ackBy, at: row.ackAt.toISOString() } : null,
  };
}

export interface PluginVerdictLookupDeps {
  store: PluginVerdictStore;
  /** Structural slice of UploadedPackageStore — resolves plugin id → sha256. */
  packages: { get(id: string): { sha256: string } | undefined };
}

export interface PluginVerdictLookup {
  /** Lookup only — never triggers a scan (safe on GET paths). */
  getForPlugin(pluginId: string): Promise<PluginVerdictView | undefined>;
  /** Acknowledge the current verdict; undefined when nothing is scanned. */
  ack(pluginId: string, ackedBy: string): Promise<{ by: string; at: string } | undefined>;
}

export function createPluginVerdictLookup(
  deps: PluginVerdictLookupDeps,
): PluginVerdictLookup {
  const resolveHash = (pluginId: string): string | undefined =>
    deps.packages.get(pluginId)?.sha256;
  return {
    async getForPlugin(pluginId) {
      const sha = resolveHash(pluginId);
      const row = sha
        ? await deps.store.getPluginVerdict(sha, PLUGIN_SCANNER_VERSION)
        : // Package record gone (e.g. deleted after install) — fall back to
          // the latest verdict recorded for this plugin id.
          await deps.store.getLatestPluginVerdict(pluginId, PLUGIN_SCANNER_VERSION);
      return row ? toPluginVerdictView(row) : undefined;
    },
    async ack(pluginId, ackedBy) {
      const sha = resolveHash(pluginId);
      if (!sha) return undefined;
      const ack = await deps.store.upsertPluginVerdictAck(
        sha,
        PLUGIN_SCANNER_VERSION,
        ackedBy,
      );
      return ack ? { by: ack.ackBy, at: ack.ackAt.toISOString() } : undefined;
    },
  };
}
