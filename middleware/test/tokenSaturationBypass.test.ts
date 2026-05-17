import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  analyzeTokenSaturation,
  bypassCannedAnswer,
  DEFAULT_BYPASS_CONFIG,
} from '@omadia/orchestrator/dist/tokenSaturationBypass.js';
import type { PrivacyTurnHandle } from '@omadia/orchestrator';

/**
 * Privacy-Engine Hardening — Single-Token-Bypass tests.
 *
 * Pure-function tests against a stub `PrivacyTurnHandle` whose
 * `processOutbound` is a programmed responder. The detector is
 * supposed to:
 *
 *   - trigger when ≥70% of the user's non-whitespace original chars
 *     get replaced by token shapes
 *   - NOT trigger for normal greetings with a single name
 *   - NOT trigger for short messages (below minLength)
 *   - NOT trigger when the tokeniser throws — degrade gracefully so
 *     the LLM path can still run
 */

interface StubHandleOptions {
  /** Map of input text → tokenised replacement applied to the single
   *  user-message slot. Unmatched inputs pass through unchanged. */
  readonly responses?: ReadonlyMap<string, string>;
  /** When true, processOutbound rejects (simulates tokeniser failure). */
  readonly throwOnCall?: boolean;
}

function makeStubHandle(opts: StubHandleOptions = {}): PrivacyTurnHandle {
  const responses = opts.responses ?? new Map();
  return {
    async processOutbound(input) {
      if (opts.throwOnCall) {
        throw new Error('stub tokeniser failed');
      }
      const original = input.messages[0]?.content ?? '';
      const tokenised = responses.get(original) ?? original;
      return {
        systemPrompt: input.systemPrompt,
        messages: [{ role: 'user', content: tokenised }],
        routing: 'allow',
      };
    },
    async processInbound(text) {
      return text;
    },
    async processToolInput() {
      throw new Error('not used in this test');
    },
    async processToolResult() {
      throw new Error('not used in this test');
    },
    async validateOutput() {
      throw new Error('not used in this test');
    },
    async applyEgressFilter() {
      throw new Error('not used in this test');
    },
    async applySelfAnonymization() {
      throw new Error('not used in this test');
    },
    async applyPostEgressScrub() {
      throw new Error('not used in this test');
    },
    async finalize() {
      throw new Error('not used in this test');
    },
  } as unknown as PrivacyTurnHandle;
}

describe('analyzeTokenSaturation', () => {
  it('triggers on a saturated name-only input (≥65% ratio, ≥4 tokens)', async () => {
    // Conservative-bypass calibration: only inputs dominated by
    // tokens — essentially name lists with minimal connective
    // tissue — cross the default 0.65/4 line. Four names back-to-back
    // exceed both thresholds and reliably produce the
    // template-variable hallucination if sent to the LLM.
    const original = 'Hey Bitchi Marcel Anna';
    const tokenised = '«PERSON_1» «PERSON_2» «PERSON_3» «PERSON_4»';
    const responses = new Map([[original, tokenised]]);
    const handle = makeStubHandle({ responses });
    const result = await analyzeTokenSaturation(original, handle);
    assert.equal(result.triggered, true);
    assert.equal(result.tokenCount, 4);
    assert.ok(
      result.coverageRatio >= 0.65,
      `expected coverage ≥ 0.65, got ${String(result.coverageRatio)}`,
    );
  });

  it('does NOT trigger on the 2026-05-15 production-screenshot pattern (calibration boundary)', async () => {
    // The original screenshot input ("Hey, Bitchi, sei lieb Du Deinem
    // Papa Marcel!") tokenised to r ≈ 0.59 — below the conservative
    // 0.65 default. Documented trade-off: we tolerate this single
    // hallucination shape rather than the wider false-positive
    // surface a looser threshold would produce on realistic
    // multi-name questions. The orphan-placeholder footer mitigates
    // the user-facing impact when this case slips through.
    const original = 'Hey Bitchi sei lieb Deinem Papa Marcel';
    const tokenised =
      '«PERSON_1» «PERSON_2» sei lieb Deinem «PERSON_3» «PERSON_4»';
    const responses = new Map([[original, tokenised]]);
    const handle = makeStubHandle({ responses });
    const result = await analyzeTokenSaturation(original, handle);
    assert.equal(result.triggered, false);
    assert.equal(result.tokenCount, 4);
    assert.ok(
      result.coverageRatio < 0.65,
      `expected coverage < 0.65, got ${String(result.coverageRatio)}`,
    );
  });

  it('does NOT trigger on a realistic multi-name question (false-positive guard)', async () => {
    // The chief false-positive concern: legitimate Marcel-style chat
    // questions that reference multiple people inside a normal
    // sentence ("Mit Marcel Wege und Anna Müller das Meeting").
    // Empirically r ≈ 0.56, t = 4. Stays below 0.65 — LLM handles it
    // normally.
    const original = 'Mit Marcel Wege und Anna Müller das Meeting';
    const tokenised =
      'Mit «PERSON_1» «PERSON_2» und «PERSON_3» «PERSON_4» das Meeting';
    const responses = new Map([[original, tokenised]]);
    const handle = makeStubHandle({ responses });
    const result = await analyzeTokenSaturation(original, handle);
    assert.equal(result.triggered, false);
    assert.equal(result.tokenCount, 4);
  });

  it('does not trigger for a normal greeting with one name', async () => {
    const original = 'Hi Marcel, was steht heute auf der Agenda für das Engineering-Team?';
    const tokenised = 'Hi «PERSON_1», was steht heute auf der Agenda für das Engineering-Team?';
    const responses = new Map([[original, tokenised]]);
    const handle = makeStubHandle({ responses });
    const result = await analyzeTokenSaturation(original, handle);
    assert.equal(result.triggered, false);
    assert.equal(result.tokenCount, 1);
  });

  it('does not trigger when the input is below minLength', async () => {
    const original = 'Hi'; // 2 chars
    const tokenised = '«PERSON_1»';
    const responses = new Map([[original, tokenised]]);
    const handle = makeStubHandle({ responses });
    const result = await analyzeTokenSaturation(original, handle);
    assert.equal(result.triggered, false);
    assert.equal(result.tokenCount, 0); // detector short-circuits before tokenising
  });

  it('does not trigger when there are no tokens (no PII detected)', async () => {
    const original = 'Erzeuge mir bitte eine Liste aller offenen Tickets.';
    // No tokenisation — passes through unchanged.
    const handle = makeStubHandle({});
    const result = await analyzeTokenSaturation(original, handle);
    assert.equal(result.triggered, false);
    assert.equal(result.tokenCount, 0);
    assert.equal(result.coverageRatio, 0);
  });

  it('does not trigger when the tokeniser throws (degrades to LLM path)', async () => {
    const handle = makeStubHandle({ throwOnCall: true });
    const result = await analyzeTokenSaturation(
      'a long enough input string',
      handle,
    );
    assert.equal(result.triggered, false);
  });

  it('does not trigger when only one token is present, even with high ratio', async () => {
    // "Hi Marcel" alone is below minLength. Use a longer single-name
    // input that crosses minLength but stays at one token.
    const original = 'Hallo Marcel, schönen Mittwoch!';
    const tokenised = 'Hallo «PERSON_1», schönen Mittwoch!';
    const responses = new Map([[original, tokenised]]);
    const handle = makeStubHandle({ responses });
    const result = await analyzeTokenSaturation(original, handle);
    assert.equal(result.triggered, false);
    assert.equal(result.tokenCount, 1);
  });

  it('honours a custom ratio threshold', async () => {
    // Anna + Ben (2 names) with very little filler — ratio crosses
    // 0.5 comfortably.
    const original = 'Anna Müller Ben Lee Anna sind hier.';
    const tokenised =
      '«PERSON_1» «PERSON_2» «PERSON_3» «PERSON_4» «PERSON_1» sind hier.';
    const responses = new Map([[original, tokenised]]);
    const handle = makeStubHandle({ responses });
    // Default 0.5 triggers (high name-to-filler ratio).
    const defaultResult = await analyzeTokenSaturation(original, handle);
    assert.equal(defaultResult.triggered, true);
    // A tighter (higher) ratio threshold doesn't.
    const strictResult = await analyzeTokenSaturation(original, handle, {
      ...DEFAULT_BYPASS_CONFIG,
      ratio: 0.9,
    });
    assert.equal(strictResult.triggered, false);
  });

  it('computes coverageRatio against ORIGINAL char count, not tokenised', async () => {
    // Original 'Marcel' = 6 chars. Tokenised '«PERSON_3»' = 10 chars (longer).
    // If we naively used tokenised char count, ratio would be 1.0 either
    // way. The correct calculation uses original survived chars =
    // tokenised_non_token - 0 = 0 (no surviving chars). Coverage =
    // (6 - 0) / 6 = 1.0. Triggered.
    const original = 'Marcel hat heute frei';
    const tokenised = '«PERSON_3» hat heute frei';
    const responses = new Map([[original, tokenised]]);
    const handle = makeStubHandle({ responses });
    const result = await analyzeTokenSaturation(original, handle);
    // Original non-ws: 'Marcelhatheutefrei' = 18 chars
    // Survived non-ws: 'hatheutefrei' = 12 chars (the tokenised text minus the token)
    // Replaced = 18 - 12 = 6, ratio = 6/18 ≈ 0.33 → NOT triggered.
    assert.equal(result.triggered, false);
    assert.ok(Math.abs(result.coverageRatio - 6 / 18) < 0.01);
  });
});

describe('bypassCannedAnswer', () => {
  it('reports the coverage percentage and token count in the message', () => {
    const message = bypassCannedAnswer({
      triggered: true,
      originalChars: 30,
      tokenChars: 22,
      survivedChars: 8,
      tokenCount: 3,
      coverageRatio: 0.73,
    });
    assert.match(message, /73%/);
    assert.match(message, /3 Tokens/);
    assert.match(message, /Privacy-Guard/);
  });

  it('encourages the user to rephrase + flag false positives', () => {
    const message = bypassCannedAnswer({
      triggered: true,
      originalChars: 30,
      tokenChars: 22,
      survivedChars: 8,
      tokenCount: 3,
      coverageRatio: 0.73,
    });
    assert.match(message, /rephras|Formulier/i);
    assert.match(message, /False[- ]Positiv|danebenliegt/i);
  });
});
