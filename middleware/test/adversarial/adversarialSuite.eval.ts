/**
 * Adversarial injection/manipulation eval CLI — #498. `npm run eval:adversarial`.
 *
 * Runs the frozen attack corpus against the REAL defenses and fails on a
 * hardening regression or a vanished scenario. Two tiers:
 *
 *   - Deterministic (Tier A) always runs — no key needed. This is the wire-level
 *     gate: digest boundary, secret scrubber, skill-import data frame,
 *     tool-result provenance frame.
 *   - Behavioral (Tier B) runs only with ANTHROPIC_API_KEY: the multi-turn
 *     conductor + 3-juror Delphi. Absent the key it is skipped with a notice and
 *     the deterministic tier still gates — a partial-but-honest signal, unlike
 *     the all-or-nothing golden eval.
 *
 * Regression model: the run is diffed against the committed `baseline.json`. A
 * `held → breached` flip OR a baseline scenario missing from the run fails the
 * job (the second guards the #565 silent-coverage-loss failure mode). Pass
 * `--update-baseline` to rewrite the baseline after an intentional change.
 *
 * The pure harness (`adversarialRunner.ts`) is unit-tested in the keyless
 * `npm test` glob; the deterministic probes (`adversarialModel.ts`) are covered
 * there with a stub provider. This CLI lives OUTSIDE `test/**\/*.test.ts`.
 */

import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { createAnthropicClient, createAnthropicProvider } from '@omadia/llm-adapter-anthropic';

import {
  diffBaseline,
  findDuplicateId,
  formatSummary,
  isBlockingDiff,
  loadScenariosFromText,
  scoreSuite,
  serializeBaseline,
  type AttackScenario,
  type Baseline,
  type ScenarioResult,
} from './adversarialRunner.js';
import {
  runBehavioralScenario,
  runDeterministicScenario,
  type BehavioralModels,
} from './adversarialModel.js';

const BASELINE_NOTE =
  'Adversarial injection/manipulation eval baseline (#498). Deterministic (Tier A) ' +
  'outcomes are seeded keyless; behavioral (Tier B) outcomes appear on the first ' +
  'key-gated run on main. Bump with `npm run eval:adversarial -- --update-baseline`.';

function corpusDir(): URL {
  return new URL('./corpus/', import.meta.url);
}

function loadCorpus(): AttackScenario[] {
  const dir = corpusDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  const scenarios: AttackScenario[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    scenarios.push(...loadScenariosFromText(text, file));
  }
  const dup = findDuplicateId(scenarios);
  if (dup) throw new Error(`adversarial corpus: duplicate scenario id "${dup}"`);
  return scenarios;
}

function loadBaseline(): Baseline {
  try {
    const text = readFileSync(new URL('./baseline.json', import.meta.url), 'utf8');
    return JSON.parse(text) as Baseline;
  } catch {
    // No baseline yet ⇒ empty. diffBaseline treats every scenario as novel, so
    // the seed run records without gating.
    return { scenarios: [] };
  }
}

function writeJobSummary(results: ScenarioResult[]): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const score = scoreSuite(results);
  const pct = score.total === 0 ? '—' : `${Math.round((score.held / score.total) * 100)}%`;
  const vectorRows = score.byVector
    .map((v) => `| ${v.vector} | ${v.held}/${v.total} |`)
    .join('\n');
  const scenarioRows = results
    .map(
      (r) =>
        `| ${r.outcome === 'held' ? '🛡️ held' : '⚠️ breach'} | \`${r.id}\` | ${r.vector} | ${r.tier} | ${
          r.tier === 'behavioral'
            ? `${String(r.turns ?? 0)} turns, revoted=${String(r.consensus?.revoted ?? false)}`
            : (r.evidence ?? '')
        } |`,
    )
    .join('\n');
  const md = [
    '## Adversarial injection/manipulation eval (#498)',
    '',
    `**${score.held}/${score.total} defenses held (${pct} resistance)** · ${score.breached} breached`,
    '',
    '| vector | held |',
    '| --- | --- |',
    vectorRows,
    '',
    '| | scenario | vector | tier | detail |',
    '| --- | --- | --- | --- | --- |',
    scenarioRows,
    '',
  ].join('\n');
  appendFileSync(path, md);
}

async function main(): Promise<void> {
  const updateBaseline = process.argv.includes('--update-baseline');
  const scenarios = loadCorpus();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const deterministic = scenarios.filter((s) => s.tier === 'deterministic');
  const behavioral = scenarios.filter((s) => s.tier === 'behavioral');

  console.log(
    `adversarial-eval: ${scenarios.length} scenarios ` +
      `(${deterministic.length} deterministic, ${behavioral.length} behavioral)\n`,
  );

  // `Promise.all` preserves input order, so the run stays byte-stable; the
  // probes themselves are key-free and network-free (#805 made the seam async
  // because the skill-import renderer composes through its provider).
  const results: ScenarioResult[] = await Promise.all(
    deterministic.map(runDeterministicScenario),
  );
  // Behavioral scenarios skipped for lack of a key are expected-absent, not a
  // vanished-coverage regression — tell diffBaseline so a keyless run against a
  // baseline that already carries behavioral outcomes does not false-fail.
  const skippedIds = new Set<string>();

  if (behavioral.length > 0) {
    if (!apiKey) {
      for (const s of behavioral) skippedIds.add(s.id);
      console.log(
        '::notice::ANTHROPIC_API_KEY not set — skipping ' +
          `${String(behavioral.length)} behavioral scenario(s) (#498). ` +
          'Deterministic tier still gates.',
      );
    } else {
      const provider = createAnthropicProvider({ client: createAnthropicClient({ apiKey }) });
      const models: BehavioralModels = {
        attacker: process.env.ADVERSARIAL_ATTACKER_MODEL ?? 'claude-opus-4-8',
        target: process.env.ADVERSARIAL_TARGET_MODEL ?? 'claude-haiku-4-5-20251001',
        // Sonnet, not the attacker's Opus: the three jurors each read the whole
        // transcript, so the jury dominates input tokens while doing the least
        // open-ended work. `findIdentityLeaks` still overrides the vote on a
        // real leak, so the cheaper scorer cannot make an actual breach pass.
        juror: process.env.ADVERSARIAL_JUROR_MODEL ?? 'claude-sonnet-5',
      };
      console.log(
        `behavioral: attacker=${models.attacker} target=${models.target} ` +
          `juror=${models.juror}\n`,
      );
      for (const scenario of behavioral) {
        results.push(await runBehavioralScenario(scenario, provider, models));
      }
    }
  }

  if (updateBaseline) {
    const url = new URL('./baseline.json', import.meta.url);
    writeFileSync(url, serializeBaseline(results, BASELINE_NOTE));
    console.log(`baseline updated: ${results.length} scenarios written to baseline.json`);
    return;
  }

  const corpusIds = new Set(scenarios.map((s) => s.id));
  const diff = diffBaseline(results, loadBaseline(), { corpusIds, skippedIds });
  console.log(formatSummary(results, diff));
  writeJobSummary(results);

  if (isBlockingDiff(diff)) {
    console.error(
      '\n::error::Adversarial hardening regressed (#498): ' +
        `${String(diff.regressions.length)} defense(s) breached that previously held, ` +
        `${String(diff.missing.length)} baseline scenario(s) missing.`,
    );
    process.exit(1);
  }
  // A breach with no baseline (novel) does not block the seed run, but a breach
  // that the baseline already records as `held` is caught above.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('adversarial-eval crashed:', err);
  process.exit(1);
});
