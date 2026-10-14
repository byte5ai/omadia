import type { LlmProvider, LlmResponse, ToolSpec } from '@omadia/llm-provider';
import { textMessage, toolCalls } from '@omadia/llm-provider';
import type { ClaimVerdict, SoftClaim, VerifierPrivacy } from './claimTypes.js';
import { MAX_CONTEXT_CHARS } from './claimContext.js';
import { citesOtherRecord } from './entityHandle.js';
import { citedNodeId, judgeRequestParts, projectRequestParts } from './judgeRequest.js';

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
 * Behind a Privacy Shield (`check(claim, privacy)`) each request is projected
 * through the turn's surrogate map before it leaves the process — claim,
 * context and evidence in one pass, so the same person is the same
 * placeholder on both sides. The judge can still verify; a contradiction
 * judged on placeholders is reported as `unverified` instead of blocking.
 * Node ids never leave: the request names each snippet by a handle minted
 * for that request (`ev-1`, `ev-2`, …), the handle the judge cites is mapped
 * back to the snippet server-side, and a node id the text repeats is
 * replaced like a display name.
 *
 * A cited `evidence_node_id` is checked deterministically against the refs
 * the request printed — the per-request handles behind a shield, the node ids
 * without one: a ref outside that set demotes the verdict to `unverified`,
 * on the recheck call as well, and `source` / `truth` come only from the
 * snippet printed under the ref, never from the claim. The rejected ref is
 * logged by its length only, never verbatim.
 */

export interface EvidenceSnippet {
  /** Stable id of the record — what a verdict resolves to. Behind a Privacy
   *  Shield it is never sent (see the class comment); a verdict citing
   *  anything but a ref its own request printed is rejected. */
  nodeId: string;
  source: 'graph' | 'confluence' | 'odoo';
  content: string;              // <= ~2 kB per snippet
  title?: string;
  /**
   * Values in `title` / `content` that identify a person or record (display
   * name, free-text fields, a string record key). Behind a Privacy Shield
   * they are always replaced by placeholders before the judge's request
   * leaves the process, whatever the detectors find — as is `nodeId`, which
   * need not be listed. A fetcher that sets none leaves the rest of the text
   * to the detectors.
   */
  identityValues?: readonly string[];
}

/**
 * Fetches evidence for one claim. Implementations typically hit the
 * knowledge-graph (findEntities, getNeighbors, turn search) but any
 * read-only source is fair game. An id-bearing entity handle on the claim
 * (`hr.employee:7`) names one record: return that record or nothing for it,
 * never another record of the same model (see GraphEvidenceFetcher).
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

/** Per-snippet cap on the evidence text the judge sees. */
const MAX_SNIPPET_CHARS = 1800;
/** Tighter cap behind a Privacy Shield (the snippet count is capped too, see
 *  judgeRequest.ts): it bounds what leaves the process. */
const PRIVACY_MAX_SNIPPET_CHARS = 1200;

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

interface JudgeVerdict {
  verdict: PrimitiveVerdict;
  /** As parsed: the ref the judge cited. Once `judgeOnce` resolved it: the
   *  node id of the snippet printed under that ref, or absent. */
  evidenceNodeId?: string;
  rationale?: string;
  /** What the judge said before its verdict was demoted to `unverified` —
   *  a citation missing, unknown or naming another record. A demoted
   *  `contradicted` is an unconfirmed contradiction (`check`). */
  demotedFrom?: PrimitiveVerdict;
}

const OTHER_RECORD_REASON =
  'cited evidence is a different record than the claim references';

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

  /**
   * Check one SoftClaim. Always resolves; never throws. `claim` carries REAL
   * values (the evidence lookup runs on them server-side); with a `privacy`
   * view every request is projected through the turn's surrogate map first.
   * A fetch or judge call that fails — or a request the projection would
   * not admit, which is then never sent — is `unverified` with
   * `cause: 'check_failed'`; evidence that does not settle the claim is plain
   * `unverified`.
   */
  async check(claim: SoftClaim, privacy?: VerifierPrivacy): Promise<ClaimVerdict> {
    let evidence: EvidenceSnippet[];
    try {
      evidence = await this.fetcher.fetch(claim);
    } catch (err) {
      return checkFailed(claim, `evidence fetch failed: ${errMsg(err)}`);
    }
    if (evidence.length === 0) {
      return unverified(claim, 'no evidence available');
    }

    const first = await this.judgeOnce(claim, evidence, privacy);
    if (first === null) {
      // The call failed, came back without a readable verdict, or was never
      // sent because the privacy projection did not admit it.
      return checkFailed(claim, 'judge returned no usable verdict');
    }
    if (first.verdict === 'unverified') {
      const reason = first.rationale ?? 'judge unverified';
      return first.demotedFrom === 'contradicted'
        ? unconfirmedContradiction(claim, reason)
        : unverified(claim, reason);
    }

    // `parseVerdict` already demotes a citation outside the refs its request
    // printed, and `judgeOnce` resolves a printed ref to its snippet's node id.
    // Resolving it again here keeps that rule if the parser ever changes,
    // before a recheck call is spent, and leaves the cited snippet as the
    // only place `source` and `truth` can come from — never the claim's own
    // `expectedSource`.
    const sourceSnippet =
      first.evidenceNodeId === undefined
        ? undefined
        : evidence.find((s) => s.nodeId === first.evidenceNodeId);
    if (!sourceSnippet) {
      return first.verdict === 'contradicted'
        ? unconfirmedContradiction(claim, UNKNOWN_EVIDENCE_REASON)
        : unverified(claim, UNKNOWN_EVIDENCE_REASON);
    }
    const source = sourceKind(sourceSnippet.source);

    if (first.verdict === 'verified') {
      return { status: 'verified', claim, source };
    }

    // Double-check on contradicted: one shaky Haiku flip should not block a
    // correct answer. We only confirm when the second call agrees; a recheck
    // citing a ref the request did not print comes back `unverified`.
    //
    // Behind the shield the judge compared placeholders. Equal placeholders
    // mean equal values, so `verified` stays sound — but a contradiction can
    // be an artefact of the substitution (a value masked on one side and
    // written differently on the other). It must never block an answer, so
    // it is not confirmed and no second request is sent.
    if (first.projected) {
      this.log(
        `[verifier/judge] contradiction judged on placeholders, downgrading to unverified claim=${claim.id}`,
      );
      return unconfirmedContradiction(
        claim,
        'contradiction judged on placeholder values — not confirmable behind the privacy shield',
      );
    }
    const second = await this.judgeOnce(claim, evidence, privacy);
    if (second === null) {
      // The recheck never ran to a verdict: the contradiction was not tested
      // again, so the check did not finish — a fault, not a non-reproduction.
      this.log(
        `[verifier/judge] contradiction recheck failed, downgrading to unverified claim=${claim.id}`,
      );
      return checkFailed(claim, 'judge contradiction recheck returned no usable verdict');
    }
    if (second.verdict !== 'contradicted') {
      this.log(
        `[verifier/judge] contradiction not reproduced, downgrading to unverified claim=${claim.id}`,
      );
      return unconfirmedContradiction(claim, 'judge contradiction not reproduced on recheck');
    }
    return {
      status: 'contradicted',
      claim,
      truth: first.rationale ?? sourceSnippet.content,
      source,
      ...(first.rationale ? { detail: first.rationale } : {}),
    };
  }

  async checkAll(
    claims: SoftClaim[],
    privacy?: VerifierPrivacy,
  ): Promise<ClaimVerdict[]> {
    return Promise.all(claims.map((c) => this.check(c, privacy)));
  }

  // ------------------------------------------------------------------

  /**
   * One judge request. Returns `null` when no usable verdict came back —
   * including when the privacy projection was blocked, in which case NO
   * request is sent. `projected` is true when the projection replaced
   * anything, i.e. the judge saw placeholders.
   */
  private async judgeOnce(
    claim: SoftClaim,
    evidence: EvidenceSnippet[],
    privacy: VerifierPrivacy | undefined,
  ): Promise<(JudgeVerdict & { projected: boolean }) | null> {
    const real = judgeRequestParts(claim, evidence, privacy !== undefined);
    let parts = real;
    let projected = false;
    if (privacy) {
      try {
        const result = await projectRequestParts(real, evidence, privacy);
        parts = result.parts;
        projected = result.projected;
      } catch (err) {
        this.log(
          `[verifier/judge] skipped — prompt masking blocked claim=${claim.id}: ${errMsg(err)}`,
        );
        return null;
      }
    }

    const system = `You judge whether a single factual claim is supported by a bundle of evidence snippets. You do NOT see the original answer — only the claim and the evidence. This is deliberate: your job is to be an independent reviewer, not to rubber-stamp.

Rules:
- Output ONLY via the ${TOOL_NAME} tool.
- verdict = "verified": evidence directly states the claim.
- verdict = "unverified": evidence is silent, ambiguous, or only tangentially related. This is the DEFAULT when unsure.
- verdict = "contradicted": evidence explicitly says something incompatible with the claim. Requires evidence_node_id.
- Do NOT reward plausibility. If the evidence doesn't mention it, it's unverified — not verified.
- When a CONTEXT line is present it is the single sentence the claim was cut from. Use it only to resolve what the claim refers to (its subject, tense); judge the CLAIM as meant in that sentence. Never base "contradicted" or "verified" on a fact that appears only in CONTEXT and not in CLAIM.
- RELATED names the records the claim is about. When it gives a record id for a model (e.g. "odoo:hr.employee:7"), a snippet about another record of that model (e.g. nodeId "odoo:hr.employee:12") is a different entity: it can neither verify nor contradict the claim. Only the named record itself can.
- A snippet titled "model sample" or "name match" is a search result, not a record the claim names: rely on it only when it is unmistakably about the claim's subject.`;

    const maxSnippetChars = privacy ? PRIVACY_MAX_SNIPPET_CHARS : MAX_SNIPPET_CHARS;
    const evidenceBlock = parts.evidence
      .map(
        (e, idx) =>
          `Evidence #${String(idx + 1)} [nodeId=${e.ref}, source=${e.source}${e.title ? `, title=${e.title}` : ''}]:\n${truncate(e.content, maxSnippetChars)}`,
      )
      .join('\n\n');

    const context = parts.context
      ? `\nCONTEXT: ${truncate(parts.context, MAX_CONTEXT_CHARS)}`
      : '';
    const user = `CLAIM: ${parts.claimText}${context}
CLAIM TYPE: ${claim.type}
RELATED: ${parts.related || '(none)'}

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

    // The refs a verdict may cite: exactly the ones this request printed —
    // the per-request handles behind a shield, the node ids without one.
    const knownRefs: ReadonlySet<string> = new Set(real.evidence.map((e) => e.ref));
    const parsed = parseVerdict(response, knownRefs, (citedLength) => {
      // Only the length: the cited ref is model output that can repeat claim
      // or evidence text, or break or disguise the line (U+2028, ANSI, bidi
      // controls). `claim.id` is assigned by the extractor (`c_001`, …).
      this.log(
        `[verifier/judge] ${UNKNOWN_EVIDENCE_REASON}, downgrading to unverified claim=${claim.id} cited_len=${String(citedLength)}`,
      );
    });
    if (parsed === null) return null;
    // The judge cites a ref of THIS request; only the snippet printed under
    // it can stand behind the verdict.
    const nodeId = citedNodeId(parsed.evidenceNodeId, real, evidence);
    // Checked on the RESOLVED node id, server-side: a record of a model the
    // claim pins by id, but not a pinned record, is a different entity.
    const verdict = bindToReferencedRecord(
      claim,
      {
        verdict: parsed.verdict,
        ...(nodeId !== undefined ? { evidenceNodeId: nodeId } : {}),
        ...(parsed.rationale !== undefined ? { rationale: parsed.rationale } : {}),
        ...(parsed.demotedFrom !== undefined ? { demotedFrom: parsed.demotedFrom } : {}),
      },
      this.log,
    );
    if (privacy === undefined) return { ...verdict, projected };
    return { ...(await this.restoreRationale(verdict, privacy)), projected };
  }

  /**
   * The judge argued over the projected request: map its rationale (which
   * `check` turns into truth / detail / reason) back to real values. A
   * rationale that fails to restore is dropped rather than kept as
   * placeholder text. The citation needs no restore — it is a handle.
   */
  private async restoreRationale(
    verdict: JudgeVerdict,
    privacy: VerifierPrivacy,
  ): Promise<JudgeVerdict> {
    const out: JudgeVerdict = { verdict: verdict.verdict };
    if (verdict.evidenceNodeId !== undefined) out.evidenceNodeId = verdict.evidenceNodeId;
    if (verdict.demotedFrom !== undefined) out.demotedFrom = verdict.demotedFrom;
    if (verdict.rationale !== undefined) {
      try {
        out.rationale = await privacy.restore(verdict.rationale);
      } catch (err) {
        this.log(`[verifier/judge] rationale restore failed, dropped: ${errMsg(err)}`);
      }
    }
    return out;
  }
}

/**
 * A verdict citing a record of a model the claim pins by id, but not a
 * pinned record, rests on a different entity than the claim is about. The
 * prompt says so; this enforces it deterministically for the first call and
 * the contradiction recheck alike, on the node id the cited ref resolved to:
 * such a verdict becomes `unverified`. The log names the claim only — a node
 * id can carry an external key or a user id.
 */
function bindToReferencedRecord(
  claim: SoftClaim,
  verdict: JudgeVerdict,
  log: (msg: string) => void,
): JudgeVerdict {
  if (verdict.verdict === 'unverified') return verdict;
  if (!citesOtherRecord(claim.relatedEntities, verdict.evidenceNodeId)) {
    return verdict;
  }
  log(`[verifier/judge] ${OTHER_RECORD_REASON}, demoting claim=${claim.id}`);
  return { verdict: 'unverified', rationale: OTHER_RECORD_REASON, demotedFrom: verdict.verdict };
}

// ---------------- helpers ----------------

function parseVerdict(
  response: LlmResponse,
  knownRefs: ReadonlySet<string>,
  onUnknownRef: (citedLength: number) => void,
): JudgeVerdict | null {
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
      return { verdict: 'unverified', rationale: 'missing evidence_node_id', demotedFrom: verdict };
    }
    // ...and it must name a snippet this call was shown. Exact match on the
    // trimmed string: ids are opaque, so no case-folding or prefix matching.
    if (needsCitation && !knownRefs.has(nodeId)) {
      onUnknownRef(nodeId.length);
      return { verdict: 'unverified', rationale: UNKNOWN_EVIDENCE_REASON, demotedFrom: verdict };
    }
    const rationale =
      typeof raw.rationale === 'string' ? raw.rationale.slice(0, 300) : '';
    const out: JudgeVerdict = { verdict };
    // An unknown ref never leaves the parser, not even on `unverified`.
    if (nodeId && knownRefs.has(nodeId)) out.evidenceNodeId = nodeId;
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

function checkFailed(claim: SoftClaim, reason: string): ClaimVerdict {
  return { status: 'unverified', claim, reason, cause: 'check_failed' };
}

/** A contradiction the judge reported but that could not be confirmed. */
function unconfirmedContradiction(claim: SoftClaim, reason: string): ClaimVerdict {
  return { status: 'unverified', claim, reason, cause: 'contradiction_unconfirmed' };
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
