/**
 * Golden-set regression runner — PURE layer (#129).
 *
 * This file is deliberately SDK-, network- and key-free: corpus parsing,
 * majority-of-K voting, verdict-class comparison and summary formatting, plus
 * the shared types. Its only `@omadia/verifier` dependency is a `import type`
 * (erased at runtime), so `test/goldenRunner.test.ts` can load it in the default
 * `npm test` glob WITHOUT the verifier package being built.
 *
 * The stochastic model call lives behind the injected `RunOnce` type; the real
 * wiring that produces one (`buildVerifierRunOnce`) is quarantined in the sibling
 * `goldenModel.ts`, which DOES pull the verifier package as a value. Keeping the
 * split at the module boundary (not just the function boundary) is what makes the
 * pure suite genuinely independent of `dist/`.
 *
 * The assertion target is the verifier's verdict CLASS (approved /
 * approved_with_disclaimer / blocked), not the raw model string — that is the
 * stable signal despite generation stochasticity (see the issue's concept
 * excerpt). Flake tolerance: an entry that misses on the first sample is
 * re-run up to `maxRuns` total and decided by majority.
 */

import type { EvidenceSnippet, VerifierVerdict } from '@omadia/verifier';

/** The three stable assertion targets — the live `VerifierVerdict` statuses. */
export type StatusName = VerifierVerdict['status'];

const STATUS_NAMES: readonly StatusName[] = [
  'approved',
  'approved_with_disclaimer',
  'blocked',
];

/** Trace fields lifted verbatim into `VerifierInput`. */
export interface GoldenTrace {
  agent?: string;
  domainToolsCalled?: string[];
  knowledgeGraphToolsCalled?: boolean;
  toolPostconditionViolations?: {
    toolName: string;
    callId: string;
    agentContext: string;
    issues: string[];
  }[];
}

/** One frozen corpus fixture. */
export interface GoldenEntry {
  /** Stable id; unique within the corpus. Used in output + as the runId. */
  id: string;
  /** Free-text note on WHY this entry has its expected class. */
  note?: string;
  userMessage: string;
  answer: string;
  /** Trace evidence the pipeline reads (tool-postcondition / citation paths). */
  trace?: GoldenTrace;
  /**
   * Fixture-backed evidence the EvidenceJudge sees for any soft claim. Empty /
   * omitted => the judge has "no evidence available" => `unverified` =>
   * approved_with_disclaimer. Confirming evidence => verified. Contradicting
   * evidence => contradicted => blocked.
   */
  evidence?: EvidenceSnippet[];
  expected: { status: StatusName };
}

export interface EntryRun {
  status: StatusName;
  /** input+output tokens spent across every LLM call in this single run. */
  tokens: number;
}

/** One stochastic execution of a fixture. Injected so the pure layer never
 *  touches the SDK or a key. */
export type RunOnce = (entry: GoldenEntry) => Promise<EntryRun>;

export interface GoldenResult {
  id: string;
  expected: StatusName;
  /** verdict class of each sample, in order. */
  runs: StatusName[];
  /** the class after majority — what we compare against `expected`. */
  decided: StatusName;
  pass: boolean;
  /** summed tokens across every sample of this entry. */
  tokens: number;
}

// ---------------------------------------------------------------------------
// Corpus parsing (pure)
// ---------------------------------------------------------------------------

function isStatusName(v: unknown): v is StatusName {
  return typeof v === 'string' && (STATUS_NAMES as readonly string[]).includes(v);
}

/**
 * Parse one JSONL line into a validated `GoldenEntry`. Throws a located error
 * on malformed input — a bad fixture must fail loudly, not silently drop
 * coverage.
 */
export function parseCorpusLine(
  line: string,
  file: string,
  lineNo: number,
): GoldenEntry {
  const where = `${file}:${lineNo}`;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    throw new Error(`${where}: invalid JSON — ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${where}: entry must be a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  const req = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`${where}: missing/empty string field "${k}"`);
    }
    return v;
  };
  const id = req('id');
  const userMessage = req('userMessage');
  const answer = req('answer');
  const expected = o['expected'] as { status?: unknown } | undefined;
  if (!expected || !isStatusName(expected.status)) {
    throw new Error(
      `${where}: "expected.status" must be one of ${STATUS_NAMES.join(' | ')}`,
    );
  }
  const entry: GoldenEntry = {
    id,
    userMessage,
    answer,
    expected: { status: expected.status },
  };
  if (typeof o['note'] === 'string') entry.note = o['note'];
  if (o['trace'] !== undefined) entry.trace = o['trace'] as GoldenTrace;
  if (o['evidence'] !== undefined) {
    entry.evidence = o['evidence'] as EvidenceSnippet[];
  }
  return entry;
}

/** Parse a whole `.jsonl` file body. Blank lines and `#`-comment lines skipped. */
export function loadCorpusFromText(text: string, file: string): GoldenEntry[] {
  const out: GoldenEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    out.push(parseCorpusLine(line, file, i + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Voting + comparison (pure)
// ---------------------------------------------------------------------------

/** Mode of a non-empty status list. Ties resolve to the earliest sample, which
 *  keeps a 1-1-1 three-way split a deterministic (and, vs. any single expected,
 *  usually failing) outcome rather than a coin flip. */
export function majority(items: StatusName[]): { winner: StatusName; count: number } {
  const first = items[0];
  if (first === undefined) {
    throw new Error('majority(): empty sample list');
  }
  const counts = new Map<StatusName, number>();
  for (const s of items) counts.set(s, (counts.get(s) ?? 0) + 1);
  let winner: StatusName = first;
  let best = 0;
  for (const s of items) {
    const c = counts.get(s) ?? 0;
    if (c > best) {
      best = c;
      winner = s;
    }
  }
  return { winner, count: best };
}

/**
 * Run a single fixture with flake tolerance. Cost-aware: a sample that already
 * matches `expected` on the first try costs ONE model call; only a first-sample
 * miss pays for the re-runs (up to `maxRuns` total) that a majority vote needs.
 * This bounds worst-case cost at `maxRuns × corpus size` while keeping the
 * common (green) path cheap.
 */
export async function runEntry(
  entry: GoldenEntry,
  runOnce: RunOnce,
  maxRuns = 3,
): Promise<GoldenResult> {
  const first = await runOnce(entry);
  const runs: EntryRun[] = [first];
  if (first.status !== entry.expected.status) {
    while (runs.length < maxRuns) {
      runs.push(await runOnce(entry));
    }
  }
  const statuses = runs.map((r) => r.status);
  // `majority` returns the sole sample unchanged for a one-element list, so it
  // doubles as the single-run case — no separate index into `statuses`.
  const decided = majority(statuses).winner;
  return {
    id: entry.id,
    expected: entry.expected.status,
    runs: statuses,
    decided,
    pass: decided === entry.expected.status,
    tokens: runs.reduce((sum, r) => sum + r.tokens, 0),
  };
}

export async function runCorpus(
  entries: GoldenEntry[],
  runOnce: RunOnce,
  maxRuns = 3,
): Promise<GoldenResult[]> {
  const results: GoldenResult[] = [];
  // Sequential on purpose: shared per-account Anthropic rate limits make a
  // fan-out flaky and the cost signal harder to attribute per entry.
  for (const entry of entries) {
    results.push(await runEntry(entry, runOnce, maxRuns));
  }
  return results;
}

export function hasRegression(results: GoldenResult[]): boolean {
  return results.some((r) => !r.pass);
}

/** Human + CI-log summary. Failures first, then a totals line with token cost. */
export function formatSummary(results: GoldenResult[]): string {
  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
  const failed = results.filter((r) => !r.pass);
  const lines: string[] = [];
  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    lines.push(
      `${mark}  ${r.id.padEnd(28)} expected=${r.expected} decided=${r.decided} ` +
        `runs=[${r.runs.join(',')}] tokens=${r.tokens}`,
    );
  }
  lines.push('');
  lines.push(
    `golden-eval: ${results.length - failed.length}/${results.length} passed, ` +
      `${failed.length} regressed, ${totalTokens} tokens total`,
  );
  return lines.join('\n');
}
