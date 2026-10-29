import {
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PrivacyGuardService,
} from '@omadia/plugin-api';

import { createC1HttpDetector, probeC1Health } from './c1Detector.js';
import { createPrivacyGuardService } from './service.js';

/**
 * @omadia/plugin-privacy-guard — plugin entry point (Privacy Shield v4).
 *
 * Activation wiring:
 *   1. Build the v4 {@link PrivacyGuardService} via the pure factory.
 *   2. Publish it as `privacyRedact` (capability `privacy.redact@1`) for
 *      the orchestrator's tool-dispatch hook.
 *
 * The v4 Data-Plane Boundary is generic over JSON shape and value
 * statistics — there is no per-tenant policy, allowlist, or detector
 * configuration to read. All per-turn state (Dataset Store, receipt
 * counters) lives inside the service and is dropped at `finalizeTurn`.
 *
 * #361 — the one operator toggle is `mask_user_prompt` (default off), read
 * live via the plugin's ConfigAccessor: free-text user prompts get their
 * detected PII spans replaced by pseudonyms before crossing the LLM wire.
 * The C1 transformer tier (GLiNER sidecar) is injected here as a
 * `PromptPiiDetector` with a LIVE URL resolver — setup field
 * `c1_detector_url` first, `PRIVACY_C1_DETECTOR_URL` env fallback — so an
 * operator config change applies on the next turn without a restart. URL
 * unset ⇒ the detector reports no spans (C0-only, byte-identical to the
 * pre-C1 behavior); sidecar failure ⇒ the service's audited tier-1
 * degrade-to-C0 path.
 */

/** #1562 — how long a posture probe of the C1 sidecar is reused. */
const C1_PROBE_CACHE_MS = 30_000;

export interface PrivacyGuardPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<PrivacyGuardPluginHandle> {
  ctx.log('[privacy-guard] activating (Privacy Shield v4 — Data-Plane Boundary)');

  // Slice 2 — host-LLM accessor for schema-level PII classification. Present
  // only when the manifest's `permissions.llm` is honoured AND the host has
  // an LLM provider (ANTHROPIC_API_KEY). Absent ⇒ the classifier simply does
  // not run; interning behaves byte-identically to before.
  const llm = ctx.llm;
  // #361 — C1 transformer detector (GLiNER sidecar HTTP client). The URL is
  // resolved LIVE per detect() call: operator setup field first, env
  // fallback second (empty strings count as unset — see the `??` vs `||`
  // env gotcha in the handoff doc §10).
  const resolveC1Source = (): { url: string; source: 'setup' | 'env' } | undefined => {
    const fromConfig = ctx.config.get('c1_detector_url');
    if (typeof fromConfig === 'string' && fromConfig.trim() !== '') {
      return { url: fromConfig.trim(), source: 'setup' };
    }
    const envUrl = process.env['PRIVACY_C1_DETECTOR_URL']?.trim();
    return envUrl !== undefined && envUrl !== '' ? { url: envUrl, source: 'env' } : undefined;
  };
  const resolveC1Url = (): string | undefined => resolveC1Source()?.url;
  const c1Detector = createC1HttpDetector({ resolveUrl: resolveC1Url });
  let probeCache: { url: string; at: number; reachable: Promise<boolean> } | undefined;
  const service = createPrivacyGuardService({
    ...(llm ? { llmComplete: llm.complete.bind(llm) } : {}),
    // #361 — live flag reader for default-off user-prompt masking. Routed
    // through the plugin's own ConfigAccessor so an operator toggle saved
    // via the install UI applies on the very next turn (no restart).
    readConfig: (key) => ctx.config.get(key),
    c1Detector,
    // The live sidecar URL scopes the process-wide C1 segment cache: a
    // reconfigured sidecar misses, an unconfigured one caches nothing.
    c1CacheScope: resolveC1Url,
    // #1562 — the operator's posture shows whether names are detected:
    // where the URL comes from and whether the sidecar answers right now.
    // Cached briefly and shared while in flight: every admin page load reads
    // the posture, and a down sidecar would hold each one for the timeout.
    probeC1: async () => {
      const resolved = resolveC1Source();
      if (resolved === undefined) return { source: null, reachable: false };
      const now = Date.now();
      if (probeCache?.url !== resolved.url || now - probeCache.at > C1_PROBE_CACHE_MS) {
        probeCache = { url: resolved.url, at: now, reachable: probeC1Health(resolved.url) };
      }
      return { source: resolved.source, reachable: await probeCache.reachable };
    },
  });
  const disposeService = ctx.services.provide<PrivacyGuardService>(
    PRIVACY_REDACT_SERVICE_NAME,
    service,
  );

  ctx.log(
    `[privacy-guard] ready (schema PII classifier: ${llm ? 'on' : 'off'}, ` +
      // Startup snapshot only — the URL is re-resolved on every call.
      `C1 prompt detector: ${resolveC1Url() !== undefined ? 'configured' : 'unconfigured'})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[privacy-guard] deactivating');
      disposeService();
    },
  };
}
