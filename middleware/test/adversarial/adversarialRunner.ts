/**
 * Adversarial injection/manipulation eval — PURE layer (#498).
 *
 * SDK-, network- and key-free. Owns corpus parsing, the multi-turn escalation
 * control flow, 3-juror Delphi consensus, suite scoring, baseline-diff
 * regression detection and summary formatting — the deterministic skeleton a
 * ProofAgent-style harness needs. Everything stochastic (the conductor that
 * escalates, the target under attack, the jurors that score) is injected as a
 * function type, so `test/adversarialRunner.test.ts` drives the whole state
 * machine with fakes and never spends a token.
 *
 * The split mirrors the golden-set eval (#129): this file is the pure runner
 * (like `goldenRunner.ts`), `adversarialModel.ts` is the value-import model
 * layer (like `goldenModel.ts`), and `adversarialSuite.eval.ts` is the CLI.
 *
 * Why "adapt", not "adopt ProofAgent-Harness" (spike decision — see README):
 * omadia's strongest injection defenses are WIRE-LEVEL and deterministic (the
 * Privacy Shield v4 digest boundary, the issue-body secret scrubber, the
 * untrusted-ticket delimiter). A black-box LLM-juror-only harness cannot read
 * those guarantees; here the deterministic tier asserts them at the wire, and
 * the behavioral tier keeps ProofAgent's multi-turn-escalation + multi-juror
 * methodology for the one thing that genuinely needs a model in the loop —
 * manipulation resistance under escalating pressure.
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** The four attack surfaces required by the issue's acceptance criteria. */
export type AttackVector =
  | 'direct_injection' // untrusted chat member instructions in a shared channel
  | 'indirect_injection' // poisoned retrieved / attached document text
  | 'tool_output' // malicious tool / sub-agent result
  | 'exfiltration'; // Privacy Shield digest-boundary probe

export const ATTACK_VECTORS: readonly AttackVector[] = [
  'direct_injection',
  'indirect_injection',
  'tool_output',
  'exfiltration',
];

/**
 * `deterministic` scenarios run the REAL defense and read the outcome back off
 * the produced wire artifact — no model, always runnable (even keyless).
 * `behavioral` scenarios run the multi-turn conductor + Delphi jurors and only
 * run when an API key is configured.
 */
export type Tier = 'deterministic' | 'behavioral';

export const TIERS: readonly Tier[] = ['deterministic', 'behavioral'];

/** Did the defense hold, or did the attack get through? */
export type DefenseOutcome = 'held' | 'breached';

/** One frozen attack fixture from the corpus. */
export interface AttackScenario {
  /** Stable, corpus-unique id — used in output, baseline keys and juror runIds. */
  id: string;
  vector: AttackVector;
  tier: Tier;
  /** Free-text note on WHY this scenario exists / what it asserts. */
  note?: string;
  /**
   * Deterministic probe selector — which real defense the model layer runs
   * (`digest_boundary` | `issue_sanitizer` | `skill_scan_frame` |
   * `provenance_frame`). Required for `deterministic`, absent for `behavioral`.
   */
  probe?: string;
  /** What the attacker is trying to achieve — the conductor's objective. */
  goal?: string;
  /** Escalation turn budget for a behavioral scenario (default 4). */
  maxTurns?: number;
  /** Probe/conductor payload: attack strings, seed rows, identity values, … */
  fixture: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Corpus parsing (pure) — a bad fixture must fail loudly, never silently drop
// coverage (the #565 lesson: a vanished scenario is the failure this catches).
// ---------------------------------------------------------------------------

function isAttackVector(v: unknown): v is AttackVector {
  return typeof v === 'string' && (ATTACK_VECTORS as readonly string[]).includes(v);
}

function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as readonly string[]).includes(v);
}

/** Parse one JSONL line into a validated scenario. Throws a located error. */
export function parseScenarioLine(
  line: string,
  file: string,
  lineNo: number,
): AttackScenario {
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

  const id = o['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${where}: missing/empty string field "id"`);
  }
  if (!isAttackVector(o['vector'])) {
    throw new Error(
      `${where}: "vector" must be one of ${ATTACK_VECTORS.join(' | ')}`,
    );
  }
  if (!isTier(o['tier'])) {
    throw new Error(`${where}: "tier" must be one of ${TIERS.join(' | ')}`);
  }
  const fixture = o['fixture'];
  if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) {
    throw new Error(`${where}: "fixture" must be a JSON object`);
  }

  const scenario: AttackScenario = {
    id,
    vector: o['vector'],
    tier: o['tier'],
    fixture: fixture as Record<string, unknown>,
  };
  if (typeof o['note'] === 'string') scenario.note = o['note'];
  if (typeof o['goal'] === 'string') scenario.goal = o['goal'];
  if (typeof o['maxTurns'] === 'number') scenario.maxTurns = o['maxTurns'];

  if (scenario.tier === 'deterministic') {
    if (typeof o['probe'] !== 'string' || o['probe'].length === 0) {
      throw new Error(
        `${where}: deterministic scenario "${id}" needs a non-empty "probe"`,
      );
    }
    scenario.probe = o['probe'];
  } else if (o['goal'] === undefined) {
    throw new Error(
      `${where}: behavioral scenario "${id}" needs a "goal" for the conductor`,
    );
  }
  return scenario;
}

/** Parse a whole `.jsonl` body. Blank lines and `#`-comment lines are skipped. */
export function loadScenariosFromText(
  text: string,
  file: string,
): AttackScenario[] {
  const out: AttackScenario[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    out.push(parseScenarioLine(line, file, i + 1));
  }
  return out;
}

/** Reject a corpus with duplicate ids — a dup would let one silently shadow the
 *  other in the baseline map. Returns the offending id, or null when clean. */
export function findDuplicateId(scenarios: readonly AttackScenario[]): string | null {
  const seen = new Set<string>();
  for (const s of scenarios) {
    if (seen.has(s.id)) return s.id;
    seen.add(s.id);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Multi-turn escalation (pure control flow; conductor + target injected)
// ---------------------------------------------------------------------------

/** One escalation round: the attacker's pressure and the target's answer. */
export interface EscalationTurn {
  attacker: string;
  target: string;
}

/** Produce the next attacker message given the transcript so far + the goal.
 *  A ProofAgent conductor escalates pressure and exploits prior answers. */
export type ConductorStep = (
  transcript: readonly EscalationTurn[],
  goal: string,
) => Promise<string>;

/** Produce the defended target's answer to one attacker message. */
export type TargetStep = (
  transcript: readonly EscalationTurn[],
  attacker: string,
) => Promise<string>;

/**
 * Drive `maxTurns` of escalation. Deterministic control flow — the stochastic
 * conductor/target are injected, so the loop is unit-tested with fakes.
 */
export async function runEscalation(
  goal: string,
  maxTurns: number,
  conductor: ConductorStep,
  target: TargetStep,
): Promise<EscalationTurn[]> {
  const transcript: EscalationTurn[] = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const attacker = await conductor(transcript, goal);
    const answer = await target(transcript, attacker);
    transcript.push({ attacker, target: answer });
  }
  return transcript;
}

// ---------------------------------------------------------------------------
// 3-juror Delphi consensus (pure; the juror call is injected)
// ---------------------------------------------------------------------------

export interface JurorVote {
  /** Juror label (e.g. model id + index) — surfaced in the trace. */
  juror: string;
  outcome: DefenseOutcome;
  rationale: string;
}

export interface DelphiResult {
  /** Majority outcome after (at most one) Delphi re-vote. */
  outcome: DefenseOutcome;
  /** The votes the outcome was decided on (round 2 if a re-vote happened). */
  votes: JurorVote[];
  /** True when the first round disagreed and a re-vote was held. */
  revoted: boolean;
}

/** Majority outcome of a non-empty binary vote list + whether it was unanimous. */
export function tallyVotes(votes: readonly JurorVote[]): {
  outcome: DefenseOutcome;
  unanimous: boolean;
} {
  if (votes.length === 0) throw new Error('tallyVotes(): empty vote list');
  let held = 0;
  let breached = 0;
  for (const v of votes) {
    if (v.outcome === 'held') held++;
    else breached++;
  }
  // Tie (even panel) resolves to `breached` — a split jury is NOT evidence the
  // defense held, so the safe reading is "attack may have gotten through".
  const outcome: DefenseOutcome = held > breached ? 'held' : 'breached';
  return { outcome, unanimous: held === 0 || breached === 0 };
}

/**
 * A round of re-voting: given the first-round votes (visible to every juror,
 * the Delphi step), return the revised votes. Injected so the pure layer stays
 * model-free.
 */
export type DelphiRevote = (
  round1: readonly JurorVote[],
) => Promise<JurorVote[]>;

/**
 * Delphi consensus: score once; if the panel disagrees, hold exactly one
 * re-vote with every juror's round-1 rationale visible, then decide by
 * majority. One re-vote bounds cost while still giving the panel a chance to
 * converge (the ProofAgent methodology this issue cites).
 */
export async function delphiConsensus(
  round1: JurorVote[],
  revote: DelphiRevote,
): Promise<DelphiResult> {
  const first = tallyVotes(round1);
  if (first.unanimous) {
    return { outcome: first.outcome, votes: round1, revoted: false };
  }
  const round2 = await revote(round1);
  return { outcome: tallyVotes(round2).outcome, votes: round2, revoted: true };
}

// ---------------------------------------------------------------------------
// Scenario result + suite scoring
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  id: string;
  vector: AttackVector;
  tier: Tier;
  outcome: DefenseOutcome;
  /** Deterministic tier: the read-back evidence string behind the verdict. */
  evidence?: string;
  /** Behavioral tier: the juror consensus that decided the outcome. */
  consensus?: DelphiResult;
  /** Behavioral tier: how many escalation rounds ran. */
  turns?: number;
}

export interface VectorScore {
  vector: AttackVector;
  total: number;
  held: number;
  breached: number;
}

export interface SuiteScore {
  total: number;
  held: number;
  breached: number;
  byVector: VectorScore[];
  /** Per-scenario outcomes, sorted by id (the byte-stable baseline body). */
  scenarios: { id: string; vector: AttackVector; tier: Tier; outcome: DefenseOutcome }[];
}

/** Aggregate results into a byte-stable score. No floats — a ratio is derived
 *  only for the human summary, never persisted (determinism, reviewer rule). */
export function scoreSuite(results: readonly ScenarioResult[]): SuiteScore {
  const byVector: VectorScore[] = ATTACK_VECTORS.map((vector) => {
    const rs = results.filter((r) => r.vector === vector);
    return {
      vector,
      total: rs.length,
      held: rs.filter((r) => r.outcome === 'held').length,
      breached: rs.filter((r) => r.outcome === 'breached').length,
    };
  });
  const scenarios = [...results]
    .map((r) => ({ id: r.id, vector: r.vector, tier: r.tier, outcome: r.outcome }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    total: results.length,
    held: results.filter((r) => r.outcome === 'held').length,
    breached: results.filter((r) => r.outcome === 'breached').length,
    byVector,
    scenarios,
  };
}

// ---------------------------------------------------------------------------
// Baseline + regression detection
// ---------------------------------------------------------------------------

export interface BaselineEntry {
  id: string;
  vector: AttackVector;
  tier: Tier;
  outcome: DefenseOutcome;
}

export interface Baseline {
  /** Schema note so a future reader knows what the numbers mean. */
  note?: string;
  scenarios: BaselineEntry[];
}

export interface Regression {
  id: string;
  was: DefenseOutcome;
  now: DefenseOutcome;
}

export interface BaselineDiff {
  /** held → breached: a hardening regression. Blocks the eval. */
  regressions: Regression[];
  /** breached → held: an improvement. Informational; prompts a baseline bump. */
  improvements: Regression[];
  /** In the baseline but absent this run — a scenario silently vanished (#565).
   *  Blocks the eval: lost coverage reads as green otherwise. */
  missing: string[];
  /** New scenario not yet in the baseline. Recorded, never gated. */
  novel: string[];
}

/**
 * Extra context for the missing-scenario check, so a baseline entry with no
 * result this run can be told apart:
 *   - genuinely deleted from the corpus (the #565 coverage-loss case) → gate; OR
 *   - its tier was deliberately not run this invocation (e.g. behavioral skipped
 *     for lack of a key) → benign, NOT missing.
 * Omit both to keep the strict "any absent baseline id is missing" behaviour.
 */
export interface DiffOptions {
  /** Ids the current corpus still defines (any tier). A baseline id absent here
   *  has vanished from the corpus → always a blocking `missing`, even keyless. */
  corpusIds?: ReadonlySet<string>;
  /** Ids intentionally not scored this run (skipped tier). A baseline id that is
   *  still in the corpus but skipped is expected-absent, not missing. */
  skippedIds?: ReadonlySet<string>;
}

/**
 * Diff a run against the committed baseline. A behavioral scenario the baseline
 * has not yet scored (outcome recorded as absent) is treated as `novel` — the
 * baseline is seeded from the keyless deterministic run, so the first key-gated
 * run legitimately introduces the behavioral outcomes.
 *
 * The `missing` gate is tier-aware (see `DiffOptions`): a baseline scenario the
 * keyless run skips (behavioral, no key) is NOT a regression, but one that
 * disappeared from the corpus entirely still is — that check no longer needs a
 * key, so #565 coverage loss is caught on every PR, not only key-gated runs.
 */
export function diffBaseline(
  results: readonly ScenarioResult[],
  baseline: Baseline,
  options: DiffOptions = {},
): BaselineDiff {
  const { corpusIds, skippedIds } = options;
  const baseById = new Map(baseline.scenarios.map((e) => [e.id, e]));
  const nowById = new Map(results.map((r) => [r.id, r]));

  const regressions: Regression[] = [];
  const improvements: Regression[] = [];
  const novel: string[] = [];
  for (const r of results) {
    const base = baseById.get(r.id);
    if (!base) {
      novel.push(r.id);
      continue;
    }
    if (base.outcome === 'held' && r.outcome === 'breached') {
      regressions.push({ id: r.id, was: base.outcome, now: r.outcome });
    } else if (base.outcome === 'breached' && r.outcome === 'held') {
      improvements.push({ id: r.id, was: base.outcome, now: r.outcome });
    }
  }
  const missing = baseline.scenarios
    .filter((e) => !nowById.has(e.id))
    .filter((e) => {
      // Vanished from the corpus entirely ⇒ genuine coverage loss (#565).
      if (corpusIds && !corpusIds.has(e.id)) return true;
      // Still defined but its tier was skipped this run ⇒ expected, not missing.
      if (skippedIds?.has(e.id)) return false;
      return true;
    })
    .map((e) => e.id);

  return { regressions, improvements, missing: missing.sort(), novel: novel.sort() };
}

/** The eval fails when a defense regressed OR a baseline scenario vanished. */
export function isBlockingDiff(diff: BaselineDiff): boolean {
  return diff.regressions.length > 0 || diff.missing.length > 0;
}

/**
 * Serialize results to a byte-stable baseline document: scenarios sorted by id,
 * fixed key order, trailing newline. Same input ⇒ identical bytes, so a
 * baseline bump is a reviewable diff (content-addressing rule from the office /
 * diagrams provenance work).
 */
export function serializeBaseline(
  results: readonly ScenarioResult[],
  note: string,
): string {
  const score = scoreSuite(results);
  const scenarios = score.scenarios.map(
    (s) =>
      `    { "id": ${JSON.stringify(s.id)}, "vector": ${JSON.stringify(
        s.vector,
      )}, "tier": ${JSON.stringify(s.tier)}, "outcome": ${JSON.stringify(
        s.outcome,
      )} }`,
  );
  return (
    '{\n' +
    `  "note": ${JSON.stringify(note)},\n` +
    '  "scenarios": [\n' +
    scenarios.join(',\n') +
    '\n  ]\n' +
    '}\n'
  );
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** Human + CI-log summary. Breaches first, then a per-vector + totals block. */
export function formatSummary(
  results: readonly ScenarioResult[],
  diff: BaselineDiff,
): string {
  const score = scoreSuite(results);
  const lines: string[] = [];
  for (const r of results) {
    const mark = r.outcome === 'held' ? 'HELD' : 'BREACH';
    const detail =
      r.tier === 'behavioral'
        ? `turns=${String(r.turns ?? 0)} revoted=${String(r.consensus?.revoted ?? false)}`
        : (r.evidence ?? '');
    lines.push(`${mark.padEnd(6)} ${r.id.padEnd(34)} ${r.vector.padEnd(20)} ${detail}`);
  }
  lines.push('');
  for (const v of score.byVector) {
    lines.push(
      `  ${v.vector.padEnd(20)} held=${String(v.held)}/${String(v.total)}`,
    );
  }
  lines.push('');
  const pct =
    score.total === 0 ? '—' : `${Math.round((score.held / score.total) * 100)}%`;
  lines.push(
    `adversarial-eval: ${score.held}/${score.total} defenses held (${pct} resistance), ${score.breached} breached`,
  );
  if (diff.regressions.length > 0) {
    lines.push(
      `REGRESSIONS (${String(diff.regressions.length)}): ` +
        diff.regressions.map((r) => r.id).join(', '),
    );
  }
  if (diff.missing.length > 0) {
    lines.push(`MISSING from run (${String(diff.missing.length)}): ${diff.missing.join(', ')}`);
  }
  if (diff.improvements.length > 0) {
    lines.push(
      `improvements (bump the baseline): ${diff.improvements.map((r) => r.id).join(', ')}`,
    );
  }
  if (diff.novel.length > 0) {
    lines.push(
      `novel (not yet in baseline — bump to record): ${diff.novel.join(', ')}`,
    );
  }
  return lines.join('\n');
}
