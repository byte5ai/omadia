/**
 * #584 — metering primitives for `transcribe_recording`.
 *
 * Two canonical quantities (domain glossary):
 *  - **Source Minutes** — probed duration of the source recording, counted
 *    exactly once per recording. The duration cap enforces these, pre-flight,
 *    FAIL-CLOSED: 25 MB of ogg/opus is hours of audio, the upload size cap is
 *    no duration ceiling, so an unprobeable duration is a rejection, not a
 *    pass.
 *  - **Billed Minutes** — client-derived ESTIMATE of provider-billed time
 *    (the provider reports no per-call billing figure). Batch: source
 *    duration × attempts actually sent — every retry books in full.
 *    Realtime: sum of client-measured per-attempt stream durations (a
 *    reconnect is a new attempt) — the shape is fixed HERE so the realtime
 *    adapter PR can't drift; derivation lives in the capability layer, never
 *    per-adapter.
 *
 * The usage METER seam is what the plugin wires against the
 * `@omadia/usage-telemetry` transcription recorder + the shared `graphPool`.
 * Its two sides fail differently by design:
 *  - `record` is fire-and-forget (never throws; without a pool the recorder
 *    drops rows — in in-memory-KG mode the quota is therefore STRUCTURALLY
 *    UNENFORCED, stated honestly in the recorder's once-logged warning).
 *  - `sumBilledMinutesThisMonth` returns `undefined` when no metering store
 *    exists (quota unenforceable, not an error) and THROWS on a DB error so
 *    the caller can fail OPEN with an audit warning (dev-job budget
 *    precedent, `llmProxyAccounting`).
 */
import { parseBuffer } from 'music-metadata';
import type { TranscriptionUsage } from '@omadia/transcription-api';

/** Source/Billed Minutes of one metered call (trace + ledger shape). */
export interface MeteredMinutes {
  sourceMinutes: number;
  billedMinutes: number;
}

/** Plugin-side seam over the transcription usage ledger. */
export interface TranscriptionUsageMeter {
  /** Fire-and-forget: books one provider call into `transcription_usage`. */
  record(row: MeteredMinutes & { model: string; recordingId: string }): void;
  /**
   * Calendar-month Billed-Minutes sum for the owning agent. `undefined` =
   * no metering store (quota structurally unenforced); throws on DB error
   * (caller fails open + audit-warns).
   */
  sumBilledMinutesThisMonth(): Promise<number | undefined>;
}

/**
 * Pre-flight header probe: duration in Source Minutes, or `undefined` when
 * the duration cannot be established (missing/corrupt/unknown header) — the
 * caller MUST treat `undefined` as a rejection (fail-closed).
 *
 * Pure-JS (`music-metadata`), no content hint: the container is sniffed from
 * the magic bytes, so a lying `contentType` cannot smuggle a longer file
 * past the cap.
 */
export async function probeSourceMinutes(
  bytes: Buffer,
): Promise<number | undefined> {
  try {
    const meta = await parseBuffer(bytes, undefined, { duration: true });
    const seconds = meta.format.duration;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      return undefined;
    }
    return seconds / 60;
  } catch {
    return undefined;
  }
}

/**
 * Billed Minutes from the fixed metering shape (`TranscriptionUsage`).
 * Batch (no `attemptDurationsMs`): source × attempts — every retry books in
 * full. Realtime (`attemptDurationsMs` present): sum of measured per-attempt
 * stream durations; `sourceMinutes` deliberately plays no role there.
 */
export function deriveBilledMinutes(
  usage: TranscriptionUsage,
  sourceMinutes: number,
): number {
  if (usage.attemptDurationsMs !== undefined) {
    const totalMs = usage.attemptDurationsMs.reduce(
      (sum, ms) => sum + Math.max(0, ms),
      0,
    );
    return totalMs / 60_000;
  }
  return sourceMinutes * Math.max(0, usage.attempts);
}

/** Minutes for human-facing messages: two decimals, no trailing noise. */
export function formatMinutes(minutes: number): string {
  return (Math.round(minutes * 100) / 100).toString();
}
