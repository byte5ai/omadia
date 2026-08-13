/**
 * #361 — C1 transformer PII detector over the GLiNER inference sidecar
 * (`middleware/sidecars/pii-detector/`).
 *
 * Implements the shipped `PromptPiiDetector` seam (`@omadia/plugin-api`)
 * as a thin, FAIL-CLOSED HTTP client. Division of labor with the service:
 *
 *   - URL unresolved            ⇒ `detect()` returns `[]` — C1 is simply
 *     not configured. Equivalent to the inert `createC1StubDetector()`;
 *     deliberately NOT a degrade (no audit noise on unconfigured installs).
 *   - Anything else unexpected  ⇒ `detect()` THROWS. The service's tier-1
 *     path (`service.ts` maskUserPrompt) catches it, degrades to C0 and
 *     writes the `promptMaskDegraded` audit line. This module never
 *     swallows errors and never returns a half-result — lenient parsing of
 *     a PII detector's output is itself a leak vector (skillspector
 *     `parseSidecarResponse` precedent, `src/services/pluginScanner.ts`).
 *
 * Offset semantics: the sidecar (Python) reports Unicode CODE-POINT
 * offsets; `PromptPiiSpan` requires UTF-16 code units (contract in
 * `plugin-api/src/privacyReceipt.ts`). Conversion is exact (single pass
 * over the analyzed text) and verified per span by asserting
 * `text.slice(startU16, endU16) === span.text` — a mis-anchored person
 * span would mask the wrong characters, i.e. leak the real ones.
 *
 * PRIVACY: error messages thrown here end up in the `promptMaskDegraded`
 * audit log — they must never carry prompt text or span values. Only
 * status codes, counts, and offsets.
 */

import type { PromptPiiDetector, PromptPiiSpan } from '@omadia/plugin-api';

export interface C1HttpDetectorOptions {
  /**
   * Live URL resolver — read on every `detect()` call so an operator
   * config change (install-UI setup field) applies without a plugin
   * restart. `undefined`/empty ⇒ C1 not configured.
   */
  readonly resolveUrl: () => string | undefined;
  /** Hard cap per detect() call, covering connect + body read. */
  readonly timeoutMs?: number;
  /** Test seam. Defaults to `globalThis.fetch`. */
  readonly fetchFn?: typeof fetch;
  /** Calibrated fixed label set — NOT operator-extendable open labels
   *  (false-positive cascade class, see #242 / the plan on #361). */
  readonly labels?: readonly string[];
  readonly threshold?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_LABELS: readonly string[] = ['person', 'address'];
const DEFAULT_THRESHOLD = 0.5;

/** Detector id recorded (PII-free) on the receipt per masked span. */
export const C1_DETECTOR_ID = 'c1-gliner';

/** Shape of one span in the sidecar's positively-validated response. */
interface SidecarSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly label: string;
  readonly score: number;
}

export function createC1HttpDetector(
  opts: C1HttpDetectorOptions,
): PromptPiiDetector {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const labels = opts.labels ?? DEFAULT_LABELS;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  return {
    id: C1_DETECTOR_ID,
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      const rawUrl = opts.resolveUrl();
      const url = typeof rawUrl === 'string' ? rawUrl.trim() : undefined;
      if (url === undefined || url === '') {
        // Unconfigured — C0-only operation, not a failure.
        return [];
      }

      const body = await withTimeout(timeoutMs, async (signal) => {
        const res = await fetchFn(`${url.replace(/\/+$/, '')}/detect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, labels, threshold }),
          signal,
        });
        // The sidecar contract answers exactly 200 on success and
        // `{ok: false}` + non-200 on any failure — treat everything else
        // as failure (positive validation, never lenient).
        if (res.status !== 200) {
          throw new Error(`C1 sidecar responded ${String(res.status)}`);
        }
        try {
          return (await res.json()) as unknown;
        } catch {
          throw new Error('C1 sidecar returned a non-JSON body');
        }
      });

      const sidecarSpans = parseDetectResponse(body);
      return toPromptSpans(text, sidecarSpans);
    },
  };
}

// ---------------------------------------------------------------------------
// Timeout — own ref'ed timer race, not only the fetch signal. A misbehaving
// transport that ignores the AbortSignal must still not stall
// `maskUserPrompt` (and `AbortSignal.timeout()`'s timer is unref'ed, so it
// cannot be relied on to keep the loop alive). Skillspector-client
// precedent: AbortController + setTimeout + clearTimeout.
// ---------------------------------------------------------------------------

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`C1 sidecar timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      fn(controller.signal).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Positive response-schema validation (fail-closed).
// ---------------------------------------------------------------------------

function parseDetectResponse(body: unknown): SidecarSpan[] {
  if (body === null || typeof body !== 'object') {
    throw new Error('C1 sidecar returned a non-object response');
  }
  const record = body as Record<string, unknown>;
  if (record['ok'] !== true) {
    const error =
      typeof record['error'] === 'string' ? record['error'] : 'unknown error';
    throw new Error(`C1 sidecar reported failure: ${error}`);
  }
  const rawSpans = record['spans'];
  if (!Array.isArray(rawSpans)) {
    throw new Error('C1 sidecar response carries no spans array');
  }
  const spans: SidecarSpan[] = [];
  for (const raw of rawSpans) {
    if (raw === null || typeof raw !== 'object') {
      throw new Error('C1 sidecar response carries a non-object span');
    }
    const s = raw as Record<string, unknown>;
    const start = s['start'];
    const end = s['end'];
    const text = s['text'];
    const label = s['label'];
    const score = s['score'];
    if (
      typeof start !== 'number' ||
      !Number.isInteger(start) ||
      start < 0 ||
      typeof end !== 'number' ||
      !Number.isInteger(end) ||
      end <= start ||
      typeof text !== 'string' ||
      text.length === 0 ||
      typeof label !== 'string' ||
      label.length === 0 ||
      typeof score !== 'number' ||
      !Number.isFinite(score)
    ) {
      throw new Error('C1 sidecar span failed schema validation');
    }
    spans.push({ start, end, text, label, score });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Code-point → UTF-16 offset conversion + slice-equality assertion.
// ---------------------------------------------------------------------------

function toPromptSpans(
  analyzedText: string,
  sidecarSpans: readonly SidecarSpan[],
): PromptPiiSpan[] {
  if (sidecarSpans.length === 0) return [];

  // Single pass: record the UTF-16 index at every code-point boundary a
  // span references. `for..of` iterates code points; `ch.length` is the
  // UTF-16 width (1 for BMP, 2 for astral — the emoji case).
  const needed = new Set<number>();
  for (const s of sidecarSpans) {
    needed.add(s.start);
    needed.add(s.end);
  }
  const cpToU16 = new Map<number, number>();
  let cp = 0;
  let u16 = 0;
  for (const ch of analyzedText) {
    if (needed.has(cp)) cpToU16.set(cp, u16);
    cp += 1;
    u16 += ch.length;
  }
  // End-of-text is a valid exclusive `end` boundary.
  if (needed.has(cp)) cpToU16.set(cp, u16);

  const result: PromptPiiSpan[] = [];
  for (const s of sidecarSpans) {
    const start = cpToU16.get(s.start);
    const end = cpToU16.get(s.end);
    if (start === undefined || end === undefined) {
      throw new Error(
        `C1 sidecar span offsets out of range (${String(s.start)}..${String(s.end)})`,
      );
    }
    // The decisive fail-closed check: the sidecar's own `text` slice must
    // reproduce exactly under the converted offsets. A mis-anchored
    // person span is a leak — never "best-effort" it.
    if (analyzedText.slice(start, end) !== s.text) {
      throw new Error(
        `C1 sidecar span text does not match its offsets (${String(s.start)}..${String(s.end)})`,
      );
    }
    result.push({
      start,
      end,
      type: toSpanType(s.label),
      confidence: Math.min(1, Math.max(0, s.score)),
    });
  }
  return result;
}

/**
 * Label → span-type mapping. `person` and `address` hit the dedicated
 * surrogate streams in `v4/pseudonym.ts`; any other label becomes a
 * lowercased slug, which the pseudonym layer covers with its generic
 * `PLATZHALTER-<TYPE>-n` fallback — unknown categories mask safely, they
 * never pass through.
 */
function toSpanType(label: string): string {
  const lower = label.toLowerCase();
  if (lower === 'person') return 'person';
  if (lower === 'address') return 'address';
  const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug === '') {
    throw new Error('C1 sidecar span label is not representable');
  }
  return slug;
}
