import type {
  DecisionModelService,
  DecisionOption,
  DecisionQuestion,
} from '@omadia/plugin-api';
import { normalizeDecisionBatch } from '@omadia/plugin-api';

import type { SoftClaim, VerifierPrivacy } from './claimTypes.js';
import type { EvidenceSnippet } from './evidenceJudge.js';
import {
  citedNodeId,
  judgeRequestParts,
  projectRequestParts,
  type JudgeRequestParts,
} from './judgeRequest.js';

/**
 * `decisionModel@1` path of the evidence judge: every judged claim of a turn
 * in ONE batch. Per claim two closed questions — the verdict
 * (`verified | contradicted | unverifiable`) and the evidence it rests on
 * (one option per snippet the request printed, plus `none`). The request is
 * built from the same parts the LLM judge sends, projected through the same
 * surrogate map behind a Privacy Shield, so nothing leaves that the LLM path
 * would not send; a cited option resolves server-side to the snippet printed
 * under it, never to anything else.
 *
 * This module only asks and maps the answers back. Thresholds, the
 * record-binding rule and the LLM confirmation of a contradiction live in
 * `EvidenceJudge.checkAll`, which owns every verdict.
 */

export type DecisionVerdict = 'verified' | 'contradicted' | 'unverifiable';

export interface DecisionClaimInput {
  readonly claim: SoftClaim;
  readonly evidence: readonly EvidenceSnippet[];
}

export interface DecidedClaim {
  readonly verdict: DecisionVerdict;
  readonly confidence: number;
  /** Node id of the cited snippet; absent when the model chose `none`. */
  readonly citedNodeId?: string;
  /** The request carried placeholders (see `projectRequestParts`). */
  readonly projected: boolean;
}

export interface DecideClaimsResult {
  /** Per input, in order: the decision, or undefined → the LLM judges it. */
  readonly decided: ReadonlyArray<DecidedClaim | undefined>;
  readonly ms: number;
}

const DECISION_TASK = 'verifier.evidence-judge';
const NONE_OPTION = 'none';
/** Per-snippet cap in the verdict question. */
const MAX_SNIPPET_CHARS = 1200;
/** Per-snippet cap in the evidence option descriptions (the verdict
 *  question already carries the full snippet). */
const MAX_OPTION_CHARS = 300;

const VERDICT_INSTRUCTION =
  'Judge whether the CLAIM is supported by the EVIDENCE snippets below. You do not see the answer the claim came from. ' +
  'verified: the evidence directly states the claim. contradicted: the evidence explicitly states something incompatible with the claim. ' +
  'unverifiable: the evidence is silent, ambiguous or only tangentially related — the default when unsure. ' +
  'Do not reward plausibility. CONTEXT only resolves what the claim refers to; never judge on a fact found only in CONTEXT. ' +
  'When RELATED names a record id, a snippet about another record of that model is a different entity.';

const VERDICT_OPTIONS: readonly DecisionOption[] = [
  { id: 'verified', description: 'The evidence directly states the claim.' },
  {
    id: 'contradicted',
    description: 'The evidence explicitly states something incompatible with the claim.',
  },
  {
    id: 'unverifiable',
    description: 'The evidence is silent, ambiguous or only tangentially related.',
  },
];

const EVIDENCE_INSTRUCTION =
  'Which evidence snippet directly confirms or explicitly contradicts the CLAIM? Choose none when no snippet does.';

/**
 * Asks the decision model about every claim in one batch. Returns undefined
 * when the call itself fails (the caller then judges every claim on the LLM);
 * a claim whose request could not be projected or whose answers are missing
 * comes back as undefined in `decided`.
 */
export async function decideClaims(
  service: DecisionModelService & Required<Pick<DecisionModelService, 'decideAll'>>,
  inputs: readonly DecisionClaimInput[],
  privacy: VerifierPrivacy | undefined,
): Promise<DecideClaimsResult | undefined> {
  const prepared = await Promise.all(inputs.map((input) => prepare(input, privacy)));
  const questions: Record<string, DecisionQuestion> = {};
  const claimLines: string[] = [];
  prepared.forEach((p, i) => {
    if (!p) return;
    questions[verdictKey(i)] = {
      kind: 'choice',
      instruction: `${VERDICT_INSTRUCTION}\n\n${claimBlock(p.parts, p.claimType)}`,
      options: VERDICT_OPTIONS,
    };
    questions[evidenceKey(i)] = {
      kind: 'choice',
      instruction: `${EVIDENCE_INSTRUCTION}\nCLAIM: ${p.parts.claimText}`,
      options: evidenceOptions(p.parts),
    };
    claimLines.push(`${String(i + 1)}. ${p.parts.claimText}`);
  });
  const startedAt = Date.now();
  if (claimLines.length === 0) {
    return { decided: prepared.map(() => undefined), ms: 0 };
  }
  let answers;
  try {
    const raw = await service.decideAll({
      task: DECISION_TASK,
      input: `Claims to check:\n${claimLines.join('\n')}`,
      questions,
    });
    // Re-validated: a malformed answer must never pass as a decision.
    answers = normalizeDecisionBatch({ questions }, raw).answers;
  } catch {
    return undefined;
  }
  const ms = Date.now() - startedAt;
  const decided = prepared.map((p, i): DecidedClaim | undefined => {
    if (!p) return undefined;
    const verdict = answers[verdictKey(i)];
    const cited = answers[evidenceKey(i)];
    if (verdict?.kind !== 'choice' || cited?.kind !== 'choice') return undefined;
    const nodeId = resolveCited(cited.choice, p.parts, inputs[i]?.evidence ?? []);
    return {
      verdict: verdict.choice as DecisionVerdict,
      confidence: verdict.confidence,
      ...(nodeId !== undefined ? { citedNodeId: nodeId } : {}),
      projected: p.projected,
    };
  });
  return { decided, ms };
}

interface Prepared {
  readonly parts: JudgeRequestParts;
  readonly projected: boolean;
  readonly claimType: string;
}

async function prepare(
  input: DecisionClaimInput,
  privacy: VerifierPrivacy | undefined,
): Promise<Prepared | undefined> {
  const real = judgeRequestParts(input.claim, input.evidence, privacy !== undefined);
  if (real.evidence.length === 0) return undefined;
  if (!privacy) return { parts: real, projected: false, claimType: input.claim.type };
  try {
    const result = await projectRequestParts(real, input.evidence, privacy);
    // The refs stay the real request's refs: `citedNodeId` resolves on them.
    return { parts: result.parts, projected: result.projected, claimType: input.claim.type };
  } catch {
    // Blocked projection: nothing is sent; the LLM path reports it as
    // check_failed exactly as it does today.
    return undefined;
  }
}

function verdictKey(i: number): string {
  return `c${String(i)}_verdict`;
}

function evidenceKey(i: number): string {
  return `c${String(i)}_evidence`;
}

function optionId(idx: number): string {
  return `e${String(idx + 1)}`;
}

function evidenceOptions(parts: JudgeRequestParts): DecisionOption[] {
  return [
    ...parts.evidence.map((e, idx) => ({
      id: optionId(idx),
      description: `Evidence #${String(idx + 1)} [source=${e.source}${e.title ? `, title=${e.title}` : ''}]: ${truncate(e.content, MAX_OPTION_CHARS)}`,
    })),
    { id: NONE_OPTION, description: 'No snippet confirms or contradicts the claim.' },
  ];
}

function claimBlock(parts: JudgeRequestParts, claimType: string): string {
  const evidence = parts.evidence
    .map(
      (e, idx) =>
        `Evidence #${String(idx + 1)} [source=${e.source}${e.title ? `, title=${e.title}` : ''}]:\n${truncate(e.content, MAX_SNIPPET_CHARS)}`,
    )
    .join('\n\n');
  const context = parts.context ? `\nCONTEXT: ${parts.context}` : '';
  return `CLAIM: ${parts.claimText}${context}\nCLAIM TYPE: ${claimType}\nRELATED: ${parts.related || '(none)'}\n\nEVIDENCE:\n${evidence}`;
}

/** Option id → the node id of the snippet printed under it, or undefined
 *  for `none` (or anything else). */
function resolveCited(
  choice: string,
  parts: JudgeRequestParts,
  evidence: readonly EvidenceSnippet[],
): string | undefined {
  const idx = parts.evidence.findIndex((_, i) => optionId(i) === choice);
  if (idx === -1) return undefined;
  return citedNodeId(parts.evidence[idx]?.ref, parts, evidence);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
