/**
 * Ollama NER detector — Slice 3.2.
 *
 * Adapts the `OllamaChatClient` + few-shot prompt to the
 * `PrivacyDetector` contract from Slice 3.1. Plugged in alongside the
 * regex detector, this is what catches names like "Marcel Wege" or
 * domestic-format phone numbers that the regex pass deliberately drops.
 *
 * Per-detector contract recap:
 *   - Throwing from `detect()` would degrade the whole outbound pass.
 *     We DO NOT throw — every error path returns `[]` and logs a warn.
 *     The privacy-guard service has a separate per-detector try/catch
 *     for defence-in-depth, but the primary fail-open contract is
 *     enforced here.
 *   - The detector is safe to call concurrently. The OllamaChatClient
 *     does not maintain shared state; Ollama itself queues per-model
 *     requests internally.
 *   - Span offsets returned by the model are NOT trusted — small
 *     models miscount UTF-16 code units routinely. We re-derive spans
 *     via `text.indexOf(value, cursor)` so the downstream replace is
 *     always anchored at the actual substring.
 */

import type {
  PrivacyDetector,
  PrivacyDetectorHit,
  PrivacyDetectorOutcome,
} from '@omadia/plugin-api';

import {
  buildNerMessages,
  parseNerResponse,
  type NerHit,
} from './nerPrompt.js';
import { OllamaTransportError, type OllamaChatClient } from './ollamaClient.js';

export interface NerDetectorOptions {
  readonly client: OllamaChatClient;
  readonly model: string;
  /** Detector id surfaced on every hit + on the receipt. Slice 3.2
   *  convention: `ollama:<model>` so the receipt names the engine + tag. */
  readonly detectorId: string;
  /** Skip-detector threshold. Inputs longer than this return `[]`
   *  immediately to avoid OOM / pathological-prompt latency. */
  readonly maxInputChars: number;
  /** Per-call timeout passed to the chat client. */
  readonly timeoutMs: number;
  /** Optional log sink — by default `console.warn`. */
  readonly log?: (msg: string) => void;
}

export function createOllamaNerDetector(
  options: NerDetectorOptions,
): PrivacyDetector {
  const log = options.log ?? ((msg) => console.warn(msg));

  return {
    id: options.detectorId,
    // Slice 3.2.2: opt out of scanning the system prompt. Real-tenant
    // system prompts grow to ~22kb (Tool-Doc + Capability list + memory
    // recall) and the 3b NER model on commodity CPU spends 14s+ per
    // scan, timing out and contributing zero hits anyway. The regex
    // detector still scans the system prompt and catches structured
    // PII (email/IBAN/phone+/api-key) in memory recalls. NER focuses
    // on user/assistant message content where free-text PII (names,
    // addresses, business secrets) actually lives.
    scanTargets: {
      systemPrompt: false,
      userMessages: true,
      assistantMessages: true,
    },
    async detect(text: string): Promise<PrivacyDetectorOutcome> {
      if (text.length === 0) {
        return { hits: [], status: 'ok' };
      }
      if (text.length > options.maxInputChars) {
        const reason = `input-too-long:${text.length}>${options.maxInputChars}`;
        log(
          `[privacy-detector-ollama] skip detect: input ${text.length} > ${options.maxInputChars} chars`,
        );
        return { hits: [], status: 'skipped', reason };
      }

      let raw: string;
      try {
        raw = await options.client.chat({
          model: options.model,
          messages: buildNerMessages(text),
          timeoutMs: options.timeoutMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[privacy-detector-ollama] chat failed: ${message}`);
        // Discriminate timeout from other transport errors so the UI can
        // show "timeout" vs "error" distinctly. Both are fail-open at
        // the detector level — the receipt makes the difference visible.
        const isTimeout =
          (err instanceof OllamaTransportError && /timed out|timeout|aborted/i.test(message)) ||
          /timed out|timeout|aborted/i.test(message);
        return {
          hits: [],
          status: isTimeout ? 'timeout' : 'error',
          reason: message.slice(0, 80),
        };
      }

      const parsed = parseNerResponse(raw);
      if (parsed === undefined) {
        log(
          `[privacy-detector-ollama] response did not match schema (excerpt=${raw.slice(0, 120)})`,
        );
        return { hits: [], status: 'error', reason: 'broken-json' };
      }

      const hits = mapHits(parsed.hits, text, options.detectorId);
      return { hits, status: 'ok' };
    },
  };
}

/**
 * Map model-emitted `NerHit`s to canonical `PrivacyDetectorHit`s. We
 * re-anchor each hit's span via `indexOf(value, cursor)` so the privacy-
 * guard's right-to-left replacement walks against accurate offsets even
 * when the model invents start/end values (frequent on 3b models).
 *
 * `cursor` advances per accepted hit so two identical values in the text
 * receive distinct spans (e.g. "Marcel ... Marcel" → first occurrence
 * for hit #1, second occurrence for hit #2).
 */
function mapHits(
  hits: ReadonlyArray<NerHit>,
  text: string,
  detectorId: string,
): PrivacyDetectorHit[] {
  const out: PrivacyDetectorHit[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.value.length === 0) continue;
    let start = h.start;
    let end = h.end;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > text.length ||
      start >= end ||
      text.slice(start, end) !== h.value
    ) {
      const found = text.indexOf(h.value, cursor);
      const fallback = found >= 0 ? found : text.indexOf(h.value);
      if (fallback < 0) continue;
      start = fallback;
      end = fallback + h.value.length;
    }
    cursor = end;
    out.push({
      type: h.type,
      value: h.value,
      span: [start, end] as const,
      confidence: h.confidence,
      detector: detectorId,
    });
  }
  return out;
}
