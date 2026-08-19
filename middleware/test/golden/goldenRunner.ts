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

import type {
  ClaimType,
  ClaimVerdict,
  EvidenceSnippet,
  VerifierVerdict,
} from '@omadia/verifier';

import type { OdooFixture } from './fixtureOdooReader.js';

/** The three stable assertion targets — the live `VerifierVerdict` statuses. */
export type StatusName = VerifierVerdict['status'];

/**
 * #639 v2 — an OPTIONAL, stronger assertion than the verdict class alone: it
 * pins WHICH path produced the class, so an entry cannot pass for the wrong
 * reason.
 *
 * The v1 blind spot was structural: a triggering answer whose extractor
 * happens to return zero claims lands in `approved` for FREE — the same
 * trigger-skip trap the corpus README warns about, one layer up. Asserting
 * only `status === 'approved'` would let that empty-extraction case pass and
 * hide a regression where the deterministic checker stopped confirming true
 * claims. `via` closes that: the entry passes only if a decided-class sample
 * also carried a HARD-claim verdict of the required kind.
 *
 *  - `deterministic-verified`   — an Odoo/graph re-query CONFIRMED a hard claim
 *    (closes Gap 1: a genuine `verified → approved`, not trigger-skip).
 *  - `deterministic-contradicted` — an Odoo/graph re-query REFUTED a hard claim
 *    (closes Gap 2: ERP data contradicts the answer → blocked, distinct from
 *    the judge-contradiction and trace-missing-call paths, both of which this
 *    predicate excludes — see `viaSatisfied`).
 */
export type ViaTag = 'deterministic-verified' | 'deterministic-contradicted';

const VIA_TAGS: readonly ViaTag[] = [
  'deterministic-verified',
  'deterministic-contradicted',
];

/** Claim types the DeterministicChecker owns (vs. the EvidenceJudge's soft
 *  `name`/`qualitative`). A `via` predicate keys on this so a judge or
 *  synthetic contradiction can never satisfy a `deterministic-*` assertion. */
const HARD_CLAIM_TYPES: readonly ClaimType[] = [
  'amount',
  'id',
  'date',
  'aggregate',
];

/** The claim-level shape a `via` predicate inspects — one per `ClaimVerdict`
 *  the real pipeline emitted. Kept minimal (status + claim type) so the pure
 *  layer stays value-free of the verifier package. */
export interface VerdictTag {
  status: ClaimVerdict['status'];
  claimType: ClaimType;
}

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
  /**
   * #639 v2 — frozen Odoo records the DeterministicChecker re-queries this
   * turn (via `FixtureOdooReader`). Present ⇒ hard claims can resolve
   * `verified`/`contradicted` instead of the v1 default `unverified`. Absent ⇒
   * `DeterministicChecker({})`, exactly as v1.
   */
  odoo?: OdooFixture;
  expected: {
    status: StatusName;
    /** #639 v2 — optional path assertion; see {@link ViaTag}. */
    via?: ViaTag;
  };
}

export interface EntryRun {
  status: StatusName;
  /** input+output tokens spent across every LLM call in this single run. */
  tokens: number;
  /**
   * #639 v2 — the per-claim verdicts the pipeline produced this run, projected
   * to {@link VerdictTag}. Optional: a `RunOnce` that predates the `via`
   * feature (or a scripted test stub) may omit it, in which case any `via`
   * assertion on the entry treats the run as not satisfying the path.
   */
  verdicts?: VerdictTag[];
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
  /** #639 v2 — the asserted path, when the entry declared one. */
  via?: ViaTag;
  /** #639 v2 — whether a decided-class sample reached the class via `via`.
   *  Undefined when the entry declared no `via`. */
  viaPass?: boolean;
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
  const expected = o['expected'] as
    | { status?: unknown; via?: unknown }
    | undefined;
  if (!expected || !isStatusName(expected.status)) {
    throw new Error(
      `${where}: "expected.status" must be one of ${STATUS_NAMES.join(' | ')}`,
    );
  }
  if (expected.via !== undefined && !isViaTag(expected.via)) {
    throw new Error(
      `${where}: "expected.via" must be one of ${VIA_TAGS.join(' | ')}`,
    );
  }
  const entry: GoldenEntry = {
    id,
    userMessage,
    answer,
    expected: {
      status: expected.status,
      ...(expected.via !== undefined ? { via: expected.via } : {}),
    },
  };
  if (typeof o['note'] === 'string') entry.note = o['note'];
  if (o['trace'] !== undefined) entry.trace = o['trace'] as GoldenTrace;
  if (o['evidence'] !== undefined) {
    entry.evidence = o['evidence'] as EvidenceSnippet[];
  }
  if (o['odoo'] !== undefined) {
    const odoo = o['odoo'] as { records?: unknown };
    if (!odoo || !Array.isArray(odoo.records)) {
      throw new Error(`${where}: "odoo.records" must be an array`);
    }
    entry.odoo = odoo as OdooFixture;
  }
  return entry;
}

function isViaTag(v: unknown): v is ViaTag {
  return typeof v === 'string' && (VIA_TAGS as readonly string[]).includes(v);
}

/**
 * Does any of this run's claim verdicts satisfy the required path? A
 * `deterministic-*` tag is satisfied only by a HARD-claim verdict of the
 * matching status — soft (judge) claims and synthetic
 * (`tool_postcondition`/`citation_missing`) claims are excluded by type, and
 * the trace-missing-call contradiction is excluded at the fixture level (those
 * entries declare a `query_odoo_*` call, so that pre-check never fires). Net:
 * a satisfied `deterministic-contradicted` means the checker itself refuted the
 * claim against the fixture records.
 */
function viaSatisfied(via: ViaTag, verdicts: VerdictTag[] | undefined): boolean {
  if (!verdicts) return false;
  const want = via === 'deterministic-verified' ? 'verified' : 'contradicted';
  return verdicts.some(
    (v) =>
      v.status === want &&
      (HARD_CLAIM_TYPES as readonly string[]).includes(v.claimType),
  );
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
  const via = entry.expected.via;
  const runs: EntryRun[] = [await runOnce(entry)];
  // Re-run (up to `maxRuns`) while the entry is not yet decided AND satisfied:
  // a first sample that is already green on BOTH status and path costs one
  // call; a miss on either buys the same majority-of-3 flake tolerance. Folding
  // `via` into the guard means the path assertion is flake-tolerant too — a
  // lone empty-extraction sample doesn't sink an otherwise-verified entry.
  while (runs.length < maxRuns && !decidedAndSatisfied(runs, entry.expected.status, via)) {
    runs.push(await runOnce(entry));
  }
  const statuses = runs.map((r) => r.status);
  // `majority` returns the sole sample unchanged for a one-element list, so it
  // doubles as the single-run case — no separate index into `statuses`.
  const decided = majority(statuses).winner;
  const statusPass = decided === entry.expected.status;
  // The path assertion is checked on the decided-class samples: at least one
  // sample that produced `decided` must have reached it through `via`.
  const viaPass =
    via === undefined
      ? undefined
      : runs.some((r) => r.status === decided && viaSatisfied(via, r.verdicts));
  return {
    id: entry.id,
    expected: entry.expected.status,
    runs: statuses,
    decided,
    pass: statusPass && viaPass !== false,
    tokens: runs.reduce((sum, r) => sum + r.tokens, 0),
    ...(via !== undefined ? { via, viaPass: viaPass ?? false } : {}),
  };
}

/** Would the samples so far pass? Used as the re-run stop condition, so the
 *  cost-aware "green first try = one call" property extends to `via`. */
function decidedAndSatisfied(
  runs: EntryRun[],
  expected: StatusName,
  via: ViaTag | undefined,
): boolean {
  const decided = majority(runs.map((r) => r.status)).winner;
  if (decided !== expected) return false;
  if (via === undefined) return true;
  return runs.some((r) => r.status === decided && viaSatisfied(via, r.verdicts));
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
    const via = r.via ? ` via=${r.via}(${r.viaPass ? 'ok' : 'MISS'})` : '';
    lines.push(
      `${mark}  ${r.id.padEnd(28)} expected=${r.expected} decided=${r.decided} ` +
        `runs=[${r.runs.join(',')}] tokens=${r.tokens}${via}`,
    );
  }
  lines.push('');
  lines.push(
    `golden-eval: ${results.length - failed.length}/${results.length} passed, ` +
      `${failed.length} regressed, ${totalTokens} tokens total`,
  );
  return lines.join('\n');
}
