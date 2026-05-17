import type Anthropic from '@anthropic-ai/sdk';
import type { AskObserver } from './tools/domainQueryTool.js';
import {
  applyPrivacyOutboundToParams,
  restorePrivacyInResponse,
  streamingTokenBoundary,
} from './privacyHandle.js';
import { turnContext } from './turnContext.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = any;

/**
 * One event yielded by `streamMessageEvents`. `text_delta` lets the caller
 * forward partial answer text to its UI while the stream is still in flight.
 * The terminal `final` carries the assistant `Message` reconstructed from
 * `stream.finalMessage()` so callers downstream can keep working on the same
 * shape `messages.create` used to return.
 */
export type StreamMessageEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'final'; message: Message };

/**
 * Streams a single iteration through `client.messages.stream` and yields
 * progress events. Phase transitions (`thinking` → `streaming` →
 * `tool_running`) and token counters are emitted via the optional
 * `AskObserver`. The terminal `idle` phase is the caller's responsibility
 * (the caller knows when the whole turn is done).
 *
 * Per-chunk token counts are approximated as `ceil(text.length / 4)` because
 * the SDK does not deliver per-delta token counts. The authoritative usage
 * block is read off `finalMessage()` and forwarded via `onIterationUsage`
 * so the iteration's totals reconcile.
 *
 * `streamLabel` is used as the prefix for observer-callback warnings so the
 * caller (sub-agent vs. orchestrator) can be identified in logs.
 *
 * Privacy-Proxy Slice 2.1: this function reads `turnContext.current()
 * ?.privacyHandle` and, if present, applies `processOutbound` to
 * `params.system + params.messages` BEFORE starting the stream and
 * `processInbound` to every `text_delta` (with buffered lookahead for
 * partial tokens crossing chunk boundaries) and to the assistant text
 * blocks in the reconstructed `finalMessage()` AFTER the stream ends.
 * When no provider is registered the function is byte-identical to its
 * pre-Slice-2.1 behaviour.
 */
export async function* streamMessageEvents(args: {
  client: Anthropic;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;
  observer: AskObserver | undefined;
  iteration: number;
  streamLabel: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestOptions?: any;
}): AsyncGenerator<StreamMessageEvent> {
  const { client, observer, iteration, streamLabel, requestOptions } = args;
  const safe = (fn: () => void, hookName: string): void => {
    try {
      fn();
    } catch (err) {
      console.warn(`[${streamLabel}] observer.${hookName} threw:`, err);
    }
  };

  // Privacy-Proxy outbound transform.
  const privacy = turnContext.current()?.privacyHandle;
  const params = privacy
    ? await applyPrivacyOutboundToParams(args.params, privacy, streamLabel)
    : args.params;

  safe(
    () => observer?.onIterationPhase?.({ iteration, phase: 'thinking' }),
    'onIterationPhase',
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream: any = requestOptions
    ? client.messages.stream(params, requestOptions)
    : client.messages.stream(params);

  let cumulativeApprox = 0;
  let windowStart = Date.now();
  let windowTokens = 0;
  let lastTokensPerSec = 0;
  let phase: 'thinking' | 'streaming' | 'tool_running' = 'thinking';
  // Streaming-buffered Restore: hold trailing chars that could complete a
  // `«TYPE_N»` token in the next chunk. Flushed on stream end.
  let pendingHold = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const event of stream as AsyncIterable<any>) {
    if (event?.type === 'message_start') {
      if (phase === 'thinking') {
        phase = 'streaming';
        safe(
          () => observer?.onIterationPhase?.({ iteration, phase: 'streaming' }),
          'onIterationPhase',
        );
      }
    } else if (event?.type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'tool_use' && phase !== 'tool_running') {
        phase = 'tool_running';
        safe(
          () =>
            observer?.onIterationPhase?.({ iteration, phase: 'tool_running' }),
          'onIterationPhase',
        );
      }
    } else if (event?.type === 'content_block_delta') {
      const delta = event.delta;
      let deltaText = '';
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        deltaText = delta.text;
      } else if (
        delta?.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        deltaText = delta.partial_json;
      }
      if (deltaText.length > 0) {
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
      }
      // Forward only assistant-text deltas to the caller; tool-use input
      // JSON deltas are intentionally swallowed (the full `tool_use` block
      // is emitted once the content block closes, which is both cheaper
      // and more usable for the UI).
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        if (privacy) {
          const combined = pendingHold + delta.text;
          const split = streamingTokenBoundary(combined);
          pendingHold = split.hold;
          if (split.safe.length > 0) {
            const restored = await privacy.processInbound(split.safe);
            yield { type: 'text_delta', text: restored };
          }
        } else {
          yield { type: 'text_delta', text: delta.text };
        }
      }
    }
  }

  // Flush any held trailing chars that never grew into a complete token.
  if (privacy && pendingHold.length > 0) {
    const restored = await privacy.processInbound(pendingHold);
    yield { type: 'text_delta', text: restored };
    pendingHold = '';
  }

  const response: Message = await stream.finalMessage();

  // Inbound restore on the reconstructed final message — the SDK builds
  // it from the RAW deltas (tokens still present), so we must restore
  // before downstream code reads `response.content[].text`.
  if (privacy) {
    await restorePrivacyInResponse(response, privacy);
  }

  const usage = response?.usage;
  if (usage) {
    safe(
      () =>
        observer?.onIterationUsage?.({
          iteration,
          inputTokens:
            typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
          outputTokens:
            typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
          cacheReadInputTokens:
            typeof usage.cache_read_input_tokens === 'number'
              ? usage.cache_read_input_tokens
              : 0,
          cacheCreationInputTokens:
            typeof usage.cache_creation_input_tokens === 'number'
              ? usage.cache_creation_input_tokens
              : 0,
        }),
      'onIterationUsage',
    );
  }

  yield { type: 'final', message: response };
}

/**
 * Drains `streamMessageEvents` and returns only the final assistant
 * `Message`. Used by sub-agents that don't forward partial text to a UI.
 */
export async function streamMessageWithObserver(
  client: Anthropic,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  observer: AskObserver | undefined,
  iteration: number,
  streamLabel: string,
): Promise<Message> {
  for await (const ev of streamMessageEvents({
    client,
    params,
    observer,
    iteration,
    streamLabel,
  })) {
    if (ev.type === 'final') return ev.message;
  }
  throw new Error(`[${streamLabel}] stream ended without a final message`);
}

