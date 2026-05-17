/**
 * @omadia/plugin-privacy-detector-presidio — plugin entry point.
 *
 * Activation wiring:
 *   1. Read setup fields (endpoint, language, score-threshold, timeout,
 *      max-input).
 *   2. Probe the sidecar's `/health` once for visibility (fail-open —
 *      a Down sidecar logs but does not abort activation; per-call
 *      `detect()` returns `status: 'error'` outcomes when the sidecar
 *      is unreachable).
 *   3. Resolve the `privacyDetectorRegistry` service published by
 *      `harness-plugin-privacy-guard` (Slice 3.1) and register the
 *      Presidio detector with it. Throws if the registry is absent —
 *      that means privacy-guard is not installed, which is a
 *      configuration error the operator must fix.
 *   4. Return a `close()` handle that unregisters the detector on
 *      deactivate.
 *
 * Manifest declares `requires: ['privacy.detector@1']` so the kernel's
 * capability resolver activates privacy-guard before this plugin and
 * the registry lookup at step 3 is guaranteed to succeed.
 */

import {
  PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
  type PluginContext,
  type PrivacyDetectorRegistry,
} from '@omadia/plugin-api';

import { createPresidioDetector } from './presidioDetector.js';
import { createPresidioClient } from './presidioClient.js';
import { PRESIDIO_DETECTOR_VERSION } from './typeMapping.js';

export interface PresidioDetectorPluginHandle {
  close(): Promise<void>;
}

const DEFAULT_ENDPOINT = 'http://localhost:5001';
const DEFAULT_LANGUAGE = 'de';
// Slice 3.4.2: bumped from 0.4 (Presidio's process-wide default) to 0.6.
// Post-deploy 2026-05-14: further bump 0.6 → 0.8. The HR-routine FP
// cascade ("Krankheit" → ADDRESS, "Abwesenheitstyp" → PERSON, etc.)
// showed Presidio's German spaCy NER fires confident-looking hits in
// the 0.6-0.8 band on common compound nouns. The allowlist catches
// the known cases, but never exhaustively — a higher threshold is
// the second line of defence. Trade-off: real names with low NER
// confidence (uncommon spellings, foreign first names) may now slip
// through. Acceptable because (a) the allowlist also tunes the
// other way, (b) Egress Filter re-detects spontaneous PII, and
// (c) operators can lower it via `presidio_score_threshold`.
const DEFAULT_SCORE_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_INPUT_CHARS = 100_000;

export async function activate(
  ctx: PluginContext,
): Promise<PresidioDetectorPluginHandle> {
  ctx.log('[privacy-detector-presidio] activating');

  const endpoint = readString(ctx, 'presidio_endpoint', DEFAULT_ENDPOINT);
  const language = readString(ctx, 'presidio_language', DEFAULT_LANGUAGE);
  const scoreThreshold = readNumber(
    ctx,
    'presidio_score_threshold',
    DEFAULT_SCORE_THRESHOLD,
  );
  const timeoutMs = readNumber(ctx, 'presidio_timeout_ms', DEFAULT_TIMEOUT_MS);
  const maxInputChars = readNumber(
    ctx,
    'presidio_max_input_chars',
    DEFAULT_MAX_INPUT_CHARS,
  );

  const client = createPresidioClient({ baseUrl: endpoint });

  // Boot-time visibility ping. Awaited intentionally — a down sidecar
  // at boot is the kind of thing the operator wants surfaced in the
  // same log line as activation. We do NOT abort if it fails: per-call
  // detect() already fail-opens, so a sidecar that comes up later
  // still contributes hits.
  const sidecarOk = await client.health().catch(() => false);

  const registry = ctx.services.get<PrivacyDetectorRegistry>(
    PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
  );
  if (registry === undefined) {
    throw new Error(
      `[privacy-detector-presidio] requires the '${PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME}' service — ` +
        'install @omadia/plugin-privacy-guard before this plugin.',
    );
  }

  const detectorId = `presidio:${PRESIDIO_DETECTOR_VERSION}`;
  const detector = createPresidioDetector({
    client,
    language,
    detectorId,
    maxInputChars,
    timeoutMs,
    scoreThreshold,
    log: (msg) => ctx.log(msg),
  });

  const dispose = registry.register(detector);

  ctx.log(
    `[privacy-detector-presidio] ready (endpoint=${endpoint}, language=${language}, ` +
      `sidecar=${sidecarOk ? 'ok' : 'unreachable'}, score_threshold=${String(scoreThreshold)}, ` +
      `max_input_chars=${String(maxInputChars)}, timeout_ms=${String(timeoutMs)})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[privacy-detector-presidio] deactivating');
      dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Config readers — tolerate missing/malformed inputs by falling back to
// safe defaults so a half-configured plugin still boots.
// ---------------------------------------------------------------------------

function readString(ctx: PluginContext, key: string, fallback: string): string {
  const raw = ctx.config.get<unknown>(key);
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return fallback;
}

function readNumber(ctx: PluginContext, key: string, fallback: number): number {
  const raw = ctx.config.get<unknown>(key);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}
