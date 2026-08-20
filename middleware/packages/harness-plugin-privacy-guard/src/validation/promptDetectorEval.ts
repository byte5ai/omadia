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

/**
 * #760 — CI gate mode (`--check`): run the C0-only set and compare every
 * locale against the committed per-locale floors in `ci-baseline.json`.
 * Non-zero exit on any regression — and on an EMPTY evaluation: a run that
 * scored zero locales or too few items must never report green (the
 * permanently-green no-op is the failure mode this guards against, PR #640).
 * Latency is deliberately not gated here (CI-runner jitter); the 400 ms gate
 * stays part of the interactive report.
 */
interface CiBaseline {
  minItemsPerLocale: number;
  locales: Record<string, { structuredRecall: number; precisionProxy: number }>;
}

function runCheck(perLocale: readonly LocaleResult[]): number {
  const baselinePath = join(dirname(fileURLToPath(import.meta.url)), 'ci-baseline.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as CiBaseline;
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const { report } of perLocale) {
    seen.add(report.locale);
    const floor = baseline.locales[report.locale];
    if (!floor) {
      failures.push(`locale '${report.locale}' has fixtures but no ci-baseline floor — add one`);
      continue;
    }
    // Span totals + negatives ≈ evaluated volume; the point is catching a
    // broken fixture load (near-zero), not an exact item count.
    const items = report.byType.reduce((n, t) => n + t.total, 0) + report.negatives;
    if (items < baseline.minItemsPerLocale) {
      failures.push(
        `locale '${report.locale}' evaluated only ${String(items)} items (< ${String(baseline.minItemsPerLocale)}) — fixture load is broken`,
      );
    }
    if (report.structuredRecall < floor.structuredRecall) {
      failures.push(
        `locale '${report.locale}' structured recall ${(report.structuredRecall * 100).toFixed(1)}% < floor ${(floor.structuredRecall * 100).toFixed(1)}%`,
      );
    }
    if (report.precisionProxy < floor.precisionProxy) {
      failures.push(
        `locale '${report.locale}' precision proxy ${(report.precisionProxy * 100).toFixed(1)}% < floor ${(floor.precisionProxy * 100).toFixed(1)}%`,
      );
    }
  }
  for (const locale of Object.keys(baseline.locales)) {
    if (!seen.has(locale)) {
      failures.push(`baseline locale '${locale}' was not evaluated — fixture file missing?`);
    }
  }
  if (seen.size === 0) {
    failures.push('zero locales evaluated — the check ran against nothing');
  }
  if (failures.length > 0) {
    console.error('\n✗ prompt-PII C0 eval gate FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(
    `\n✓ prompt-PII C0 eval gate: ${String(seen.size)} locale(s) at or above their committed floors`,
  );
  return 0;
}

async function main(): Promise<void> {
  const markdown = process.argv.includes('--markdown');
  const check = process.argv.includes('--check');
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
    // `--check` gates the deterministic C0 set only — the c0+c1 sets depend
    // on a live sidecar CI does not run.
    if (check && setName !== 'c0') continue;
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

  if (check) {
    process.exitCode = runCheck(allResults[0]?.locales ?? []);
    return;
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
