import {
  TRANSCRIPTION_SERVICE_NAME,
  TranscriptionRealtimeDisabledError,
  withTranscriptionGuardrails,
  type PluginContext,
  type TranscribeFileRef,
  type TranscribeOpts,
  type Transcript,
  type TranscriptDelta,
  type TranscriptionService,
} from '@omadia/plugin-api';

import {
  DEFAULT_BATCH_MODEL,
  createOpenAiBatchTranscriber,
} from './batchProvider.js';
import {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_URL,
  createOpenAiRealtimeTranscriber,
} from './realtimeProvider.js';
import { openRealtimeSocket } from './realtimeTransport.js';

/**
 * @omadia/transcription-adapter-openai — first `transcription@1` provider
 * (#584 WS T).
 *
 * Two OpenAI models behind one neutral capability surface:
 *   - `gpt-transcribe` (batch, `POST /v1/audio/transcriptions`) backs
 *     `transcribeFile` and ships ungated — Workstream I consumes it.
 *   - `gpt-live-transcribe` (Realtime WebSocket) backs `transcribeStream`,
 *     shipped behind the `TRANSCRIPTION_REALTIME_EXPERIMENTAL` env gate
 *     (mirroring #294's `CHATGPT_SUBSCRIPTION_EXPERIMENTAL`): its only real
 *     consumer — the `AudioMeetingSource` of #584 WS S — is a follow-up, so
 *     no production path should open a live socket yet.
 *
 * Cost guardrails (#584, day one): the published service is wrapped in
 * `withTranscriptionGuardrails` — per-call duration cap, per-agent minute
 * quota (in-memory, resets on restart), minute metering to the operator log.
 * Attribution keys on the orchestrator turn's agent slug, read from the
 * kernel-bridged `turnContext` service at call time.
 *
 * PRIVACY / CONSENT. Activating this plugin means meeting/recording audio
 * leaves the deployment for the configured OpenAI-compatible endpoint. The
 * manifest help texts and the transcription-provider admin panel say so
 * verbatim; the transcript text itself re-enters the system as untrusted
 * input and rides the standard privacy choke points downstream.
 *
 * Same publication discipline as `embedding-adapter-openai`: without an
 * `api_key` in the vault the plugin activates but publishes nothing, so
 * consumers degrade to their no-transcription paths instead of boot failing —
 * and the `secret`-typed field keeps the built-in bootstrap from
 * auto-installing a provider nobody consented to.
 */

export const REALTIME_EXPERIMENTAL_ENV = 'TRANSCRIPTION_REALTIME_EXPERIMENTAL';

/** Structural view of the kernel-bridged `turnContext` service — only the one
 *  accessor the quota attribution needs. */
interface TurnContextLike {
  currentAgentSlug?: () => string | undefined;
}

export interface OpenAiTranscriptionPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<OpenAiTranscriptionPluginHandle> {
  const apiKey = (await ctx.secrets.get('api_key'))?.trim() ?? '';
  if (!apiKey) {
    ctx.log(
      '[transcription-adapter-openai] no api_key in the vault — plugin active but capability not published; consumers degrade to no-transcription paths',
    );
    return { close: closeNoop(ctx) };
  }

  const baseUrl =
    (ctx.config.get<string>('base_url') ?? '').trim() ||
    'https://api.openai.com';
  const batchModel =
    (ctx.config.get<string>('batch_model') ?? '').trim() || DEFAULT_BATCH_MODEL;
  const realtimeModel =
    (ctx.config.get<string>('realtime_model') ?? '').trim() ||
    DEFAULT_REALTIME_MODEL;
  const realtimeUrl =
    (ctx.config.get<string>('realtime_url') ?? '').trim() ||
    DEFAULT_REALTIME_URL;
  const timeoutMs = parsePositiveInt(
    ctx.config.get<unknown>('timeout_ms'),
    300_000,
  );
  const maxCallMinutes = parsePositiveInt(
    ctx.config.get<unknown>('max_call_minutes'),
    240,
  );
  const agentQuotaMinutes = parsePositiveInt(
    ctx.config.get<unknown>('agent_quota_minutes'),
    600,
  );

  const batch = createOpenAiBatchTranscriber({
    baseUrl,
    apiKey,
    model: batchModel,
    timeoutMs,
  });
  const realtimeEnabled = isRealtimeEnabled();
  const realtime = realtimeEnabled
    ? createOpenAiRealtimeTranscriber({
        url: realtimeUrl,
        apiKey,
        model: realtimeModel,
        openSocket: openRealtimeSocket,
      })
    : undefined;

  const raw: TranscriptionService = {
    providerId: `openai:${batchModel}`,
    transcribeFile(
      ref: TranscribeFileRef,
      opts?: TranscribeOpts,
    ): Promise<Transcript> {
      return batch.transcribeFile(ref, opts);
    },
    transcribeStream(
      audio: AsyncIterable<Uint8Array>,
      opts?: TranscribeOpts,
    ): AsyncIterable<TranscriptDelta> {
      if (!realtime) {
        throw new TranscriptionRealtimeDisabledError(
          `set ${REALTIME_EXPERIMENTAL_ENV}=1 to enable the experimental ` +
            `'${realtimeModel}' realtime provider`,
        );
      }
      return realtime.transcribeStream(audio, opts);
    },
  };

  // Attribution thunk, resolved at CALL time (not captured at activate):
  // the ALS-backed turnContext only knows the agent mid-turn.
  const turnContext = ctx.services.get<TurnContextLike>('turnContext');
  const service = withTranscriptionGuardrails(raw, {
    maxCallMinutes,
    agentQuotaMinutes,
    resolveAgentKey: (): string =>
      turnContext?.currentAgentSlug?.() ?? 'default',
    onMinutesMetered: (agentKey, minutes, providerId): void => {
      ctx.log(
        `[transcription-adapter-openai] metered ${minutes.toFixed(2)} min for agent '${agentKey}' via ${providerId}`,
      );
    },
  });

  const dispose = ctx.services.provide(TRANSCRIPTION_SERVICE_NAME, service);
  ctx.log(
    `[transcription-adapter-openai] ready (baseUrl=${baseUrl}, batch=${batchModel}, ` +
      `realtime=${realtimeEnabled ? realtimeModel : 'DISABLED (experimental gate off)'}, ` +
      `capMin=${String(maxCallMinutes)}, quotaMin=${String(agentQuotaMinutes)})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[transcription-adapter-openai] deactivating');
      dispose();
    },
  };
}

function isRealtimeEnabled(): boolean {
  const raw = (process.env[REALTIME_EXPERIMENTAL_ENV] ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true';
}

function closeNoop(ctx: PluginContext): () => Promise<void> {
  return async (): Promise<void> => {
    ctx.log(
      '[transcription-adapter-openai] deactivating (no service was built)',
    );
  };
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}
