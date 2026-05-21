import {
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PrivacyGuardService,
} from '@omadia/plugin-api';

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
 */

export interface PrivacyGuardPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<PrivacyGuardPluginHandle> {
  ctx.log('[privacy-guard] activating (Privacy Shield v4 — Data-Plane Boundary)');

  const service = createPrivacyGuardService();
  const disposeService = ctx.services.provide<PrivacyGuardService>(
    PRIVACY_REDACT_SERVICE_NAME,
    service,
  );

  ctx.log('[privacy-guard] ready');

  return {
    async close(): Promise<void> {
      ctx.log('[privacy-guard] deactivating');
      disposeService();
    },
  };
}
