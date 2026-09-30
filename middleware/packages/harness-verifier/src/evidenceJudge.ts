import type { LlmProvider, LlmResponse, ToolSpec } from '@omadia/llm-provider';
import { textMessage, toolCalls } from '@omadia/llm-provider';
import type { ClaimVerdict, SoftClaim } from './claimTypes.js';
import { MAX_CONTEXT_CHARS } from './claimExtractor.js';

/**
 * LLM-as-Judge for SoftClaims (names, qualitative statements) that can't
 * be checked deterministically. The judge sees ONLY the claim text plus a
 * bundle of evidence snippets — never the original orchestrator answer.
 * This is the key anti-anchoring guard: if the judge sees "the assistant
 * said X", it will find a way to agree.
 *
 * Output is forced via `tool_choice` into an enum verdict — no free prose,
 * no "probably verified". When the first call says `contradicted`, we
 * re-run the judge on the same inputs (with a fresh API call, no message
 * history reuse) and only keep the contradiction if both agree. Single
 * Haiku calls are cheap; the double-check prevents one unlucky flip from
 * blocking a correct answer.
 *
 * A cited `evidence_node_id` is checked deterministically against the
 * snippet set the judge was shown in that call; an id outside that set
 * demotes the verdict to `unverified`, on the recheck call as well.
 */

export interface EvidenceSnippet {
  nodeId: string;               // stable id the judge cites; citing any other id is rejected
  source: 'graph' | 'confluence' | 'odoo';
  content: string;              // <= ~2 kB per snippet
  title?: string;
}

/**
 * Fetches evidence for one claim. Implementations typically hit the
 * knowledge-graph (findEntities, getNeighbors, turn search) but any
 * read-only source is fair game.
 */
export interface EvidenceFetcher {
  fetch(claim: SoftClaim): Promise<EvidenceSnippet[]>;
}

export interface EvidenceJudgeOptions {
  /** Provider-agnostic LLM (Anthropic adapter today). Was `anthropic` before
   *  the provider-decoupling migration (phase 2). */
  llm: LlmProvider;
  fetcher: EvidenceFetcher;
  model?: string;
  maxTokens?: number;
  log?: (msg: string) => void;
}

const DEFAULTS = {
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 256,
};

const TOOL_NAME = 'record_verdict';

/** Reason for a verdict whose citation names no snippet the judge was shown. */
const UNKNOWN_EVIDENCE_REASON = 'evidence_node_id not in evidence set';

const toolSpec: ToolSpec = {
  name: TOOL_NAME,
  description:
    'Record your verdict on whether the claim is supported by the evidence. Use verified only when the evidence directly confirms the claim; unverified when the evidence is silent or ambiguous; contradicted ONLY when the evidence explicitly states something incompatible with the claim.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      verdict: {
        type: 'string',
        enum: ['verified', 'unverified', 'contradicted'],
      },
      evidence_node_id: {
        type: 'string',
        description:
          'The nodeId of the snippet that supports the verdict. REQUIRED when verdict is verified or contradicted.',
      },
      rationale: {
        type: 'string',
        description: 'One short sentence (<= 140 chars). No hedging.',
      },
    },
    required: ['verdict'],
  },
};

interface RawVerdict {
  verdict?: unknown;
  evidence_node_id?: unknown;
  rationale?: unknown;
}

type PrimitiveVerdict = 'verified' | 'unverified' | 'contradicted';

export class EvidenceJudge {
  private readonly llm: LlmProvider;
  private readonly fetcher: EvidenceFetcher;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly log: (msg: string) => void;

  constructor(opts: EvidenceJudgeOptions) {
    this.llm = opts.llm;
    this.fetcher = opts.fetcher;
    this.model = opts.model ?? DEFAULTS.model;
    this.maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
    this.log =
      opts.log ??
      ((msg: string): void => {
        console.error(msg);
      });
  }

  /** Check one SoftClaim. Always resolves; never throws. */
  async check(claim: SoftClaim): Promise<ClaimVerdict> {
    let evidence: EvidenceSnippet[];
    try {
      evidence = await this.fetcher.fetch(claim);
    } catch (err) {
      return unverified(claim, `evidence fetch failed: ${errMsg(err)}`);
    }
    if (evidence.length === 0) {
      return unverified(claim, 'no evidence available');
    }

    const first = await this.judgeOnce(claim, evidence);
    if (first === null) {
      return unverified(claim, 'judge returned no usable verdict');
    }
    if (first.verdict === 'unverified') {
      return unverified(claim, first.rationale ?? 'judge unverified');
    }

    // `parseVerdict` already demotes a citation outside the evidence set.
    // Resolving it again here keeps that rule if the parser ever changes,
    // before a recheck call is spent, and leaves the cited snippet as the
    // only place `source` and `truth` can come from — never the claim's own
    // `expectedSource`.
    const sourceSnippet =
      first.evidenceNodeId === undefined
        ? undefined
        : evidence.find((s) => s.nodeId === first.evidenceNodeId);
    if (!sourceSnippet) {
      return unverified(claim, UNKNOWN_EVIDENCE_REASON);
    }
    const source = sourceKind(sourceSnippet.source);

    if (first.verdict === 'verified') {
      return { status: 'verified', claim, source };
    }

    // Double-check on contradicted: one shaky Haiku flip should not block a
    // correct answer. We only confirm when the second call agrees; a recheck
    // citing an unknown id comes back `unverified` from the parser.
    const second = await this.judgeOnce(claim, evidence);
    if (second === null || second.verdict !== 'contradicted') {
      this.log(
        `[verifier/judge] contradiction not reproduced, downgrading to unverified claim=${claim.id}`,
      );
      return unverified(claim, 'judge contradiction not reproduced on recheck');
    }
    return {
      status: 'contradicted',
      claim,
      truth: first.rationale ?? sourceSnippet.content,
      source,
      ...(first.rationale ? { detail: first.rationale } : {}),
    };
  }

  async checkAll(claims: SoftClaim[]): Promise<ClaimVerdict[]> {
    return Promise.all(claims.map((c) => this.check(c)));
  }

  // ------------------------------------------------------------------

  private async judgeOnce(
    claim: SoftClaim,
    evidence: EvidenceSnippet[],
  ): Promise<{
    verdict: PrimitiveVerdict;
    evidenceNodeId?: string;
    rationale?: string;
  } | null> {
    const system = `You judge whether a single factual claim is supported by a bundle of evidence snippets. You do NOT see the original answer — only the claim and the evidence. This is deliberate: your job is to be an independent reviewer, not to rubber-stamp.

Rules:
- Output ONLY via the ${TOOL_NAME} tool.
- verdict = "verified": evidence directly states the claim.
- verdict = "unverified": evidence is silent, ambiguous, or only tangentially related. This is the DEFAULT when unsure.
- verdict = "contradicted": evidence explicitly says something incompatible with the claim. Requires evidence_node_id.
- Do NOT reward plausibility. If the evidence doesn't mention it, it's unverified — not verified.
- When a CONTEXT line is present it is the single sentence the claim was cut from. Use it only to resolve what the claim refers to (its subject, tense); judge the CLAIM as meant in that sentence. Never base "contradicted" or "verified" on a fact that appears only in CONTEXT and not in CLAIM.`;

    // The ids a verdict may cite: exactly the snippets printed below.
    const knownIds: ReadonlySet<string> = new Set(evidence.map((e) => e.nodeId));
    const evidenceBlock = evidence
      .map(
        (e, idx) =>
          `Evidence #${String(idx + 1)} [nodeId=${e.nodeId}, source=${e.source}${e.title ? `, title=${e.title}` : ''}]:\n${truncate(e.content, 1800)}`,
      )
      .join('\n\n');

    const context =
      claim.context && claim.context.trim().toLowerCase() !== claim.text.trim().toLowerCase()
        ? `\nCONTEXT: ${truncate(claim.context, MAX_CONTEXT_CHARS)}`
        : '';
    const user = `CLAIM: ${claim.text}${context}
CLAIM TYPE: ${claim.type}
RELATED: ${claim.relatedEntities.join(', ') || '(none)'}

EVIDENCE:
${evidenceBlock}`;

    let response: LlmResponse;
    try {
      response = await this.llm.complete({
        model: this.model,
        maxTokens: this.maxTokens,
        system,
        tools: [toolSpec],
        toolChoice: { type: 'tool', name: TOOL_NAME },
        messages: [textMessage('user', user)],
      });
    } catch (err) {
      this.log(`[verifier/judge] API FAIL: ${errMsg(err)}`);
      return null;
    }

    return parseVerdict(response, knownIds, (cited) => {
      // The cited id is model output: JSON-quoted so it stays on one line.
      this.log(
        `[verifier/judge] ${UNKNOWN_EVIDENCE_REASON}, downgrading to unverified claim=${claim.id} cited=${JSON.stringify(truncate(cited, 80))}`,
      );
    });
  }
}

// ---------------- helpers ----------------

function parseVerdict(
  response: LlmResponse,
  knownIds: ReadonlySet<string>,
  onUnknownId: (cited: string) => void,
): {
  verdict: PrimitiveVerdict;
  evidenceNodeId?: string;
  rationale?: string;
} | null {
  // Defensive: the contract guarantees `content` is an array, but keep the
  // historical never-throws behavior against malformed input.
  if (!Array.isArray(response.content)) return null;
  for (const call of toolCalls(response.content)) {
    if (call.name !== TOOL_NAME) continue;
    const raw = call.input as RawVerdict;
    const verdict = normaliseVerdict(raw.verdict);
    if (!verdict) return null;
    const nodeId =
      typeof raw.evidence_node_id === 'string'
        ? raw.evidence_node_id.trim()
        : '';
    const needsCitation = verdict === 'verified' || verdict === 'contradicted';
    // verified and contradicted MUST cite a node id — otherwise demote.
    if (needsCitation && !nodeId) {
      return { verdict: 'unverified', rationale: 'missing evidence_node_id' };
    }
    // ...and it must name a snippet this call was shown. Exact match on the
    // trimmed string: ids are opaque, so no case-folding or prefix matching.
    if (needsCitation && !knownIds.has(nodeId)) {
      onUnknownId(nodeId);
      return { verdict: 'unverified', rationale: UNKNOWN_EVIDENCE_REASON };
    }
    const rationale =
      typeof raw.rationale === 'string' ? raw.rationale.slice(0, 300) : '';
    const out: {
      verdict: PrimitiveVerdict;
      evidenceNodeId?: string;
      rationale?: string;
    } = { verdict };
    // An unknown id never leaves the parser, not even on `unverified`.
    if (nodeId && knownIds.has(nodeId)) out.evidenceNodeId = nodeId;
    if (rationale) out.rationale = rationale;
    return out;
  }
  return null;
}

function normaliseVerdict(v: unknown): PrimitiveVerdict | null {
  if (v === 'verified' || v === 'unverified' || v === 'contradicted') return v;
  return null;
}

function unverified(claim: SoftClaim, reason: string): ClaimVerdict {
  return { status: 'unverified', claim, reason };
}

/**
 * Maps the cited snippet's source onto the verdict's source. Only a snippet
 * can supply it (never the claim's expectation). `ClaimSource` also knows
 * 'confluence', but a confluence snippet is still recorded as 'graph' here —
 * a long-standing mapping, kept as is.
 */
function sourceKind(source: EvidenceSnippet['source']): 'odoo' | 'graph' {
  return source === 'odoo' ? 'odoo' : 'graph';
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
