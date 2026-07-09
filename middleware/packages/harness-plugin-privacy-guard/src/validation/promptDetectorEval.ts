/**
 * #361 — standalone prompt-PII detector evaluation (NOT a CI gate).
 *
 * Run from `middleware/`:
 *   npx tsx packages/harness-plugin-privacy-guard/src/validation/promptDetectorEval.ts
 *
 * Scores each configured detector set against the fixture files using the
 * exact-match leak criterion (`findIdentityLeaks`): a PII instance counts as
 * masked only when its full real value is absent from the masked output.
 * Gates are documented in ./README.md and were committed before any run.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PromptPiiDetector } from '@omadia/plugin-api';

import { createBaselineDetector, maskPrompt } from '../promptMask.js';
import { findIdentityLeaks } from '../v4/onTheWire.js';

interface FixtureSpan {
  readonly value: string;
  readonly type: string;
  readonly tier: 'critical' | 'high' | 'medium';
}

interface FixtureItem {
  readonly text: string;
  readonly spans: readonly FixtureSpan[];
}

/** Detector sets under evaluation. Add `['c0+c1', [baseline, c1]]` here
 *  once a real C1 transformer detector is wired. */
const DETECTOR_SETS: ReadonlyArray<[string, readonly PromptPiiDetector[]]> = [
  ['c0', [createBaselineDetector()]],
];

/** Types the C0 baseline is expected (and gated) to catch. `person` and
 *  other free-form entities are C1 territory — reported separately. */
const STRUCTURED_TYPES = new Set(['email', 'iban', 'phone', 'address', 'amount', 'date']);

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

async function evalLocale(
  locale: string,
  items: readonly FixtureItem[],
  detectors: readonly PromptPiiDetector[],
): Promise<void> {
  const byType = new Map<string, { total: number; masked: number }>();
  let negatives = 0;
  let cleanNegatives = 0;
  const latencies: number[] = [];

  for (const item of items) {
    const startedAt = performance.now();
    const result = await maskPrompt(item.text, detectors);
    latencies.push(performance.now() - startedAt);

    if (item.spans.length === 0) {
      negatives += 1;
      if (result.spans.length === 0) cleanNegatives += 1;
      continue;
    }
    for (const span of item.spans) {
      const bucket = byType.get(span.type) ?? { total: 0, masked: 0 };
      bucket.total += 1;
      // Exact-match criterion: the full real value must be gone.
      if (findIdentityLeaks(result.maskedText, [span.value]).length === 0) {
        bucket.masked += 1;
      }
      byType.set(span.type, bucket);
    }
  }

  console.log(`\n=== ${locale} ===`);
  let structuredTotal = 0;
  let structuredMasked = 0;
  for (const [type, { total, masked }] of [...byType.entries()].sort()) {
    const recall = total === 0 ? 1 : masked / total;
    const scope = STRUCTURED_TYPES.has(type) ? 'structured' : 'c1-scope';
    console.log(
      `  recall ${type.padEnd(8)} ${masked}/${total}  ${(recall * 100).toFixed(1)}%  (${scope})`,
    );
    if (STRUCTURED_TYPES.has(type)) {
      structuredTotal += total;
      structuredMasked += masked;
    }
  }
  const structuredRecall = structuredTotal === 0 ? 1 : structuredMasked / structuredTotal;
  const precisionProxy = negatives === 0 ? 1 : cleanNegatives / negatives;
  const latencyP95 = p95(latencies);
  console.log(`  structured recall     ${(structuredRecall * 100).toFixed(1)}%  (gate ≥ 97%)`);
  console.log(`  negatives clean       ${cleanNegatives}/${negatives}  (gate ≥ 85%)`);
  console.log(`  p95 latency           ${latencyP95.toFixed(1)} ms  (gate ≤ 400 ms)`);
  const pass =
    structuredRecall >= 0.97 && precisionProxy >= 0.85 && latencyP95 <= 400;
  console.log(`  verdict (structured-identifier gates only): ${pass ? 'PASS' : 'FAIL'}`);
}

async function main(): Promise<void> {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const locales = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  for (const [setName, detectors] of DETECTOR_SETS) {
    console.log(`\n########## detector set: ${setName} ##########`);
    for (const locale of locales) {
      const items = JSON.parse(
        readFileSync(join(fixturesDir, `${locale}.json`), 'utf-8'),
      ) as FixtureItem[];
      await evalLocale(locale, items, detectors);
    }
  }
  console.log(
    '\nNote: name/free-form (`person`) recall requires a C1 transformer detector — C0 alone must not gate those types. See README.md.',
  );
}

void main();
