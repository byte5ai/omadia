/**
 * Presidio NER detector — Slice 3.4.
 *
 * Adapts the `PresidioClient` to the `PrivacyDetector` contract from
 * Slice 3.1. Presidio is the deterministic mid-tier — fast (<50ms typical),
 * reproducible, and broad (Names, Adressen, Org + structured PII with
 * country-specific validation). Complements the LLM-NER (Ollama) which
 * stays for free-text business secrets.
 *
 * Per-detector contract recap:
 *   - Throwing from `detect()` would degrade the whole outbound pass.
 *     We never throw — every error path returns
 *     `{ hits: [], status: 'error' | 'timeout' | 'skipped', reason }`.
 *   - The detector is safe to call concurrently. The Presidio sidecar
 *     handles concurrent /analyze requests internally; the client adds
 *     no shared state.
 *   - Span offsets returned by Presidio are byte-accurate (computed in
 *     Python from the same UTF-16 string we sent). We still re-anchor
 *     defensively via `text.indexOf(value, cursor)` to stay symmetric
 *     with the Slice-3.2 Ollama detector and survive any future
 *     surrogate-pair mismatches.
 */

import type {
  PrivacyDetector,
  PrivacyDetectorHit,
  PrivacyDetectorOutcome,
} from '@omadia/plugin-api';

import {
  PresidioTransportError,
  type PresidioClient,
  type PresidioRawHit,
} from './presidioClient.js';
import { mapPresidioType } from './typeMapping.js';

export interface PresidioDetectorOptions {
  readonly client: PresidioClient;
  readonly language: string;
  /** Detector id surfaced on every hit + on the receipt. Slice 3.4
   *  convention: `presidio:<version>` so the receipt names the engine
   *  + version. Independent of the spaCy-model version (operators can
   *  change models without changing the detector id). */
  readonly detectorId: string;
  /** Skip-detector threshold. Inputs longer than this return `[]`
   *  immediately to avoid runaway latency on pathological prompts.
   *  Presidio is fast but spaCy NLP scales linearly with token count
   *  and a 100kb input can take >1s. */
  readonly maxInputChars: number;
  /** Per-call timeout passed to the client. */
  readonly timeoutMs: number;
  /** Score floor for hits returned by the sidecar. Presidio's own
   *  threshold is in the request body; this is a defensive second
   *  filter. Hits with score < this value are dropped here as well. */
  readonly scoreThreshold: number;
  /** Optional log sink — by default `console.warn`. */
  readonly log?: (msg: string) => void;
}

export function createPresidioDetector(
  options: PresidioDetectorOptions,
): PrivacyDetector {
  const log = options.log ?? ((msg) => console.warn(msg));

  return {
    id: options.detectorId,
    // Slice 3.4.2: scan only user messages.
    //
    // The 3.4 boot-smoke produced 272 maskings on a single user turn
    // because Presidio scanned the orchestrator's system prompt — which
    // for any non-trivial tenant carries the memory recall (real
    // employee data, prior conversations, CRM heap) and shreds it
    // into 100+ name + 100+ address tokens. Effect on the LLM:
    //   - hundreds of identical-looking `tok_<hex>` placeholders in
    //     the system prompt destroy contextual grounding,
    //   - the assistant defensively hallucinates a plausible-sounding
    //     name for the question's token, and
    //   - it stops mid-turn rather than calling tools, because no tool
    //     argument it could form would resolve back through the
    //     tokenize map.
    //
    // The architectural fix: trust the tenant memory boundary. Memory
    // recall in the system prompt is by-construction tenant-internal —
    // the user already saw those values in earlier turns. Re-masking
    // them on the wire to Anthropic doesn't earn privacy (the tenant is
    // who put them there), and costs the LLM its working context.
    // Structured PII (email/IBAN/phone+/api-key) inside memory recalls
    // stays covered by the regex detector, which has no false-positive
    // problem on those patterns.
    //
    // Slice 3.4.3 reverses the assistantMessages call: it is `true`
    // again. The 3.4.2 reasoning ("same items as the system memory,
    // skipping costs nothing") was wrong in the leak direction:
    // assistant-history contains names that crossed the
    // Anthropic boundary in earlier turns and got restored on the way
    // back. Persisted in the chat session and replayed on the next
    // outbound, those names go to Anthropic *unmasked* unless we
    // re-tokenise them here. The 270-FP cascade we feared is a
    // system-prompt issue (22 kb of memory recall), not an assistant-
    // history issue (a handful of recent turns, dozens of chars
    // each). Tokenisation stays deterministic through `tokenizeMap`,
    // so re-scanning yields the same tokens and the LLM keeps a
    // coherent referent across turns.
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
          `[privacy-detector-presidio] skip detect: input ${text.length} > ${options.maxInputChars} chars`,
        );
        return { hits: [], status: 'skipped', reason };
      }

      let response;
      try {
        response = await options.client.analyze({
          text,
          language: options.language,
          scoreThreshold: options.scoreThreshold,
          timeoutMs: options.timeoutMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[privacy-detector-presidio] analyze failed: ${message}`);
        const isTimeout =
          (err instanceof PresidioTransportError && /timed out|timeout|aborted/i.test(message)) ||
          /timed out|timeout|aborted/i.test(message);
        return {
          hits: [],
          status: isTimeout ? 'timeout' : 'error',
          reason: message.slice(0, 80),
        };
      }

      const hits = mapHits(
        response.hits,
        text,
        options.language,
        options.scoreThreshold,
        options.detectorId,
      );
      return { hits, status: 'ok' };
    },
  };
}

/**
 * Map raw Presidio hits to canonical `PrivacyDetectorHit`s.
 *
 *   - Drops hits whose entity type is on the exclude list (DATE_TIME,
 *     URL, NRP) — see typeMapping.ts.
 *   - Drops hits below `scoreThreshold` (defence in depth — the
 *     sidecar already filters but the operator's plugin-side
 *     threshold may be stricter than the sidecar's process-wide one).
 *   - Re-anchors spans via `indexOf` if the byte offsets don't slice
 *     to the expected substring (extra robustness).
 *   - Computes the matched substring from the source text since the
 *     sidecar response intentionally omits it (smaller wire payload,
 *     PII-free transport).
 */
function mapHits(
  rawHits: ReadonlyArray<PresidioRawHit>,
  text: string,
  language: string,
  scoreThreshold: number,
  detectorId: string,
): PrivacyDetectorHit[] {
  const out: PrivacyDetectorHit[] = [];
  let cursor = 0;
  for (const raw of rawHits) {
    if (raw.score < scoreThreshold) continue;
    const mappedType = mapPresidioType(raw.entity_type, language);
    if (mappedType === undefined) continue;

    const len = text.length;
    let { start, end } = raw;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > len ||
      start >= end
    ) {
      // Out-of-range — drop the hit, we can't trust the value.
      continue;
    }

    let value = text.slice(start, end);
    if (value.length === 0) continue;

    // Defensive re-anchor: if the slice somehow doesn't read like a
    // proper match (e.g. UTF-16 surrogate-pair edge case), try to
    // realign via indexOf from the cursor.
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (trimmed !== value) {
      const found = text.indexOf(trimmed, cursor);
      if (found >= 0) {
        start = found;
        end = found + trimmed.length;
        value = trimmed;
      }
    }
    cursor = end;

    out.push({
      type: mappedType,
      value,
      span: [start, end] as const,
      confidence: raw.score,
      detector: detectorId,
    });
  }
  return out;
}
