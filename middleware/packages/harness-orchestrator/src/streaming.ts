import type { LlmProvider } from '@omadia/llm-provider';
import { recordUsage } from '@omadia/usage-telemetry';
import { fromLlmResponse, toLlmRequest } from './llmProviderSeam.js';
import type { AskObserver } from './tools/domainQueryTool.js';
import { ensureWellFormedParams } from './privacyHandle.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = any;

/**
 * One event yielded by `streamMessageEvents`. `text_delta` lets the caller
 * forward partial answer text to its UI while the stream is still in flight.
 * The terminal `final` carries the assistant `Message` reconstructed from
 * the provider's neutral final event so callers downstream can keep working
 * on the same shape the old Anthropic `messages.create` path used to return.
 */
export type StreamMessageEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'final'; message: Message };

/** Max attempts for a single streamed iteration (1 initial + 4 retries). */
const MAX_STREAM_ATTEMPTS = 5;

/** Anthropic error-body `type` discriminators that are worth retrying. */
const RETRYABLE_ERROR_TYPES = [
  'overloaded_error',
  'rate_limit_error',
  'api_error',
];

/** HTTP statuses that are worth retrying when the error carries one. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]);

/**
 * Detects the mid-stream errors that are safe + worthwhile to retry.
 *
 * The Anthropic API can return HTTP 200, begin the SSE stream, and only THEN
 * inject an `{"type":"error","error":{"type":"overloaded_error"}}` event when
 * the backend gets overloaded after the request was accepted. That event
 * never reaches the SDK's HTTP-level `maxRetries` (the request already
 * "succeeded" with 200), so it surfaces as a thrown error during stream
 * iteration — see `Stream.iterator` in `@anthropic-ai/sdk/core/streaming`.
 *
 * Transient provider states (`overloaded_error`, `rate_limit_error`,
 * `api_error`, 5xx, 429) are retryable; everything else (e.g.
 * `invalid_request_error`) is a hard failure and must NOT be retried.
 */
export function isRetryableStreamError(err: unknown): boolean {
  // Property reads below would throw on null/undefined — normalise first so
  // those fall through to the (non-matching) message-text scan.
  const e: Record<string, unknown> =
    typeof err === 'object' && err !== null
      ? (err as Record<string, unknown>)
      : {};

  const status = e['status'];
  if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) return true;

  // Anthropic error bodies nest as `{ type:'error', error:{ type:'...' } }`;
  // the SDK has also shipped a flattened `{ type:'...' }`. Probe both.
  const body = e['error'];
  for (const candidate of [body, (body as { error?: unknown } | undefined)?.error]) {
    const type = (candidate as { type?: unknown } | undefined)?.type;
    if (typeof type === 'string' && RETRYABLE_ERROR_TYPES.includes(type)) {
      return true;
    }
  }

  // Last resort: a mid-stream error surfaces as `new Error(<raw JSON body>)`,
  // so the discriminator is only reachable by scanning the message text.
  const text = err instanceof Error ? err.message : String(err);
  return RETRYABLE_ERROR_TYPES.some((type) => text.includes(type));
}

/**
 * Exponential backoff with full jitter: base ~1s, 2s, 4s, 8s (capped). Jitter
 * spreads the retry burst so many turns failing on the same overload window
 * do not all hammer the API back in lockstep.
 */
function streamRetryDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Streams a single iteration through `provider.stream(...)` and yields
 * progress events. Phase transitions (`thinking` → `streaming` →
 * `tool_running`) and token counters are emitted via the optional
 * `AskObserver`. The terminal `idle` phase is the caller's responsibility
 * (the caller knows when the whole turn is done).
 *
 * Per-chunk token counts are approximated as `ceil(text.length / 4)` because
 * the stream does not deliver per-delta token counts. The authoritative usage
 * block is read off the neutral final event and forwarded via
 * `onIterationUsage` so the iteration's totals reconcile.
 *
 * `streamLabel` is used as the prefix for observer-callback warnings so the
 * caller (sub-agent vs. orchestrator) can be identified in logs.
 *
 * Retry: a mid-stream `overloaded_error` (see {@link isRetryableStreamError})
 * is retried with exponential backoff, but ONLY while no `text_delta` has been
 * forwarded to the caller yet — re-running the request after partial output
 * would duplicate visible text in the UI. A start-of-stream overload (the
 * common case) always fails before the first delta, so it is fully covered.
 *
 * Privacy Shield v4 keeps no outbound/inbound transform on this path — raw
 * tool results are interned at the tool-dispatch seam, never on the wire,
 * so the streamed assistant text needs no token restoration.
 */
export async function* streamMessageEvents(args: {
  provider: LlmProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;
  observer: AskObserver | undefined;
  iteration: number;
  streamLabel: string;
  betas?: ReadonlyArray<string>;
}): AsyncGenerator<StreamMessageEvent> {
  const { provider, observer, iteration, streamLabel, betas } = args;
  const safe = (fn: () => void, hookName: string): void => {
    try {
      fn();
    } catch (err) {
      console.warn(`[${streamLabel}] observer.${hookName} threw:`, err);
    }
  };

  // Last-resort guard: repair any lone UTF-16 surrogate so the request
  // body is valid JSON for the Anthropic API. See ensureWellFormedParams.
  const params = ensureWellFormedParams(args.params);

  for (let attempt = 1; ; attempt++) {
    // `forwardedText` gates the retry: once a `text_delta` has been yielded
    // it has already been streamed to the UI, so re-running the request
    // would duplicate visible output. We only retry while the stream failed
    // before producing any forwarded text — exactly how a start-of-stream
    // `overloaded_error` behaves.
    let forwardedText = false;
    try {
      safe(
        () => observer?.onIterationPhase?.({ iteration, phase: 'thinking' }),
        'onIterationPhase',
      );

      const events = provider.stream(toLlmRequest(params, betas));

      let cumulativeApprox = 0;
      let windowStart = Date.now();
      let windowTokens = 0;
      let lastTokensPerSec = 0;
      let phase: 'thinking' | 'streaming' | 'tool_running' = 'thinking';

      const emitTokenChunk = (deltaText: string): void => {
        const deltaTokens = Math.ceil(deltaText.length / 4);
        cumulativeApprox += deltaTokens;
        windowTokens += deltaTokens;
        const now = Date.now();
        const windowMs = now - windowStart;
        if (windowMs >= 500) {
          lastTokensPerSec = (windowTokens / windowMs) * 1000;
          windowStart = now;
          windowTokens = 0;
        }
        safe(
          () =>
            observer?.onTokenChunk?.({
              iteration,
              deltaTokens,
              cumulativeOutputTokens: cumulativeApprox,
              tokensPerSec: lastTokensPerSec,
            }),
          'onTokenChunk',
        );
      };

      for await (const ev of events) {
        if (phase === 'thinking') {
          phase = 'streaming';
          safe(
            () => observer?.onIterationPhase?.({ iteration, phase: 'streaming' }),
            'onIterationPhase',
          );
        }
        if (ev.type === 'tool_use_start') {
          if (phase !== 'tool_running') {
            phase = 'tool_running';
            safe(
              () =>
                observer?.onIterationPhase?.({
                  iteration,
                  phase: 'tool_running',
                }),
              'onIterationPhase',
            );
          }
          continue;
        }
        if (ev.type === 'text_delta') {
          if (ev.text.length > 0) emitTokenChunk(ev.text);
          forwardedText = true;
          yield { type: 'text_delta', text: ev.text };
          continue;
        }
        if (ev.type === 'tool_input_delta') {
          if (ev.text.length > 0) emitTokenChunk(ev.text);
          continue;
        }
        if (ev.type === 'final') {
          const message = fromLlmResponse(ev.response);
          safe(
            () =>
              observer?.onIterationUsage?.({
                iteration,
                inputTokens: ev.response.usage.inputTokens,
                outputTokens: ev.response.usage.outputTokens,
                cacheReadInputTokens: ev.response.usage.cacheReadTokens ?? 0,
                cacheCreationInputTokens:
                  ev.response.usage.cacheWriteTokens ?? 0,
              }),
            'onIterationUsage',
          );

          recordUsage({
            source: streamLabel,
            model: ev.response.model,
            inputTokens: ev.response.usage.inputTokens,
            outputTokens: ev.response.usage.outputTokens,
            cacheReadTokens: ev.response.usage.cacheReadTokens ?? 0,
            cacheCreationTokens: ev.response.usage.cacheWriteTokens ?? 0,
          });

          yield { type: 'final', message };
          return;
        }
      }
    } catch (err) {
      // Non-retryable, retries exhausted, or text already streamed to the
      // UI → propagate. The orchestrator's catch logs + surfaces it.
      if (
        forwardedText ||
        attempt >= MAX_STREAM_ATTEMPTS ||
        !provider.classifyError(err).retryable
      ) {
        throw err;
      }
      const delayMs = streamRetryDelayMs(attempt);
      console.warn(
        `[${streamLabel}] streamed iteration ${iteration} hit a retryable ` +
          `provider error (attempt ${attempt}/${MAX_STREAM_ATTEMPTS}) — ` +
          `retrying in ${delayMs}ms:`,
        err instanceof Error ? err.message : err,
      );
      await sleep(delayMs);
    }
  }
}

/**
 * Drains `streamMessageEvents` and returns only the final assistant
 * `Message`. Used by sub-agents that don't forward partial text to a UI.
 */
export async function streamMessageWithObserver(
  provider: LlmProvider,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  observer: AskObserver | undefined,
  iteration: number,
  streamLabel: string,
): Promise<Message> {
  for await (const ev of streamMessageEvents({
    provider,
    params,
    observer,
    iteration,
    streamLabel,
  })) {
    if (ev.type === 'final') return ev.message;
  }
  throw new Error(`[${streamLabel}] stream ended without a final message`);
}
