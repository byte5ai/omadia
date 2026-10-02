import type {
  Claim,
  ClaimExtraction,
  ClaimVerdict,
  HardClaim,
  NonEmptyClaimVerdicts,
  SoftClaim,
  VerifierInput,
  VerifierPrivacy,
  VerifierSkipReason,
  VerifierVerdict,
} from './claimTypes.js';
import { hasOdooRecordAnchor, isHardClaim, isSoftClaim } from './claimTypes.js';
import type { ClaimExtractor } from './claimExtractor.js';
import type { DeterministicChecker } from './deterministicChecker.js';
import type { EvidenceJudge } from './evidenceJudge.js';
import { coverageVerdicts, readExtraction, skipReason } from './extractionCoverage.js';
import { detectFailureReplay } from './failureReplayDetector.js';
import { shouldTriggerVerifier } from './triggerRouter.js';

/**
 * End-to-end verifier pipeline.
 *
 *   answer → triggerRouter → claimExtractor → classify
 *                            ├─► DeterministicChecker (hard claims, parallel)
 *                            ├─► DeterministicChecker.checkRecordExists
 *                            │     (soft claims anchored on an Odoo record —
 *                            │      #129: a missing record blocks before any
 *                            │      judge call, whatever the extractor typed)
 *                            └─► EvidenceJudge        (remaining soft claims)
 *                            → aggregate → VerifierVerdict
 *
 * Never throws, and the verdict is bound to evidence:
 *   - `approved` ⇒ the extraction reported no coverage gap, and every
 *     extracted claim was checked and is `verified`, at least one (the claim
 *     list is typed non-empty). No coverage gap means: the model read the
 *     whole answer, its claim list stayed below the request limit, and every
 *     claim it returned, across all its `record_claims` calls, quotes the
 *     answer in full and is short enough to check (`MAX_CLAIM_CHARS`) — no
 *     claim is shortened to fit. A claim the model leaves out of a list below
 *     that limit is beyond what any check here can see.
 *   - A claim no checker accepts, one beyond the per-answer cap, and each
 *     part of the answer the extraction did not cover (text beyond its
 *     window, a claim list cut at its request limit, or claims that are not
 *     in the answer or too long to check — a `coverage_gap` entry) stay in
 *     the verdict as `unverified` / `not_checked`: an answer checked only in
 *     part is `approved_with_disclaimer`, never `approved`.
 *   - `skipped` — the pipeline ran but had nothing it could check: no trigger
 *     signal, no extracted claim, or no claim any checker accepts; reason
 *     `incomplete_coverage` when the extraction did not cover the whole
 *     answer either.
 *   - `unavailable` — the extraction failed or did not finish (see
 *     `ClaimExtractor.extract`), so nothing was checked.
 * A failure never stops the user from seeing the reply, but it is never
 * reported as a pass either. Contradictions found without extraction
 * (failure replay, tool postconditions, missing citations) still block on
 * every one of these paths.
 */

export interface VerifierPipelineOptions {
  extractor: ClaimExtractor;
  deterministic: DeterministicChecker;
  judge: EvidenceJudge;
  /**
   * Most claims handed to a checker per answer — each one is a re-query or a
   * judge call. Claims beyond it stay in the verdict as `unverified` /
   * `not_checked`, so the cap bounds cost without hiding part of the answer.
   * Give the `ClaimExtractor` the same value: it asks the model for one claim
   * more and reports a list cut at that limit as a coverage gap. Default 20.
   */
  maxClaims?: number;
  log?: (msg: string) => void;
}

const DEFAULT_MAX_CLAIMS = 20;

export class VerifierPipeline {
  private readonly extractor: ClaimExtractor;
  private readonly deterministic: DeterministicChecker;
  private readonly judge: EvidenceJudge;
  private readonly maxClaims: number;
  private readonly log: (msg: string) => void;

  constructor(opts: VerifierPipelineOptions) {
    this.extractor = opts.extractor;
    this.deterministic = opts.deterministic;
    this.judge = opts.judge;
    this.maxClaims =
      typeof opts.maxClaims === 'number' && Number.isFinite(opts.maxClaims)
        ? Math.max(0, Math.floor(opts.maxClaims))
        : DEFAULT_MAX_CLAIMS;
    this.log =
      opts.log ??
      ((msg: string): void => {
        console.error(msg);
      });
  }

  /** Run the full verifier pipeline. Always resolves. */
  async verify(input: VerifierInput): Promise<VerifierVerdict> {
    const started = Date.now();

    // Failure-replay detection runs independent of the trigger router.
    // The classic case: a turn with no numeric content but the answer
    // says "ich sehe keinen Anhang" while the [attachments-info] block
    // is literally present in the user message. The trigger router has
    // no reason to fire for such a turn, but we still need to catch the
    // contradiction.
    const replayVerdicts = detectFailureReplay(input);

    // #130 — postcondition violations the bridgeTool detected on tool
    // returns (output Zod schema mismatch). Same shape as replayVerdicts:
    // synthetic contradicted verdicts that don't need answer extraction.
    // The presence of any of these flips the aggregate to `blocked` and
    // drives the existing correctionPrompt retry loop.
    const postconditionVerdicts = buildPostconditionVerdicts(input);

    // #131 — turn fetched knowledge-graph evidence but the answer carries
    // no `[ref:nodeId]` citations. Synthetic contradicted verdict, same
    // retry path. Skipped when `knowledgeGraphToolsCalled` is undefined
    // (no trace evidence — e.g. dev CLI) or false (turn didn't touch the
    // graph at all, so citations are irrelevant).
    const citationVerdicts = buildCitationMissingVerdicts(input);

    const synthetic = [
      ...replayVerdicts,
      ...postconditionVerdicts,
      ...citationVerdicts,
    ];

    const trigger = shouldTriggerVerifier(input.answer);
    if (!trigger.shouldVerify) {
      // Only the synthetic (no-extraction-needed) verdicts matter here.
      return aggregate(synthetic, started, 'no_trigger');
    }

    // The privacy view reaches every stage that sends text to a model; the
    // deterministic re-query below stays on the real values, server-side.
    const privacy = input.privacy;
    let extraction: ClaimExtraction;
    try {
      extraction = readExtraction(
        await this.extractor.extract({
          userMessage: input.userMessage,
          answer: input.answer,
          ...(privacy ? { privacy } : {}),
        }),
      );
    } catch (err) {
      this.log(`[verifier/pipeline] extractor FAIL: ${errMsg(err)}`);
      // Synthetic contradictions need no extraction and still block. Without
      // one, nothing was checked: the verifier could not run. The reason is a
      // code — the message stays in the log line above.
      return isNonEmpty(synthetic)
        ? aggregateChecked(synthetic, started)
        : {
            status: 'unavailable',
            reason: 'extractor_error',
            claims: [],
            latencyMs: Date.now() - started,
          };
    }

    // What the extraction did not cover stays in the verdict as not checked,
    // so the answer is at most partly verified (see `extractionCoverage.ts`).
    const { claims, gaps } = extraction;
    const coverage = coverageVerdicts(gaps);
    if (gaps.length > 0) {
      this.log(
        `[verifier/pipeline] extraction did not cover the whole answer (${gaps.join(',')})`,
      );
    }

    if (claims.length === 0) {
      this.log(
        `[verifier/pipeline] no claims extracted (trigger=${trigger.reasons.join(',')})`,
      );
      return aggregate(
        synthetic.length > 0 ? [...synthetic, ...coverage] : [],
        started,
        skipReason('no_claims', coverage),
      );
    }

    const { hard, soft, notChecked } = classify(claims, this.maxClaims);
    if (notChecked.length > 0) {
      this.log(
        `[verifier/pipeline] ${String(notChecked.length)} claim(s) not checked (no checker accepts them, or over the cap of ${String(this.maxClaims)})`,
      );
    }

    // Pre-check: any hard claim that needs Odoo re-query but whose turn
    // never called a `query_odoo_*` tool is a **replay / hallucination**.
    // We fail it directly as `contradicted` — no need to even ask the
    // deterministic checker; the missing tool call IS the proof.
    const traceVerdicts: ClaimVerdict[] = [];
    const hardToActuallyCheck: HardClaim[] = [];
    for (const claim of hard) {
      const replayVerdict = traceMissingCallVerdict(
        claim,
        input.domainToolsCalled,
      );
      if (replayVerdict) {
        traceVerdicts.push(replayVerdict);
      } else {
        hardToActuallyCheck.push(claim);
      }
    }

    // Parallelise hard + soft checks. Each branch is fault-tolerant on its
    // own — we never need to wait on one to start the other.
    const [hardVerdicts, softVerdicts] = await Promise.all([
      this.deterministic.checkAll(hardToActuallyCheck),
      this.checkSoftClaims(soft, hard, privacy),
    ]);

    const checked: ClaimVerdict[] = [
      ...synthetic,
      ...traceVerdicts,
      ...hardVerdicts,
      ...softVerdicts,
    ];
    // Claims no checker took, and the coverage gaps, stay in the verdict as
    // `unverified` / `not_checked`, so an answer checked only in part is never
    // `approved`. When nothing was checked at all — no extracted claim fits a
    // checker and no synthetic contradiction exists — the verdict is `skipped`.
    return aggregate(
      checked.length > 0 ? [...checked, ...notChecked, ...coverage] : [],
      started,
      skipReason('no_checkable_claims', coverage),
    );
  }

  /**
   * #129 — qualitative claims anchored on an Odoo record get a deterministic
   * existence check first. A record that does not exist is a contradiction
   * no judge can talk away, so those claims never reach the judge; claims
   * whose record exists (or could not be checked — reader error, unknown
   * model) go to the judge unchanged (fail-open on the soft path).
   *
   * Anchors already covered by a hard claim in the same turn are skipped:
   * the extractor is told to emit the `id` claim alongside the qualitative
   * one, and the hard path (incl. the context-replay guard, which does not
   * run on soft claims) already produces the verdict for that record — a
   * second re-query would only duplicate the contradiction.
   */
  private async checkSoftClaims(
    soft: SoftClaim[],
    hard: readonly HardClaim[],
    privacy: VerifierPrivacy | undefined,
  ): Promise<ClaimVerdict[]> {
    const coveredByHard = new Set(hard.map(anchorKey).filter(Boolean));
    const anchored = soft.filter(
      (c) => hasOdooRecordAnchor(c) && !coveredByHard.has(anchorKey(c)),
    );
    if (anchored.length === 0) return this.judge.checkAll(soft, privacy);

    const existence = await Promise.all(
      anchored.map((c) => this.deterministic.checkRecordExists(c)),
    );
    const contradicted = existence.filter((v) => v.status === 'contradicted');
    const blockedIds = new Set(contradicted.map((v) => v.claim.id));
    if (blockedIds.size > 0) {
      this.log(
        `[verifier/pipeline] anchored soft claim(s) refuted by record re-query: ${[...blockedIds].join(',')}`,
      );
    }
    const forJudge = soft.filter((c) => !blockedIds.has(c.id));
    const judged = await this.judge.checkAll(forJudge, privacy);
    return [...contradicted, ...judged];
  }
}

/**
 * #131 — turn fetched knowledge-graph evidence but the answer carries no
 * `[ref:nodeId]` citations. Same shape as the postcondition synthesiser:
 * skip when no trace evidence, no KG calls, or citations are present;
 * otherwise emit one contradicted ClaimVerdict that flips the aggregate
 * to blocked and drives the correctionPrompt retry.
 *
 * Detector is a flat regex over the answer text — node-id-shape is loose
 * on purpose so plugins that mint their own node-ids (Confluence /
 * Odoo prefixes) don't need to update this file.
 */
const CITATION_MARKER_REGEX = /\[ref:[\w-]+\]/i;

function buildCitationMissingVerdicts(input: VerifierInput): ClaimVerdict[] {
  if (input.knowledgeGraphToolsCalled !== true) return [];
  if (CITATION_MARKER_REGEX.test(input.answer)) return [];
  return [
    {
      status: 'contradicted',
      claim: {
        id: 'c_citation_missing',
        text: 'Answer pulled knowledge-graph evidence but contains no [ref:nodeId] citations.',
        type: 'citation_missing',
        expectedSource: 'graph',
        relatedEntities: [],
      },
      truth: null,
      source: 'graph',
      detail:
        'Add `[ref:<nodeId>]` after every assertion grounded in the knowledge graph so the verifier can attribute the claim to a source.',
    },
  ];
}

/**
 * #130 — turn each postcondition violation reported on the runTrace into a
 * synthetic contradicted ClaimVerdict. The verifier never asks the extractor
 * about these (they don't live in the answer text) and the deterministic
 * checker never sees them either; they go straight into the aggregate.
 */
function buildPostconditionVerdicts(input: VerifierInput): ClaimVerdict[] {
  const violations = input.toolPostconditionViolations;
  if (!violations || violations.length === 0) return [];
  return violations.map(
    (v): ClaimVerdict => ({
      status: 'contradicted',
      claim: {
        id: `c_postcond_${v.callId}`,
        text: `Tool '${v.toolName}' returned a value that did not conform to its declared output schema.`,
        type: 'tool_postcondition',
        expectedSource: 'unknown',
        relatedEntities: [],
      },
      truth: { issues: v.issues },
      source: 'unknown',
      detail: v.issues.join('; '),
    }),
  );
}

// --- helpers --------------------------------------------------------------

/**
 * Which tool names count as "I actually looked at Odoo this turn".
 * Keep the list tight: `query_graph` alone is not enough — the graph is
 * a 6-hourly snapshot, not the source of truth for numbers.
 */
const ODOO_TOOL_PREFIXES: readonly string[] = [
  'query_odoo_',       // fach-agents: query_odoo_accounting, query_odoo_hr
  'odoo_execute',      // raw Odoo RPC (sub-agents + dev)
];

/**
 * If the claim needs Odoo and the turn made NO Odoo tool call, return a
 * contradicted verdict. Otherwise return undefined and let the regular
 * deterministic checker do its thing.
 *
 * `domainToolsCalled === undefined` means "no trace evidence available"
 * (e.g. dev CLI turn without sessionScope). In that case we skip the
 * cross-check — better a false negative than a false positive when we
 * genuinely don't know.
 */
function traceMissingCallVerdict(
  claim: HardClaim,
  domainToolsCalled: readonly string[] | undefined,
): ClaimVerdict | undefined {
  if (claim.expectedSource !== 'odoo') return undefined;
  if (!domainToolsCalled) return undefined;
  const hasOdooCall = domainToolsCalled.some((name) =>
    ODOO_TOOL_PREFIXES.some((p) => name.startsWith(p)),
  );
  if (hasOdooCall) return undefined;
  return {
    status: 'contradicted',
    claim,
    truth: null,
    source: 'odoo',
    detail:
      'Claim ohne Fach-Agent-Call im Turn — Antwort hat keine Live-Daten aus Odoo abgerufen (Kontext-Replay).',
  };
}

/** `model#id` / `model@ref` identity of a claim's Odoo anchor; '' when none. */
function anchorKey(claim: Claim): string {
  const ref = claim.odooRecord;
  if (!ref || claim.expectedSource !== 'odoo') return '';
  if (typeof ref.id === 'number') return `${ref.model}#${String(ref.id)}`;
  if (typeof ref.ref === 'string' && ref.ref.length > 0) return `${ref.model}@${ref.ref}`;
  return '';
}

/**
 * Route each claim to the checker that can verify it. At most `maxClaims`
 * claims reach a checker. Claims that fit no checker (e.g. an amount whose
 * source is unknown or Confluence — we won't invent a way to check them), and
 * checkable claims beyond the cap, come back as `unverified` / `not_checked`
 * verdicts: kept in the verdict rather than dropped, so they count against
 * the answer's coverage.
 */
function classify(
  claims: readonly Claim[],
  maxClaims: number,
): {
  hard: HardClaim[];
  soft: SoftClaim[];
  notChecked: ClaimVerdict[];
} {
  const hard: HardClaim[] = [];
  const soft: SoftClaim[] = [];
  const notChecked: ClaimVerdict[] = [];
  for (const c of claims) {
    if (!isHardClaim(c) && !isSoftClaim(c)) {
      notChecked.push(
        notCheckedVerdict(c, `no checker for a ${c.type} claim from ${c.expectedSource}`),
      );
    } else if (hard.length + soft.length >= maxClaims) {
      notChecked.push(
        notCheckedVerdict(c, `over the cap of ${String(maxClaims)} checked claims per answer`),
      );
    } else if (isHardClaim(c)) {
      hard.push(c);
    } else if (isSoftClaim(c)) {
      soft.push(c);
    }
  }
  return { hard, soft, notChecked };
}

function notCheckedVerdict(claim: Claim, reason: string): ClaimVerdict {
  return { status: 'unverified', claim, reason, cause: 'not_checked' };
}

/**
 * Verdict for a list of claim verdicts. An empty list means nothing was
 * checked, which is `skipped` with the caller's reason — never `approved`.
 */
function aggregate(
  verdicts: ClaimVerdict[],
  startedAt: number,
  whenEmpty: VerifierSkipReason,
): VerifierVerdict {
  if (!isNonEmpty(verdicts)) {
    return {
      status: 'skipped',
      reason: whenEmpty,
      claims: [],
      latencyMs: Date.now() - startedAt,
    };
  }
  return aggregateChecked(verdicts, startedAt);
}

/** Verdict over at least one checked claim: blocked, disclaimer or approved. */
function aggregateChecked(
  verdicts: NonEmptyClaimVerdicts,
  startedAt: number,
): VerifierVerdict {
  const latencyMs = Date.now() - startedAt;
  const contradictions = verdicts.filter((v) => v.status === 'contradicted');
  const unverified = verdicts.filter((v) => v.status === 'unverified');

  if (contradictions.length > 0) {
    return {
      status: 'blocked',
      claims: verdicts,
      contradictions,
      latencyMs,
    };
  }
  if (unverified.length > 0) {
    return {
      status: 'approved_with_disclaimer',
      claims: verdicts,
      unverified,
      latencyMs,
    };
  }
  // Non-empty, nothing contradicted, nothing unverified: every claim verified.
  return { status: 'approved', claims: verdicts, latencyMs };
}

function isNonEmpty(verdicts: ClaimVerdict[]): verdicts is NonEmptyClaimVerdicts {
  return verdicts.length > 0;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
