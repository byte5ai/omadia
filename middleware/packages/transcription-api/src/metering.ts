/**
 * Metering-config seam between the transcription provider adapter and the
 * capability layer (#584).
 *
 * The capability-wide duration cap lives as a `setup.fields` integer
 * (`max_source_minutes`, default 60) on the PROVIDER adapter's manifest — it
 * is a property of the capability the operator configured, not of every
 * consumer. The transcribe tool enforces it pre-flight and therefore needs a
 * live read across the plugin boundary; the adapter publishes this small
 * config object alongside the `'transcription'` service. Method (not value)
 * so an operator edit via the install UI takes effect on the very next tool
 * call — the same live-read guarantee `readConfig` gives kernel tools.
 *
 * `model()` exists because neither `Transcript` nor `TranscriptionUsage`
 * carries a model id (deliberately — the contract is provider-neutral), yet
 * the usage ledger prices per model at write time.
 */

/** Registry name; published by the active `transcription@1` adapter. */
export const TRANSCRIPTION_METERING_SERVICE_NAME = 'transcriptionMetering';

/**
 * Capability-wide duration-cap default in Source Minutes. Mirrors the
 * `max_source_minutes` manifest default; the tool also falls back to it
 * fail-safe when the adapter publishes no metering config.
 */
export const DEFAULT_MAX_SOURCE_MINUTES = 60;

export interface TranscriptionMeteringConfig {
  /**
   * Live-read duration cap in Source Minutes. Implementations return the
   * operator-configured `max_source_minutes`, falling back to
   * {@link DEFAULT_MAX_SOURCE_MINUTES} when unset or non-positive.
   */
  maxSourceMinutes(): number;
  /** Provider model id billed for the given surface, for the usage ledger. */
  model(surface: 'file' | 'stream'): string;
}
