/**
 * #361 — free-text user-prompt PII masking.
 *
 * Covers the detection/substitution engine (`promptMask.ts`), the typed
 * prompt-surrogate map (`v4/pseudonym.ts#createPromptPseudonymMap`), the
 * service policy surface (`maskUserPrompt` / `restorePromptPseudonyms` —
 * default-off flag, degrade-to-C0, failure-closed), and the orchestrator's
 * `PrivacyTurnHandle` delegation incl. feature-detection on providers that
 * predate the contract.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { PrivacyGuardService, PromptPiiDetector } from '@omadia/plugin-api';
import { createPrivacyTurnHandle } from '@omadia/orchestrator/dist/privacyHandle.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  createBaselineDetector,
  createC1StubDetector,
  dedupSpans,
  maskPrompt,
} from '@omadia/plugin-privacy-guard/dist/promptMask.js';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';
import {
  createPromptPseudonymMap,
  resolvePseudonyms,
} from '@omadia/plugin-privacy-guard/dist/v4/pseudonym.js';

const RFC_PROMPT =
  'What should we pay Anna Schmidt (32, lives at Bahnhofstr. 5, 60311 Frankfurt) ' +
  'given her current salary of €72,000? Reach her at anna.schmidt@firma.de or +49 171 5551234.';

const RFC_STRUCTURED_VALUES = [
  'Bahnhofstr. 5, 60311 Frankfurt',
  '€72,000',
  'anna.schmidt@firma.de',
  '+49 171 5551234',
];

describe('createBaselineDetector (C0)', () => {
  it('detects each structured identifier type', async () => {
    const spans = await createBaselineDetector().detect(RFC_PROMPT);
    const types = new Set(spans.map((s) => s.type));
    for (const expected of ['email', 'phone', 'address', 'amount']) {
      assert.ok(types.has(expected), `C0 must detect type '${expected}'`);
    }
  });

  it('detects IBAN and DOB-style dates', async () => {
    const spans = await createBaselineDetector().detect(
      'Konto DE89 3704 0044 0532 0130 00, geboren am 24.12.1987.',
    );
    const types = new Set(spans.map((s) => s.type));
    assert.ok(types.has('iban'));
    assert.ok(types.has('date'));
  });

  it('reports nothing on a PII-free prompt (over-masking guard)', async () => {
    const spans = await createBaselineDetector().detect(
      'Summarize our vacation carry-over policy for first-year employees.',
    );
    assert.equal(spans.length, 0);
  });
});

describe('dedupSpans', () => {
  it('resolves overlaps to the higher-confidence span and extends to word boundaries', () => {
    const text = 'mail me at anna.schmidt@firma.de today';
    const resolved = dedupSpans(text, [
      // Low-confidence span covering only part of the address…
      { span: { start: 11, end: 23, type: 'person', confidence: 0.4 }, detector: 'c1' },
      // …and the full email at confidence 1.
      { span: { start: 11, end: 32, type: 'email', confidence: 1 }, detector: 'c0-regex' },
    ]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.type, 'email');
    assert.equal(resolved[0]!.value, 'anna.schmidt@firma.de');
  });

  it('extends a mid-word span so no identifying fragment survives', () => {
    const text = 'contact anna.schmidt@firma.de';
    const resolved = dedupSpans(text, [
      // Detector only caught the local part.
      { span: { start: 8, end: 20, type: 'email', confidence: 0.9 }, detector: 'c1' },
    ]);
    assert.equal(resolved[0]!.value, 'anna.schmidt@firma.de');
  });

  it('keeps the uncovered remainder of a losing lower-confidence span (review finding)', () => {
    // A long C1 free-form-address span (score < 1) brushing a short
    // confidence-1 C0 hit inside it must NOT be dropped wholesale — the
    // parts C0 does not cover would otherwise reach the wire unmasked.
    const text =
      'Das Paket bitte an das gelbe Hinterhaus im zweiten Hof der ' +
      'Lindenallee 5, dritter Aufgang links, 60311 Frankfurt am Main liefern.';
    const c1Value =
      'das gelbe Hinterhaus im zweiten Hof der Lindenallee 5, ' +
      'dritter Aufgang links, 60311 Frankfurt am Main';
    const c1Start = text.indexOf(c1Value);
    const c0Value = '60311 Frankfurt';
    const c0Start = text.indexOf(c0Value);
    const resolved = dedupSpans(text, [
      {
        span: { start: c1Start, end: c1Start + c1Value.length, type: 'address', confidence: 0.8 },
        detector: 'c1-gliner',
      },
      {
        span: { start: c0Start, end: c0Start + c0Value.length, type: 'address', confidence: 1 },
        detector: 'c0-regex',
      },
    ]);
    // Every character of the C1 span is covered by some kept span.
    for (let i = c1Start; i < c1Start + c1Value.length; i++) {
      assert.ok(
        resolved.some((s) => s.start <= i && i < s.end),
        `offset ${String(i)} ('${text[i]!}') of the C1 span lost coverage`,
      );
    }
    // And the output stays non-overlapping, sorted by start.
    for (let i = 1; i < resolved.length; i++) {
      assert.ok(resolved[i - 1]!.end <= resolved[i]!.start);
    }
  });

  it('#727 — the ISO-date exact tie resolves to date, in either input order', () => {
    // The ISO-date bug in miniature: `2026-07-02` yields a native `date` span
    // over the whole token [0,10] and a native `phone` span over the `07-02`
    // tail [5,10] that word-boundary extension grows back to [0,10]. Both are
    // confidence 1 and end up the same length at the same start — a total tie
    // on (confidence, length, start). The tie MUST resolve to `date` because
    // its NATIVE match is larger (it matched the value directly; phone only
    // grew into the range) — and it must do so regardless of the order the
    // spans arrive in (previously the winner was decided by C0_PATTERNS
    // insertion order via stable-sort fall-through).
    const text = '2026-07-02';
    const dateSpan = { span: { start: 0, end: 10, type: 'date', confidence: 1 }, detector: 'c0-regex' };
    const phoneSpan = { span: { start: 5, end: 10, type: 'phone', confidence: 1 }, detector: 'c0-regex' };

    for (const order of [
      [phoneSpan, dateSpan],
      [dateSpan, phoneSpan],
    ]) {
      const resolved = dedupSpans(text, order);
      assert.equal(resolved.length, 1);
      assert.equal(
        resolved[0]!.type,
        'date',
        'the native full-token date span must win the tie in either input order',
      );
      assert.equal(resolved[0]!.value, '2026-07-02');
    }
  });

  it('#727 — native match length is the decider, ABOVE the lexical fallback', () => {
    // Isolate the nativeLen key from the lexical last-resort. For date/phone
    // both keys happen to favour `date`, so that pair alone cannot prove
    // WHICH key decided. Here the full-token span is typed `phone` and the
    // grown-in tail is typed `date`: the lexical fallback (`date` < `phone`)
    // would pick `date`, but nativeLen (full 10 > tail 5) must pick `phone`.
    // `phone` winning proves nativeLen outranks the lexical key AND input
    // order. (Types are assigned synthetically to exercise the comparator —
    // no real detector emits this arrangement.)
    const text = '2026-07-02';
    const fullSpan = { span: { start: 0, end: 10, type: 'phone', confidence: 1 }, detector: 'c0-regex' };
    const tailSpan = { span: { start: 5, end: 10, type: 'date', confidence: 1 }, detector: 'c0-regex' };
    for (const order of [
      [fullSpan, tailSpan],
      [tailSpan, fullSpan],
    ]) {
      const resolved = dedupSpans(text, order);
      assert.equal(resolved.length, 1);
      assert.equal(
        resolved[0]!.type,
        'phone',
        'the larger native match must win regardless of the lexical fallback or input order',
      );
    }
  });

  it('#727 — when native length also ties, a fixed LEXICAL order (not array order) decides', () => {
    // Force the last-resort key: two spans with the SAME native range but
    // different types. The fall-through is a fixed lexical compare of the type
    // NAME (determinism, not priority), so the lexically-smaller type wins in
    // either input order — proving the tiebreak is the documented rule, never
    // C0_PATTERNS insertion order. Checked with two pairs so a single
    // `date`-always-wins coincidence cannot pass it.
    const text = '2026-07-02';
    const mk = (type: string) => ({ span: { start: 0, end: 10, type, confidence: 1 }, detector: 'c0-regex' });
    // 'date' < 'phone'  and  'amount' < 'phone'  (code-unit order)
    const pairs: readonly (readonly [lo: string, hi: string])[] = [
      ['date', 'phone'],
      ['amount', 'phone'],
    ];
    for (const [lo, hi] of pairs) {
      for (const order of [
        [mk(hi), mk(lo)],
        [mk(lo), mk(hi)],
      ]) {
        const resolved = dedupSpans(text, order);
        assert.equal(resolved.length, 1);
        assert.equal(
          resolved[0]!.type,
          lo,
          `the lexically-smaller type '${lo}' must win over '${hi}' in either input order`,
        );
      }
    }
  });
});

describe('#727 — ISO-8601 dates mask as dates, not phone numbers', () => {
  const PHONE_SHAPE = /\+49\s/; // the phone surrogate pool is `+49 30 5559xxxx`
  const DATE_SHAPE = /^\d{2}\.\d{2}\.\d{4}$/; // the date surrogate pool is `dd.mm.yyyy`

  it('substitutes a bare ISO date from the DATE surrogate pool', async () => {
    const result = await maskPrompt('2026-07-02', [createBaselineDetector()]);
    // The winning span is typed `date`, not `phone`.
    assert.equal(result.spans.length, 1);
    assert.equal(result.spans[0]!.type, 'date');
    assert.equal(result.spans[0]!.value, '2026-07-02');
    // And the wire value is a date surrogate, never a phone number.
    assert.ok(DATE_SHAPE.test(result.maskedText), `expected a date surrogate, got '${result.maskedText}'`);
    assert.ok(!PHONE_SHAPE.test(result.maskedText), `ISO date leaked as a phone surrogate: '${result.maskedText}'`);
    // Round-trips like any masked value.
    assert.equal(resolvePseudonyms(result.maskedText, result.map), '2026-07-02');
  });

  it('the ISO and the dotted shape both mask as dates, and a real phone still masks as a phone (regression: the two must not drift)', async () => {
    // The dotted form was already correct; pin it beside the ISO form so a
    // future change cannot fix one and re-break the other. A genuine phone
    // must still take the phone surrogate — the fix narrows nothing.
    //
    // `30-06-2027` (dashed dd-mm-yyyy, added for nl/fr by #482) is here
    // deliberately: it was broken by the SAME mechanism the issue reported for
    // the ISO shape — the phone pattern's `\b0` branch grabs its `06-2027`
    // tail and word-boundary extension grows it over the whole token — but the
    // issue only named the ISO form, and the C0 eval could not surface either,
    // because it scores span COVERAGE, not surrogate type. Any date whose
    // month/day segment starts with `0` after a `-` is in this class, so all
    // three separator styles are pinned together.
    for (const isoOrDotted of ['2026-07-02', '02.07.2026', '1990-06-15', '30-06-2027']) {
      const r = await maskPrompt(isoOrDotted, [createBaselineDetector()]);
      assert.equal(r.spans[0]?.type, 'date', `${isoOrDotted} must be typed date`);
      assert.ok(DATE_SHAPE.test(r.maskedText), `${isoOrDotted} -> non-date surrogate '${r.maskedText}'`);
    }
    const phone = await maskPrompt('+49 171 2345678', [createBaselineDetector()]);
    assert.equal(phone.spans[0]?.type, 'phone');
    assert.ok(PHONE_SHAPE.test(phone.maskedText), `phone -> non-phone surrogate '${phone.maskedText}'`);
  });
});

describe('createPromptPseudonymMap', () => {
  it('is bijective, type-shaped, and never collides with the input text', () => {
    const map = createPromptPseudonymMap(
      [
        { value: 'anna.schmidt@firma.de', type: 'email' },
        { value: '+49 171 5551234', type: 'phone' },
        { value: 'Anna Schmidt', type: 'person' },
      ],
      RFC_PROMPT,
    );
    assert.equal(map.forward.size, 3);
    assert.equal(map.reverse.size, 3);
    assert.ok(map.forward.get('anna.schmidt@firma.de')!.includes('@'));
    for (const surrogate of map.reverse.keys()) {
      assert.ok(!RFC_PROMPT.includes(surrogate), `surrogate '${surrogate}' collides with input`);
    }
  });

  it('keeps existing surrogates stable when extended', () => {
    const first = createPromptPseudonymMap(
      [{ value: 'anna.schmidt@firma.de', type: 'email' }],
      'a',
    );
    const second = createPromptPseudonymMap(
      [
        { value: 'anna.schmidt@firma.de', type: 'email' },
        { value: 'DE89370400440532013000', type: 'iban' },
      ],
      'a',
      first,
    );
    assert.equal(
      second.forward.get('anna.schmidt@firma.de'),
      first.forward.get('anna.schmidt@firma.de'),
    );
  });
});

describe('maskPrompt', () => {
  it('produces wire text with zero identity leaks for detected values', async () => {
    const result = await maskPrompt(RFC_PROMPT, [createBaselineDetector()]);
    for (const value of RFC_STRUCTURED_VALUES) {
      assert.equal(
        findIdentityLeaks(result.maskedText, [value]).length,
        0,
        `real value '${value}' survived masking`,
      );
    }
  });

  it('round-trips exactly via resolvePseudonyms', async () => {
    const result = await maskPrompt(RFC_PROMPT, [createBaselineDetector()]);
    assert.equal(resolvePseudonyms(result.maskedText, result.map), RFC_PROMPT);
  });

  it('masks a repeated value everywhere, even when detected once', async () => {
    const email = 'anna.schmidt@firma.de';
    const text = `Mail ${email}. I repeat: ${email}`;
    const result = await maskPrompt(text, [createBaselineDetector()]);
    assert.equal(findIdentityLeaks(result.maskedText, [email]).length, 0);
  });

  it('is a no-op on PII-free text', async () => {
    const text = 'Draft a neutral follow-up on the roadmap review.';
    const result = await maskPrompt(text, [createBaselineDetector()]);
    assert.equal(result.maskedText, text);
    assert.equal(result.spans.length, 0);
  });

  it('masks a C1 free-form address even where C0 hits inside it (review finding)', async () => {
    const text =
      'Das Paket bitte an das gelbe Hinterhaus im zweiten Hof der ' +
      'Lindenallee 5, dritter Aufgang links, 60311 Frankfurt am Main liefern.';
    const c1Value =
      'das gelbe Hinterhaus im zweiten Hof der Lindenallee 5, ' +
      'dritter Aufgang links, 60311 Frankfurt am Main';
    const c1Start = text.indexOf(c1Value);
    const fakeC1: PromptPiiDetector = {
      id: 'c1-gliner',
      detect: async () => [
        { start: c1Start, end: c1Start + c1Value.length, type: 'address', confidence: 0.8 },
      ],
    };
    const result = await maskPrompt(text, [createBaselineDetector(), fakeC1]);
    for (const fragment of ['Hinterhaus', 'Lindenallee', 'Aufgang', 'Frankfurt']) {
      assert.equal(
        findIdentityLeaks(result.maskedText, [fragment]).length,
        0,
        `address fragment '${fragment}' survived masking`,
      );
    }
    assert.equal(resolvePseudonyms(result.maskedText, result.map), text);
  });
});

describe('C0 locale patterns (#482 — es/fr/nl miss classes)', () => {
  const detect = (text: string) => createBaselineDetector().detect(text);
  const typesIn = async (text: string) =>
    new Set((await detect(text)).map((s) => s.type));
  const masks = async (text: string, value: string) =>
    findIdentityLeaks((await maskPrompt(text, [createBaselineDetector()])).maskedText, [
      value,
    ]).length === 0;

  // es — separator-less amounts ("899 €", "150 €").
  it('es: catches a separator-less amount with a trailing symbol', async () => {
    const text = 'Reembolsa los gastos de viaje de 899 € al empleado.';
    assert.ok((await typesIn(text)).has('amount'));
    assert.ok(await masks(text, '899 €'));
    assert.ok(await masks('Un vale de 150 € por persona.', '150 €'));
  });

  // es — local mobile/landline grouped 3-3-3 with no +country / leading 0.
  it('es: catches a 3-3-3 local phone without a + or 0 prefix', async () => {
    const text = 'Llama a Diego al 612 334 455 para confirmar la cita.';
    assert.ok((await typesIn(text)).has('phone'));
    assert.ok(await masks(text, '612 334 455'));
  });

  it('es: does not treat a 3-3-3 run outside the 6-9 range as a phone', async () => {
    // A national number never starts 0-5; a bare "100 200 300" must not flag.
    assert.equal((await detect('Series 100 200 300 shipped this quarter.')).length, 0);
  });

  // fr — space-grouped amounts ("2 400 €", "72 000 €").
  it('fr: catches space-grouped thousands amounts', async () => {
    const text = 'La prime, soit 2 400 €, sera versée avec la paie de mars.';
    assert.ok((await typesIn(text)).has('amount'));
    assert.ok(await masks(text, '2 400 €'));
    assert.ok(await masks('Le budget est de 72 000 € par an.', '72 000 €'));
  });

  // fr — written-out month names.
  it('fr: catches a written-out date', async () => {
    const text = 'Élodie est née le 17 septembre 1984 à Bordeaux.';
    assert.ok((await typesIn(text)).has('date'));
    assert.ok(await masks(text, '17 septembre 1984'));
  });

  it('fr: a month word without a year is not a date (anchor guard)', async () => {
    assert.equal((await detect('On se voit en septembre pour le bilan.')).length, 0);
  });

  // nl — dashed DD-MM-YYYY dates ("30-06-2027").
  it('nl: catches a dashed date', async () => {
    const text = 'Willem gaat op 30-06-2027 met pensioen.';
    assert.ok((await typesIn(text)).has('date'));
    assert.ok(await masks(text, '30-06-2027'));
    assert.ok(await masks('Geboren op 28-02-1995.', '28-02-1995'));
  });

  // Regression: the de/en/it forms the shipped patterns already carried must
  // keep working after the separator/branch widening.
  it('keeps the de/en numeric forms it already carried', async () => {
    assert.ok(await masks('Geboren am 24.12.1987 in Köln.', '24.12.1987'));
    assert.ok(await masks('Born on 1990-06-15 in Leeds.', '1990-06-15'));
    assert.ok(await masks('Gehalt von €72.000 im Jahr.', '€72.000'));
    assert.ok(await masks('Salary of 72,000.50 USD gross.', '72,000.50 USD'));
  });

  // Precision: the widened patterns must stay quiet on bare numerics that are
  // neither amounts (no currency anchor) nor full dates (no day-month-year).
  it('does not over-flag bare numerics without a currency or date anchor', async () => {
    for (const text of [
      'We grew revenue 30 percent across 2 400 accounts last year.',
      'Ship 150 units to the depot and 899 to the store.',
      'Chapter 12 covers the 2024 roadmap in detail.',
    ]) {
      assert.equal((await detect(text)).length, 0, `over-flagged: ${text}`);
    }
  });
});

describe('C0 precision on the committed negatives (#482 no-regression guard)', () => {
  // Locks the "the locale patterns flag zero committed negatives" claim into
  // CI: any future widening that over-masks a PII-free fixture fails here,
  // not only in the (non-CI) validation harness. Mirrors the harness's
  // precision proxy, but as a hard invariant — a single flagged span fails.
  interface Fixture {
    readonly text: string;
    readonly spans: readonly unknown[];
  }
  const fixturesDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'packages',
    'harness-plugin-privacy-guard',
    'src',
    'validation',
    'fixtures',
  );
  const locales = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

  // Guard the guard: if the fixtures ever move, we would silently test nothing.
  it('finds the six locale fixture files', () => {
    assert.deepEqual(locales, ['de', 'en', 'es', 'fr', 'it', 'nl']);
  });

  for (const locale of locales) {
    it(`${locale}: C0 flags zero PII-free negatives`, async () => {
      const items = JSON.parse(
        readFileSync(join(fixturesDir, `${locale}.json`), 'utf-8'),
      ) as Fixture[];
      const negatives = items.filter((it) => it.spans.length === 0);
      assert.ok(negatives.length > 0, `${locale} has no negatives to check`);
      const detector = createBaselineDetector();
      for (const neg of negatives) {
        const spans = await detector.detect(neg.text);
        assert.equal(
          spans.length,
          0,
          `C0 over-masked a negative in ${locale}: ` +
            `${JSON.stringify(spans.map((s) => s.type))} in "${neg.text}"`,
        );
      }
    });
  }
});

describe('PrivacyGuardService.maskUserPrompt', () => {
  const req = (turnId: string) => ({ sessionId: 's', turnId, text: RFC_PROMPT });

  it('reports disabled without a readConfig (flag-off ⇒ byte-identical path)', async () => {
    const svc = createPrivacyGuardService();
    assert.deepEqual(await svc.maskUserPrompt!(req('t-off')), { outcome: 'disabled' });
  });

  it('reports disabled when the flag is off/unset', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => 'off' });
    assert.deepEqual(await svc.maskUserPrompt!(req('t-off2')), { outcome: 'disabled' });
  });

  it('masks when the flag is on; wire text carries zero detected real values', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => 'on' });
    const result = await svc.maskUserPrompt!(req('t-on'));
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.degraded, false);
    for (const value of RFC_STRUCTURED_VALUES) {
      assert.equal(findIdentityLeaks(result.maskedText, [value]).length, 0);
    }
    // Span records are PII-free (type + detector only).
    for (const span of result.spans) {
      assert.deepEqual(Object.keys(span).sort(), ['detector', 'type']);
    }
  });

  it('restores surrogates in the answer and surfaces spans in the receipt', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => 'on' });
    const masked = await svc.maskUserPrompt!(req('t-restore'));
    assert.equal(masked.outcome, 'masked');
    if (masked.outcome !== 'masked') return;
    // Simulate the LLM echoing a surrogate back in its answer.
    const answer = `The details: ${masked.maskedText}`;
    const restored = await svc.restorePromptPseudonyms!('t-restore', answer);
    for (const value of RFC_STRUCTURED_VALUES) {
      assert.ok(restored.includes(value), `answer must restore '${value}'`);
    }
    const receipt = await svc.finalizeTurn('t-restore');
    assert.ok(receipt, 'a masked-prompt turn must emit a receipt');
    assert.ok((receipt.maskedPromptSpans?.length ?? 0) > 0);
    // finalize dropped the map — restore becomes identity.
    assert.equal(await svc.restorePromptPseudonyms!('t-restore', answer), answer);
  });

  it('shares one surrogate map across repeated calls in a turn', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => 'on' });
    const a = await svc.maskUserPrompt!({
      sessionId: 's',
      turnId: 't-shared',
      text: 'Mail anna.schmidt@firma.de',
    });
    const b = await svc.maskUserPrompt!({
      sessionId: 's',
      turnId: 't-shared',
      text: 'Attachment mentions anna.schmidt@firma.de again',
    });
    assert.equal(a.outcome, 'masked');
    assert.equal(b.outcome, 'masked');
    if (a.outcome !== 'masked' || b.outcome !== 'masked') return;
    const surrogateA = a.maskedText.replace('Mail ', '');
    assert.ok(
      b.maskedText.includes(surrogateA),
      'the same real value must map to the same surrogate within a turn',
    );
  });

  it('degrades to C0 (audited, masked) when the C1 detector throws', async () => {
    const throwingC1: PromptPiiDetector = {
      id: 'c1-broken',
      detect: async () => {
        throw new Error('transformer down');
      },
    };
    const svc = createPrivacyGuardService({
      readConfig: () => 'on',
      c1Detector: throwingC1,
    });
    const result = await svc.maskUserPrompt!(req('t-degraded'));
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.degraded, true);
    // C0 results still applied.
    assert.equal(
      findIdentityLeaks(result.maskedText, ['anna.schmidt@firma.de']).length,
      0,
    );
  });

  it('uses C1 spans when the detector works (stub seam contract)', async () => {
    const svc = createPrivacyGuardService({
      readConfig: () => 'on',
      c1Detector: createC1StubDetector(),
    });
    const result = await svc.maskUserPrompt!(req('t-c1'));
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.degraded, false);
  });
});

describe('PrivacyTurnHandle prompt-mask delegation', () => {
  function stubService(overrides: Partial<PrivacyGuardService>): PrivacyGuardService {
    return {
      internToolResultV4: async () => ({ digestText: '', datasetId: 'ds' }),
      recordBypassedTool: async () => undefined,
      runV4Tool: async () => ({ resultText: '' }),
      subAgentResultV4: async () => ({ resultText: '' }),
      takeRenderedAnswerV4: async () => undefined,
      v4ToolSpecs: () => [],
      finalizeTurn: async () => undefined,
      ...overrides,
    };
  }

  it('feature-detects providers without the optional methods (disabled / identity)', async () => {
    const handle = createPrivacyTurnHandle({
      service: stubService({}),
      sessionId: 's',
      turnId: 't',
    });
    assert.deepEqual(await handle.maskUserPrompt('text'), { outcome: 'disabled' });
    assert.equal(await handle.restorePromptPseudonyms('answer'), 'answer');
  });

  it('propagates the failure-closed blocked outcome', async () => {
    const handle = createPrivacyTurnHandle({
      service: stubService({
        maskUserPrompt: async () => ({ outcome: 'blocked', reason: 'test' }),
      }),
      sessionId: 's',
      turnId: 't',
    });
    const result = await handle.maskUserPrompt('text');
    assert.equal(result.outcome, 'blocked');
  });

  it('scopes the request to the handle turn/session pair', async () => {
    let seen: { sessionId: string; turnId: string; text: string } | undefined;
    const handle = createPrivacyTurnHandle({
      service: stubService({
        maskUserPrompt: async (request) => {
          seen = request;
          return { outcome: 'masked', maskedText: 'X', spans: [], degraded: false };
        },
      }),
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    await handle.maskUserPrompt('hello');
    assert.deepEqual(seen, { sessionId: 'session-1', turnId: 'turn-1', text: 'hello' });
  });
});
