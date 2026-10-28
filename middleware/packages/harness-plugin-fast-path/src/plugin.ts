import {
  PRIVACY_FORCE_GUARDED_ENV_VAR,
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PrivacyGuardService,
} from '@omadia/plugin-api';

import { createFastPathService, FAST_PATH_SERVICE } from './service.js';

/**
 * @omadia/fast-path — the deterministic fast path, shared by every channel.
 *
 * `kind: extension`. Publishes `fastPath@1` (see service.ts). The chat-agent
 * wrapper of `@omadia/orchestrator` consults it for every non-canvas turn;
 * the canvas orchestrator uses its learned plan store and settings.
 */

/** Triage always runs on the cheapest tier of the active provider. */
const TRIAGE_MODEL = 'class:fast';

export interface FastPathPluginHandle {
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<FastPathPluginHandle> {
  ctx.log('activating fast-path');
  const services = ctx.services as PluginContext['services'] | undefined;
  const privacyGuard = (): PrivacyGuardService | undefined =>
    services?.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);
  const toolsAccessor = ctx.tools as PluginContext['tools'] | undefined;
  const invoke = toolsAccessor?.invoke?.bind(toolsAccessor);
  const service = createFastPathService({
    config: { get: <T>(key: string): T | undefined => ctx.config?.get<T>(key) },
    ...(ctx.llm ? { llm: ctx.llm } : {}),
    model: TRIAGE_MODEL,
    ...(invoke ? { invoke } : {}),
    ...(ctx.memory ? { memory: ctx.memory } : {}),
    privacyGuard,
    privacyForced: () => process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] === 'true' && privacyGuard() === undefined,
    log: (m) => ctx.log(m),
  });
  ctx.log(
    `[fast-path] ${service.enabled ? `tools: ${[...service.tools].join(',')}` : 'disabled (fast_path_tools empty)'}; ` +
      `timezone: ${service.timeZone}; channels: ${ctx.config?.get<string>('fast_path_channels')?.trim() || 'all'}`,
  );
  const dispose = ctx.services.provide(FAST_PATH_SERVICE, service);
  return {
    async close(): Promise<void> {
      ctx.log('deactivating fast-path');
      dispose();
    },
  };
}
