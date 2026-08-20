/**
 * #760 — operator deny-list (custom terms + vetted patterns), idnum C0
 * coverage, service wiring (config keys → detector, receipt type 'custom'),
 * manifest↔code key wiring, and a smoke run of the CI eval gate.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  createBaselineDetector,
  createCustomTermsDetector,
} from '@omadia/plugin-privacy-guard/dist/promptMask.js';
import {
  CUSTOM_PATTERNS_CONFIG_KEY,
  CUSTOM_TERMS_CONFIG_KEY,
  MASK_USER_PROMPT_CONFIG_KEY,
} from '@omadia/plugin-privacy-guard/dist/service.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('#760 createCustomTermsDetector', () => {
  it('matches literal terms case-insensitively on unicode word boundaries', async () => {
    const { detector, rejected } = createCustomTermsDetector({
      terms: ['Projekt Röntgen', 'ACME-4711'],
      patterns: [],
    });
    assert.equal(rejected.length, 0);
    assert.ok(detector);
    const text = 'Der Status von projekt röntgen und acme-4711 ist grün; Röntgenblick nicht.';
    const spans = await detector.detect(text);
    const values = spans.map((s) => text.slice(s.start, s.end));
    assert.deepEqual(values, ['projekt röntgen', 'acme-4711']);
    assert.ok(spans.every((s) => s.type === 'custom' && s.confidence === 1));
    // 'Röntgenblick' must NOT match — word boundary holds against a prefix.
    assert.ok(!values.some((v) => v.toLowerCase().includes('röntgenblick')));
  });

  it('rejects invalid regex syntax loudly instead of dropping it silently', () => {
    const { detector, rejected } = createCustomTermsDetector({
      terms: [],
      patterns: ['[unclosed'],
    });
    assert.equal(detector, undefined);
    assert.deepEqual(rejected, [{ source: '[unclosed', reason: 'syntax' }]);
  });

  it('rejects a catastrophic-backtracking pattern via the probe budget', () => {
    const { rejected } = createCustomTermsDetector({
      terms: [],
      patterns: ['(a+)+$'],
    });
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason, 'too_slow');
  });

  it('rejects a DIGIT-keyed catastrophic pattern — the probe corpus is not letter-only (H1)', () => {
    const { rejected } = createCustomTermsDetector({
      terms: [],
      patterns: ['(\\d+)+$'],
    });
    assert.equal(rejected.length, 1, 'digit-run probes must catch (\\d+)+$');
    assert.equal(rejected[0]!.reason, 'too_slow');
  });

  it('runtime backstop: a pattern over its per-turn budget throws (fail-closed), never passes unmasked', async () => {
    // Budget -1 makes ANY elapsed time an overrun — deterministic without a
    // genuinely slow pattern in the suite.
    const { detector, rejected } = createCustomTermsDetector({
      terms: [],
      patterns: ['ORD-\\d{6}'],
      runtimeBudgetMs: -1,
    });
    assert.equal(rejected.length, 0);
    await assert.rejects(detector!.detect('Bestellung ORD-123456.'), (err: unknown) => {
      assert.ok(err instanceof Error && err.name === 'CustomPatternRuntimeError');
      return true;
    });
  });

  it('runtime backstop never fires for the literal-terms alternation (linear by construction)', async () => {
    const { detector } = createCustomTermsDetector({
      terms: ['Projekt Nachtfalke'],
      patterns: [],
      runtimeBudgetMs: -1,
    });
    const spans = await detector!.detect('Projekt Nachtfalke läuft.');
    assert.equal(spans.length, 1);
  });

  it('a vetted custom pattern detects spans of type custom', async () => {
    const { detector, rejected } = createCustomTermsDetector({
      terms: [],
      patterns: ['ORD-\\d{6}'],
    });
    assert.equal(rejected.length, 0);
    const spans = await detector!.detect('Bestellung ORD-123456 ist raus.');
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.type, 'custom');
  });

  it('returns no detector at all for empty config (baseline-only fast path)', () => {
    const { detector } = createCustomTermsDetector({ terms: [], patterns: [] });
    assert.equal(detector, undefined);
  });
});

describe('#760 idnum C0 patterns', () => {
  const CASES: Array<[string, string]> = [
    ['DE Steuer-ID grouped', 'Meine Steuer-ID lautet 12 345 678 901.'],
    ['DE Steuer-ID bare', 'Steuer-ID 86195742719 bitte pruefen.'],
    ['DE USt-IdNr', 'Rechnung mit DE123456789 ausstellen.'],
    ['ES NIE', 'Su NIE es X-2482300-W.'],
    ['ES DNI', 'DNI 45678123L registrado.'],
    ['IT Codice Fiscale', 'CF: RSSMRA85T10A562S.'],
    ['UK NINO', 'NI number QQ 12 34 56 C on file.'],
    ['FR n° sécu', 'Numéro 1 84 12 75 123 456 78 enregistré.'],
  ];
  for (const [label, text] of CASES) {
    it(`detects ${label}`, async () => {
      const spans = await createBaselineDetector().detect(text);
      assert.ok(
        spans.some((s) => s.type === 'idnum'),
        `expected an idnum span in ${JSON.stringify(text)}; got ${JSON.stringify(spans.map((s) => s.type))}`,
      );
    });
  }

  it('does not fire idnum on short plain numbers', async () => {
    const spans = await createBaselineDetector().detect('Wir bestellen 42 Stück zu je 7 Punkten.');
    assert.ok(!spans.some((s) => s.type === 'idnum'));
  });
});

describe('#760 service wiring: config → detector → receipt', () => {
  // Each call constructs a fresh service — the detector fingerprint cache
  // lives in the service closure (review M4), so no global reset is needed.
  function service(config: Record<string, unknown>) {
    return createPrivacyGuardService({
      readConfig: (key: string) => config[key],
    });
  }

  it('masks a configured custom term and reports it as a custom span', async () => {
    const svc = service({
      [MASK_USER_PROMPT_CONFIG_KEY]: 'on',
      [CUSTOM_TERMS_CONFIG_KEY]: 'Projekt Nachtfalke; Kunde Obsidian',
    });
    const result = await svc.maskUserPrompt!({
      sessionId: 's1',
      turnId: 't1',
      text: 'Update zu Projekt Nachtfalke: Kunde Obsidian ist zufrieden.',
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(!result.maskedText.includes('Nachtfalke'), result.maskedText);
    assert.ok(!result.maskedText.includes('Obsidian'), result.maskedText);
    assert.equal(result.spans.length, 2);
    assert.ok(result.spans.every((s) => s.type === 'custom' && s.detector === 'custom-terms'));
  });

  it('custom patterns flow through the same fail-closed machinery', async () => {
    const svc = service({
      [MASK_USER_PROMPT_CONFIG_KEY]: 'on',
      [CUSTOM_PATTERNS_CONFIG_KEY]: 'ORD-\\d{6}',
    });
    const result = await svc.maskUserPrompt!({
      sessionId: 's1',
      turnId: 't1',
      text: 'Bitte ORD-123456 stornieren.',
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(!result.maskedText.includes('ORD-123456'));
  });

  it('without custom config the behaviour is byte-identical baseline-only', async () => {
    const svc = service({ [MASK_USER_PROMPT_CONFIG_KEY]: 'on' });
    const result = await svc.maskUserPrompt!({
      sessionId: 's1',
      turnId: 't1',
      text: 'Update zu Projekt Nachtfalke ohne PII.',
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(result.maskedText.includes('Nachtfalke'), 'no custom config ⇒ term passes');
  });
});

describe('#760 manifest ↔ code wiring', () => {
  it('the config keys the service reads are declared setup fields (and vice versa)', () => {
    // The Wave-L lesson: a declared field nobody reads (or a read key nobody
    // declares) passes every unit test — assert against manifest.yaml itself.
    const manifest = readFileSync(
      join(HERE, '..', 'packages', 'harness-plugin-privacy-guard', 'manifest.yaml'),
      'utf-8',
    );
    for (const key of [CUSTOM_TERMS_CONFIG_KEY, CUSTOM_PATTERNS_CONFIG_KEY, MASK_USER_PROMPT_CONFIG_KEY]) {
      assert.ok(manifest.includes(`key: "${key}"`), `manifest must declare setup field '${key}'`);
    }
  });
});

describe('#760 CI eval gate smoke', () => {
  it('promptDetectorEval --check exits 0 against the committed baselines', () => {
    const evalPath = join(
      HERE, '..', 'packages', 'harness-plugin-privacy-guard', 'src', 'validation', 'promptDetectorEval.ts',
    );
    const out = spawnSync(
      process.execPath,
      ['--import', 'tsx', evalPath, '--check'],
      { encoding: 'utf-8', timeout: 120_000, cwd: join(HERE, '..') },
    );
    assert.equal(
      out.status,
      0,
      `--check must pass: ${out.stdout.slice(-800)}\n${out.stderr.slice(-800)}`,
    );
    // The permanently-green-no-op guard: the success line must state a
    // non-zero locale count.
    assert.match(out.stdout, /eval gate: [1-9]\d* locale\(s\)/);
  });
});
