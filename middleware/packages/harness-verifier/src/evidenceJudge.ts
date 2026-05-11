import type Anthropic from '@anthropic-ai/sdk';
import type { ClaimVerdict, SoftClaim } from './claimTypes.js';

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
 */

export interface EvidenceSnippet {
  nodeId: string;               // stable id the judge references on contradict
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
  anthropic: Anthropic;
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

const toolSpec = {
  name: TOOL_NAME,
  description:
    'Record your verdict on whether the claim is supported by the evidence. Use verified only when the evidence directly confirms the claim; unverified when the evidence is silent or ambiguous; contradicted ONLY when the evidence explicitly states something incompatible with the claim.',
  input_schema: {
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
  private readonly anthropic: Anthropic;
  private readonly fetcher: EvidenceFetcher;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly log: (msg: string) => void;

  constructor(opts: EvidenceJudgeOptions) {
    this.anthropic = opts.anthropic;
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

    // Double-check on contradicted: one shaky Haiku flip should not block a
    // correct answer. We only confirm when the second call agrees.
    if (first.verdict === 'contradicted') {
      const second = await this.judgeOnce(claim, evidence);
      if (second === null || second.verdict !== 'contradicted') {
        this.log(
          `[verifier/judge] contradiction not reproduced, downgrading to unverified claim=${claim.id}`,
        );
        return unverified(claim, 'judge contradiction not reproduced on recheck');
      }
    }

    const sourceSnippet = evidence.find((s) => s.nodeId === first.evidenceNodeId);
    const source = sourceSnippet?.source ?? claim.expectedSource;

    switch (first.verdict) {
      case 'verified':
        return {
          status: 'verified',
          claim,
          source: sourceKind(source),
        };
      case 'contradicted':
        return {
          status: 'contradicted',
          claim,
          truth: first.rationale ?? sourceSnippet?.content ?? null,
          source: sourceKind(source),
          ...(first.rationale ? { detail: first.rationale } : {}),
        };
      case 'unverified':
        return unverified(claim, first.rationale ?? 'judge unverified');
    }
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
- Do NOT reward plausibility. If the evidence doesn't mention it, it's unverified — not verified.`;

    const evidenceBlock = evidence
      .map(
        (e, idx) =>
          `Evidence #${String(idx + 1)} [nodeId=${e.nodeId}, source=${e.source}${e.title ? `, title=${e.title}` : ''}]:\n${truncate(e.content, 1800)}`,
      )
      .join('\n\n');

    const user = `CLAIM: ${claim.text}
CLAIM TYPE: ${claim.type}
RELATED: ${claim.relatedEntities.join(', ') || '(none)'}

EVIDENCE:
${evidenceBlock}`;

    let response: Anthropic.Messages.Message;
    try {
      response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        tools: [toolSpec],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: user }],
      });
    } catch (err) {
      this.log(`[verifier/judge] API FAIL: ${errMsg(err)}`);
      return null;
    }

    return parseVerdict(response);
  }
}

// ---------------- helpers ----------------

function parseVerdict(response: Anthropic.Messages.Message): {
  verdict: PrimitiveVerdict;
  evidenceNodeId?: string;
  rationale?: string;
} | null {
  if (!Array.isArray(response.content)) return null;
  for (const block of response.content) {
    if (block.type !== 'tool_use' || block.name !== TOOL_NAME) continue;
    const raw = block.input as RawVerdict;
    const verdict = normaliseVerdict(raw.verdict);
    if (!verdict) return null;
    const nodeId =
      typeof raw.evidence_node_id === 'string'
        ? raw.evidence_node_id.trim()
        : '';
    // verified and contradicted MUST cite a node id — otherwise demote.
    if ((verdict === 'verified' || verdict === 'contradicted') && !nodeId) {
      return { verdict: 'unverified', rationale: 'missing evidence_node_id' };
    }
    const rationale =
      typeof raw.rationale === 'string' ? raw.rationale.slice(0, 300) : '';
    const out: {
      verdict: PrimitiveVerdict;
      evidenceNodeId?: string;
      rationale?: string;
    } = { verdict };
    if (nodeId) out.evidenceNodeId = nodeId;
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

function sourceKind(
  source: EvidenceSnippet['source'] | SoftClaim['expectedSource'],
): 'odoo' | 'graph' {
  return source === 'odoo' ? 'odoo' : 'graph';
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
