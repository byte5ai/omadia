import {
  PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PolicyMode,
  type PrivacyDetector,
  type PrivacyDetectorRegistry,
  type PrivacyGuardService,
} from '@omadia/plugin-api';

import { createPrivacyGuardService } from './service.js';

/**
 * @omadia/plugin-privacy-guard — plugin entry point.
 *
 * Activation wiring:
 *   1. Read `policy_mode` + `fail_open` from `ctx.config`.
 *   2. Build the {@link PrivacyGuardService} via the pure factory.
 *   3. Publish it as `privacyRedact` (capability `privacy.redact@1`)
 *      for the orchestrator hook to consume in Slice 2.
 *   4. Slice 3.1: also publish a thin `PrivacyDetectorRegistry` facade
 *      under `privacyDetectorRegistry` so add-on detector plugins
 *      (Slice 3.2 Ollama, Slice 3.4 Presidio) can register at activate
 *      time without forking this plugin.
 *
 * Stateless across activations — every `processOutbound` call mints
 * its own per-turn tokenise-map; the service does not cache anything
 * between turns. Slice 2 will introduce a conversation-scoped registry
 * keyed by session id.
 */

export interface PrivacyGuardPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<PrivacyGuardPluginHandle> {
  ctx.log('[privacy-guard] activating');

  const policyMode = readPolicyMode(ctx);
  // `fail_open` is read for log visibility; the actual fail-mode plumbing
  // lands in Slice 2 with the orchestrator hook (the service today is
  // pure compute, never `fail`s).
  const failOpen = readFailOpen(ctx);
  // Slice 3.2.1: operator-toggle that authorises the receipt to carry
  // raw matched values. Default off — receipts stay PII-free.
  const debugShowValues = readDebugShowValues(ctx);

  const service = createPrivacyGuardService({
    defaultPolicyMode: policyMode,
    debugShowValues,
  });

  const disposeService = ctx.services.provide<PrivacyGuardService>(
    PRIVACY_REDACT_SERVICE_NAME,
    service,
  );

  // Slice 3.1: thin facade over the service's internal detector list.
  // Add-on plugins (Slice 3.2 Ollama, Slice 3.4 Presidio) resolve this
  // service via `ctx.services.get(PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME)`
  // and call `register(detector)` from their own `activate()`.
  const registry: PrivacyDetectorRegistry = {
    register: (detector: PrivacyDetector) => service.registerDetector(detector),
    list: () => service.listDetectors(),
  };
  const disposeRegistry = ctx.services.provide<PrivacyDetectorRegistry>(
    PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
    registry,
  );

  ctx.log(
    `[privacy-guard] ready (policy_mode=${policyMode}, fail_open=${failOpen}, ` +
      `debug_show_values=${debugShowValues ? 'on' : 'off'}, ` +
      `detectors=${service
        .listDetectors()
        .map((d) => d.id)
        .join(',')})`,
  );
  if (debugShowValues) {
    ctx.log(
      '[privacy-guard] WARNING: debug_show_values=on — receipts will carry raw matched values for tokenized hits. Disable before exporting receipts outside this dev tenant.',
    );
  }

  return {
    async close(): Promise<void> {
      ctx.log('[privacy-guard] deactivating');
      // Reverse-order dispose: registry first (so a late detector
      // registration during shutdown can't slip in after the service
      // has already gone away), then the service itself.
      disposeRegistry();
      disposeService();
    },
  };
}

// ---------------------------------------------------------------------------
// Config readers — tolerate missing/malformed inputs by falling back to
// safe defaults so a half-configured plugin still boots.
// ---------------------------------------------------------------------------

function readPolicyMode(ctx: PluginContext): PolicyMode {
  const raw = ctx.config.get<unknown>('policy_mode');
  if (typeof raw !== 'string') return 'pii-shield';
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'data-residency') return 'data-residency';
  return 'pii-shield';
}

function readFailOpen(ctx: PluginContext): 'open' | 'closed' {
  const raw = ctx.config.get<unknown>('fail_open');
  if (typeof raw !== 'string') return 'closed';
  return raw.trim().toLowerCase() === 'open' ? 'open' : 'closed';
}

function readDebugShowValues(ctx: PluginContext): boolean {
  const raw = ctx.config.get<unknown>('debug_show_values');
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === 'on' || trimmed === 'true' || trimmed === 'yes' || trimmed === '1';
}
