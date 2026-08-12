/**
 * Golden-set regression eval CLI — #129. `npm run eval:golden`.
 *
 * Runs the frozen corpus through a REAL VerifierPipeline built on the pinned
 * model and exits non-zero on any post-majority verdict-class mismatch. It is
 * deliberately OUTSIDE the `test/**\/*.test.ts` glob so `npm test` never needs a
 * key; the harness logic it relies on is unit-tested in
 * `test/goldenRunner.test.ts`.
 *
 * Model pinned: the verifier's stochastic stages (ClaimExtractor, EvidenceJudge)
 * run on VERIFIER_MODEL — so THAT is the honest thing to regression-test here,
 * not ORCHESTRATOR_MODEL, which these stages never call. Override with
 * GOLDEN_MODEL. Default mirrors config.ts (`claude-haiku-4-5-20251001`).
 * Full-turn generation eval against the orchestrator model is v2 (see README).
 *
 * Key handling: absent ANTHROPIC_API_KEY => skip-with-notice, exit 0. That keeps
 * the CI job green on a repo/fork where the secret is not configured instead of
 * failing red on missing infrastructure.
 */

import { appendFileSync, readFileSync, readdirSync } from 'node:fs';

import {
  createAnthropicClient,
  createAnthropicProvider,
} from '@omadia/llm-adapter-anthropic';

import {
  formatSummary,
  hasRegression,
  loadCorpusFromText,
  runCorpus,
  type GoldenEntry,
  type GoldenResult,
} from './goldenRunner.js';
import { buildVerifierRunOnce } from './goldenModel.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

function loadCorpus(): GoldenEntry[] {
  const dir = new URL('./corpus/', import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  const entries: GoldenEntry[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    entries.push(...loadCorpusFromText(text, file));
  }
  return entries;
}

function writeJobSummary(results: GoldenResult[], model: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const total = results.reduce((s, r) => s + r.tokens, 0);
  const failed = results.filter((r) => !r.pass);
  const rows = results
    .map(
      (r) =>
        `| ${r.pass ? '✅' : '❌'} | \`${r.id}\` | ${r.expected} | ${r.decided} | ${r.runs.join(', ')} | ${r.tokens} |`,
    )
    .join('\n');
  const md = [
    `## Golden-set eval (#129) — model \`${model}\``,
    '',
    `${results.length - failed.length}/${results.length} passed · ${failed.length} regressed · ${total} tokens total`,
    '',
    '| | entry | expected | decided | samples | tokens |',
    '| --- | --- | --- | --- | --- | --- |',
    rows,
    '',
  ].join('\n');
  appendFileSync(path, md);
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      '::notice::ANTHROPIC_API_KEY not set — skipping golden-set eval (#129). ' +
        'No regression signal collected this run.',
    );
    process.exit(0);
  }

  const model = process.env.GOLDEN_MODEL ?? process.env.VERIFIER_MODEL ?? DEFAULT_MODEL;
  const entries = loadCorpus();
  console.log(
    `golden-eval: ${entries.length} corpus entries against model=${model}\n`,
  );

  const client = createAnthropicClient({ apiKey });
  const provider = createAnthropicProvider({ client });
  const runOnce = buildVerifierRunOnce(provider, model);

  const results = await runCorpus(entries, runOnce);
  console.log(formatSummary(results));
  writeJobSummary(results, model);

  process.exit(hasRegression(results) ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('golden-eval crashed:', err);
  process.exit(1);
});
