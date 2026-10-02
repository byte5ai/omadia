/**
 * Job-scoped masking of STORED text (WP-10) — the scope behind
 * `PrivacyGuardService.openStoredTextScope`.
 *
 * Background memory jobs (topic-cluster naming, the inconsistency detector, the
 * Teams topic detector) send stored text to their own model outside a turn.
 * There is no turn map to extend and no receipt to book into, so each job run
 * gets a scope of its own: the run's surrogate map lives in this closure, calls
 * of one run share it (stable surrogates), and `restoreStoredText` inverts it
 * over the job's output. Nothing outlives the scope object.
 *
 * Same guarantees as the turn-scoped masks in `service.ts`: always on
 * (`mask_user_prompt` is about the user's words in a turn's prompt), the post-
 * mask invariant that no detected value survives (`findIdentityLeaks`), and
 * failure-closed — a detector failure or a surviving value is `blocked`, never
 * a pass-through. A failing C1 detector degrades the rest of the run to the
 * given baseline detectors, audited once, as the per-turn latch does.
 */

import type {
  PrivacyPromptMaskResult,
  PrivacyStoredTextScope,
  PromptMaskedSpanInfo,
  PromptPiiDetector,
} from '@omadia/plugin-api';

import { maskPrompt } from './promptMask.js';
import { findIdentityLeaks } from './v4/onTheWire.js';
import { resolvePseudonyms } from './v4/pseudonym.js';
import type { PseudonymMap } from './v4/types.js';

export interface StoredTextScopeDeps {
  /** PII-free job name, logged with every call. */
  readonly job: string;
  /** Baseline detectors (identity shapes, operator deny-list), fixed for the run. */
  readonly detectors: readonly PromptPiiDetector[];
  /** The optional C1 detector; its failure degrades, it never blocks. */
  readonly c1Detector?: PromptPiiDetector;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createStoredTextScope(deps: StoredTextScopeDeps): PrivacyStoredTextScope {
  let map: PseudonymMap | undefined;
  let c1Failed = false;
  // A mask call reads the run's map, awaits its detectors and writes the
  // extended map back; calls of one run therefore go one at a time.
  let tail: Promise<unknown> = Promise.resolve();

  /** C1 up-front, memoized into a pass-through detector for the mask pass. */
  async function c1Step(
    text: string,
  ): Promise<{ readonly detector?: PromptPiiDetector; readonly degraded: boolean }> {
    const c1 = deps.c1Detector;
    if (c1 === undefined || text.trim().length === 0) return { degraded: false };
    if (c1Failed) return { degraded: true };
    try {
      const spans = await c1.detect(text);
      return { detector: { id: c1.id, detect: async () => spans }, degraded: false };
    } catch (err) {
      c1Failed = true;
      console.warn(
        `[privacy-guard v4] storedTextMaskDegraded job=${deps.job} detector=${c1.id}: ` +
          `${messageOf(err)} (C1 disabled for the remainder of this run)`,
      );
      return { degraded: true };
    }
  }

  async function maskOnce(text: string): Promise<PrivacyPromptMaskResult> {
    const c1 = await c1Step(text);
    const detectors = c1.detector ? [...deps.detectors, c1.detector] : deps.detectors;
    try {
      const result = await maskPrompt(text, detectors, map);
      const residual = findIdentityLeaks(result.maskedText, [...result.map.forward.keys()]);
      if (residual.length > 0) {
        console.error(
          `[privacy-guard v4] storedTextMaskBlocked job=${deps.job} ` +
            `residual=${String(residual.length)} span(s) survived substitution`,
        );
        return { outcome: 'blocked', reason: 'residual PII span survived substitution' };
      }
      map = result.map;
      const spans: PromptMaskedSpanInfo[] = result.spans.map((s) => ({
        type: s.type,
        detector: s.detector,
      }));
      console.log(
        `[privacy-guard v4] storedTextMask job=${deps.job} ` +
          `spans=${String(spans.length)}${c1.degraded ? ' degraded=c0-only' : ''}`,
      );
      return { outcome: 'masked', maskedText: result.maskedText, spans, degraded: c1.degraded };
    } catch (err) {
      console.error(`[privacy-guard v4] storedTextMaskBlocked job=${deps.job}: ${messageOf(err)}`);
      return { outcome: 'blocked', reason: 'prompt PII detection failed' };
    }
  }

  return {
    maskStoredText(text: string): Promise<PrivacyPromptMaskResult> {
      const result = tail.then(() => maskOnce(text));
      tail = result.catch(() => undefined);
      return result;
    },
    restoreStoredText(text: string): string {
      if (map === undefined || map.reverse.size === 0) return text;
      return resolvePseudonyms(text, map);
    },
  };
}
