/**
 * #584 — cost guardrails for the `transcription@1` capability.
 *
 * Wraps a {@link TranscriptionService} with the day-one guardrails the issue
 * demands: a per-call duration cap, a per-agent minute quota, and minute
 * metering — mirroring the conductor's runaway-generation guardrails (#818).
 *
 * The quota tally is IN-MEMORY and per-process by design: it resets on
 * restart. It is a spend brake, not an accounting ledger — a pg-backed ledger
 * is a deliberate non-goal of #584's first cut.
 *
 * Attribution is resolved via the injected `resolveAgentKey` AT CALL TIME
 * (AsyncLocalStorage-friendly: adapters pass a thunk over the `turnContext`
 * service). For `transcribeStream` the key is captured SYNCHRONOUSLY before
 * the iterable is returned — the ALS store does not survive across generator
 * yields (see `turnContext.ts`'s `enterWith` warning), so resolving lazily
 * inside the generator body would attribute every stream to the fallback key.
 */

import {
  TranscriptionQuotaExceededError,
  type TranscribeFileRef,
  type TranscribeOpts,
  type Transcript,
  type TranscriptDelta,
  type TranscriptionService,
} from './transcription.js';

export interface TranscriptionGuardrailOptions {
  /** Per-call cap on billable audio, in minutes. Tightens (never widens) any
   *  caller-supplied `opts.maxDurationMs`. Omit for no cap. */
  readonly maxCallMinutes?: number;
  /** Per-agent minute quota (in-memory, per-process). Omit for no quota. */
  readonly agentQuotaMinutes?: number;
  /** Attribution key resolver, read at call time. Defaults to `'default'`. */
  readonly resolveAgentKey?: () => string;
  /** Metering sink — called once per completed call with the billed minutes. */
  readonly onMinutesMetered?: (
    agentKey: string,
    minutes: number,
    providerId: string,
  ) => void;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

const MS_PER_MINUTE = 60_000;

/** Wrap `inner` with cap/quota/metering guardrails. The wrapper owns the
 *  in-memory per-agent tally; wrap once at provider construction. */
export function withTranscriptionGuardrails(
  inner: TranscriptionService,
  options: TranscriptionGuardrailOptions = {},
): TranscriptionService {
  const now = options.now ?? ((): number => Date.now());
  const resolveKey = options.resolveAgentKey ?? ((): string => 'default');
  const minutesByAgent = new Map<string, number>();

  const usedMinutes = (key: string): number => minutesByAgent.get(key) ?? 0;

  const assertQuota = (key: string): void => {
    const quota = options.agentQuotaMinutes;
    if (quota === undefined) return;
    const used = usedMinutes(key);
    if (used >= quota) {
      throw new TranscriptionQuotaExceededError(key, quota, used);
    }
  };

  const meter = (key: string, minutes: number): void => {
    if (minutes <= 0) return;
    minutesByAgent.set(key, usedMinutes(key) + minutes);
    options.onMinutesMetered?.(key, minutes, inner.providerId);
  };

  const cappedOpts = (opts: TranscribeOpts | undefined): TranscribeOpts => {
    const capMs =
      options.maxCallMinutes === undefined
        ? undefined
        : options.maxCallMinutes * MS_PER_MINUTE;
    if (capMs === undefined) return opts ?? {};
    const requested = opts?.maxDurationMs;
    return {
      ...(opts ?? {}),
      maxDurationMs:
        requested === undefined ? capMs : Math.min(requested, capMs),
    };
  };

  return {
    providerId: inner.providerId,

    async transcribeFile(
      ref: TranscribeFileRef,
      opts?: TranscribeOpts,
    ): Promise<Transcript> {
      const key = resolveKey();
      assertQuota(key);
      const transcript = await inner.transcribeFile(ref, cappedOpts(opts));
      meter(key, billedMinutesFromTranscript(transcript));
      return transcript;
    },

    transcribeStream(
      audio: AsyncIterable<Uint8Array>,
      opts?: TranscribeOpts,
    ): AsyncIterable<TranscriptDelta> {
      // Capture attribution BEFORE the first yield — see module doc.
      const key = resolveKey();
      assertQuota(key);
      const effective = cappedOpts(opts);
      const capMs = effective.maxDurationMs;
      const source = inner.transcribeStream(audio, effective);

      async function* metered(): AsyncGenerator<TranscriptDelta> {
        const startedAt = now();
        let lastMeteredMs = 0;
        try {
          for await (const delta of source) {
            const elapsedMs = now() - startedAt;
            // Wall-clock backstop: a provider that ignores the cap is cut off
            // here, so the cap holds by construction rather than by courtesy.
            if (capMs !== undefined && elapsedMs > capMs) {
              lastMeteredMs = capMs;
              return;
            }
            lastMeteredMs = elapsedMs;
            yield delta;
          }
        } finally {
          meter(key, lastMeteredMs / MS_PER_MINUTE);
        }
      }
      return metered();
    },
  };
}

/** Billed minutes for a batch call: the provider-reported duration, falling
 *  back to the last segment's end offset, else 0 (metered as free rather than
 *  guessed — an unknown duration must not invent spend). */
function billedMinutesFromTranscript(transcript: Transcript): number {
  const ms =
    transcript.durationMs ??
    transcript.segments.reduce<number>(
      (max, s) => (s.endMs !== undefined && s.endMs > max ? s.endMs : max),
      0,
    );
  return ms / MS_PER_MINUTE;
}
