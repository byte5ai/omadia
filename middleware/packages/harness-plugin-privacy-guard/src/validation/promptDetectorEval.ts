/**
 * #361 — standalone prompt-PII detector evaluation (NOT a CI gate).
 *
 * Run from `middleware/`:
 *   npx tsx packages/harness-plugin-privacy-guard/src/validation/promptDetectorEval.ts
 *
 * Detector sets are built from the environment:
 *   - always:                      `c0`      (regex baseline)
 *   - with PII_DETECTOR_URL set:   `c0+c1`   (baseline + GLiNER sidecar)
 *                                  `c1-solo` (ablation — reported, not gated)
 *     e.g. PII_DETECTOR_URL=http://localhost:8812 when the
 *     `docker-compose.pii-detector.yaml` sidecar is reachable locally.
 *
 * Flags:
 *   --markdown   emit GitHub-flavored tables (for posting to issue #361)
 *                instead of the default console format.
 *
 * Scoring uses the exact-match leak criterion (`findIdentityLeaks`): a PII
 * instance counts as masked only when its full verbatim value is absent
 * from the masked output. Gates are documented in ./README.md and were
 * committed before any run; scoring/aggregation/rendering helpers live in
 * ./report.ts.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PromptPiiDetector } from '@omadia/plugin-api';

import { createC1HttpDetector } from '../c1Detector.js';
import { createBaselineDetector, maskPrompt } from '../promptMask.js';
import {
  aggregateLocale,
  evaluateGates,
  lintFixtures,
  renderConsoleLocale,
  renderMarkdown,
  type FixtureItem,
  type ItemOutcome,
  type LocaleResult,
  type SetResults,
} from './report.js';

/** Detector sets under evaluation, built from the environment. Without
 *  `PII_DETECTOR_URL` this is the shipped c0-only run. The C1 timeout is
 *  deliberately generous (10 s vs the runtime's 1500 ms): the harness
 *  measures detection quality and REPORTS latency against the 400 ms gate —
 *  it must not silently convert a slow sidecar into thrown timeouts. */
function buildDetectorSets(): Array<[string, readonly PromptPiiDetector[]]> {
  const sets: Array<[string, readonly PromptPiiDetector[]]> = [
    ['c0', [createBaselineDetector()]],
  ];
  const c1Url = process.env['PII_DETECTOR_URL']?.trim();
  if (c1Url !== undefined && c1Url !== '') {
    const c1 = createC1HttpDetector({ resolveUrl: () => c1Url, timeoutMs: 10_000 });
    sets.push(['c0+c1', [createBaselineDetector(), c1]]);
    sets.push(['c1-solo', [c1]]);
  }
  return sets;
}

/** PII-shaped warm-up text: primes regex JIT and, more importantly, the
 *  sidecar's first-inference session so model warm-up never pollutes p95. */
const WARMUP_TEXT =
  'Warm-up only: contact Max Mustermann at Musterstraße 1, 12345 Berlin ' +
  'or max.mustermann@example.com before 24.12.2026.';

async function evalLocale(
  items: readonly FixtureItem[],
  detectors: readonly PromptPiiDetector[],
): Promise<ItemOutcome[]> {
  const outcomes: ItemOutcome[] = [];
  for (const item of items) {
    const startedAt = performance.now();
    const result = await maskPrompt(item.text, detectors);
    const latencyMs = performance.now() - startedAt;
    outcomes.push({
      maskedText: result.maskedText,
      flaggedSpans: result.spans.length,
      latencyMs,
    });
  }
  return outcomes;
}

async function main(): Promise<void> {
  const markdown = process.argv.includes('--markdown');
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const locales = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

  // Load + lint everything up-front: a malformed fixture file fails the
  // whole run loudly before any numbers are printed.
  const fixtures = new Map<string, FixtureItem[]>();
  for (const locale of locales) {
    const raw: unknown = JSON.parse(
      readFileSync(join(fixturesDir, `${locale}.json`), 'utf-8'),
    );
    fixtures.set(locale, lintFixtures(locale, raw));
  }

  const allResults: SetResults[] = [];
  for (const [setName, detectors] of buildDetectorSets()) {
    if (!markdown) console.log(`\n########## detector set: ${setName} ##########`);
    // One un-timed warm-up call per set before measurement.
    await maskPrompt(WARMUP_TEXT, detectors);
    const perLocale: LocaleResult[] = [];
    for (const [locale, items] of fixtures) {
      const outcomes = await evalLocale(items, detectors);
      const report = aggregateLocale(locale, items, outcomes);
      const verdict = evaluateGates(setName, report);
      perLocale.push({ report, verdict });
      if (!markdown) console.log(renderConsoleLocale(report, verdict));
    }
    allResults.push({ set: setName, locales: perLocale });
  }

  if (markdown) {
    console.log(renderMarkdown(allResults));
  } else {
    console.log(
      '\nNote: `person` recall gates only on the c0+c1 set (C0 alone does not ' +
        'detect names); run with PII_DETECTOR_URL pointing at the GLiNER ' +
        'sidecar to evaluate it. See README.md.',
    );
  }
}

void main();
