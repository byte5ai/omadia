import type { PluginContext } from '@omadia/plugin-api';
import type { TranscriptionService } from '@omadia/transcription-api';

import { createOpenAiTranscriptionService } from './openaiTranscriptionService.js';

/**
 * @omadia/transcription-adapter-openai — first `transcription@1` provider
 * (#584).
 *
 * ONE service object serves both capability methods: `transcribeFile` is live
 * (batch, gpt-transcribe), `transcribeStream` is a stub until the realtime
 * follow-up PR — unreachable through the registry because the manifest's
 * `transcription_provider` block declares only the batch model's `file`
 * surface.
 *
 * Registration follows the web-search template: `ctx.services.provide` under
 * the bare service name (`'transcription'`), while the capability string with
 * `@1` is what the manifest `provides`. `provide` throws on a duplicate, so
 * two active transcription providers are structurally impossible; the
 * `secret`-typed `api_key` field additionally keeps the built-in bootstrap
 * from auto-installing this plugin — the operator opts in explicitly.
 *
 * Config (`ctx.config`, from manifest `setup.fields`):
 *   - `base_url` default https://api.openai.com/v1
 * Secret (`ctx.secrets`, Vault-backed — never plugin config):
 *   - `api_key`
 *
 * Without an api_key the plugin activates but publishes nothing (the
 * embedding-adapter precedent): consumers degrade to their
 * no-transcription-provider paths instead of the boot failing.
 */

export const TRANSCRIPTION_SERVICE_NAME = 'transcription';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiTranscriptionPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<OpenAiTranscriptionPluginHandle> {
  const apiKey = (await ctx.secrets.get('api_key'))?.trim() ?? '';
  const baseURL =
    (ctx.config.get<string>('base_url') ?? '').trim() || DEFAULT_BASE_URL;

  if (!apiKey) {
    ctx.log(
      '[transcription-adapter-openai] no api_key in the vault — plugin active but capability not published; consumers degrade to no-transcription-provider paths',
    );
    return { close: closeNoop(ctx) };
  }

  const service: TranscriptionService = createOpenAiTranscriptionService({
    apiKey,
    baseURL,
  });
  const dispose = ctx.services.provide(TRANSCRIPTION_SERVICE_NAME, service);
  ctx.log(
    `[transcription-adapter-openai] ready (baseURL=${baseURL}, batch model gpt-transcribe; stream surface stubbed until the realtime follow-up PR)`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[transcription-adapter-openai] deactivating');
      dispose();
    },
  };
}

function closeNoop(ctx: PluginContext): () => Promise<void> {
  return async (): Promise<void> => {
    ctx.log(
      '[transcription-adapter-openai] deactivating (no service was published)',
    );
  };
}
