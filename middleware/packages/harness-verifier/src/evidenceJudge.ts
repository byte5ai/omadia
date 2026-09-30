import type { LlmProvider, LlmResponse, ToolSpec } from '@omadia/llm-provider';
import { textMessage, toolCalls } from '@omadia/llm-provider';
import type { ClaimVerdict, SoftClaim, VerifierPrivacy } from './claimTypes.js';
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
 * Behind a Privacy Shield (`check(claim, privacy)`) each request is projected
 * through the turn's surrogate map before it leaves the process — claim,
 * context and evidence in one pass, so the same person is the same
 * placeholder on both sides. The judge can still verify; a contradiction
 * judged on placeholders is reported as `unverified` instead of blocking.
 * Node ids never leave: the request names each snippet by a handle minted
 * for that request (`ev-1`, `ev-2`, …), the handle the judge cites is mapped
 * back to the snippet server-side, and a node id the text repeats is
 * replaced like a display name.
 */

export interface EvidenceSnippet {
  /** Stable id of the record — what a verdict resolves to. Behind a Privacy
   *  Shield it is never sent (see the class comment). */
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

/** Per-snippet cap on the evidence text the judge sees. */
const MAX_SNIPPET_CHARS = 1800;
/** Tighter caps behind a Privacy Shield: they bound both what leaves the
 *  process and what the masking pass (including a C1 sidecar) must scan. */
const PRIVACY_MAX_SNIPPETS = 3;
const PRIVACY_MAX_SNIPPET_CHARS = 1200;

/**
 * Joins the parts of one judge request for a single projection call. Neither
 * character is a word character, so no detector span can grow across it; a
 * projection that returns a different number of parts is treated as blocked.
 */
const PART_SEPARATOR = '\n\u001e\n';

const TOOL_NAME = 'record_verdict';

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
  /** As parsed: the ref the judge cited. After `resolveCitation`: the node id
   *  of the snippet printed under that ref, or absent. */
  evidenceNodeId?: string;
  rationale?: string;
}

/** The variable parts of one judge request, before or after projection. */
interface JudgeRequestParts {
  readonly claimText: string;
  readonly context: string;
  readonly related: string;
  readonly evidence: ReadonlyArray<{
    /** What the request prints for the snippet, and so the only value a
     *  verdict can cite for it: the node id without a shield, an opaque
     *  handle behind one. Never projected. */
    readonly ref: string;
    readonly source: EvidenceSnippet['source'];
    readonly title: string;
    readonly content: string;
  }>;
}

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
   */
  async check(claim: SoftClaim, privacy?: VerifierPrivacy): Promise<ClaimVerdict> {
    let evidence: EvidenceSnippet[];
    try {
      evidence = await this.fetcher.fetch(claim);
    } catch (err) {
      return unverified(claim, `evidence fetch failed: ${errMsg(err)}`);
    }
    if (evidence.length === 0) {
      return unverified(claim, 'no evidence available');
    }

    const first = await this.judgeOnce(claim, evidence, privacy);
    if (first === null) {
      return unverified(claim, 'judge returned no usable verdict');
    }

    // Double-check on contradicted: one shaky Haiku flip should not block a
    // correct answer. We only confirm when the second call agrees.
    if (first.verdict === 'contradicted') {
      // Behind the shield the judge compared placeholders. Equal placeholders
      // mean equal values, so `verified` stays sound — but a contradiction
      // can be an artefact of the substitution (a value masked on one side
      // and written differently on the other). It must never block an
      // answer, so it is not confirmed and no second request is sent.
      if (first.projected) {
        this.log(
          `[verifier/judge] contradiction judged on placeholders, downgrading to unverified claim=${claim.id}`,
        );
        return unverified(
          claim,
          'contradiction judged on placeholder values — not confirmable behind the privacy shield',
        );
      }
      const second = await this.judgeOnce(claim, evidence, privacy);
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
- When a CONTEXT line is present it is the single sentence the claim was cut from. Use it only to resolve what the claim refers to (its subject, tense); judge the CLAIM as meant in that sentence. Never base "contradicted" or "verified" on a fact that appears only in CONTEXT and not in CLAIM.`;

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

    const parsed = parseVerdict(response);
    if (parsed === null) return null;
    const verdict = resolveCitation(parsed, real, evidence);
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

// ---------------- helpers ----------------

/**
 * The ref a shielded judge request prints for its snippet at `index`. Minted
 * per request, it names a position in that request and nothing else — a node
 * id can embed an external key or a channel user id, and the judge needs a
 * reference, not the key.
 */
function evidenceHandle(index: number): string {
  return `ev-${String(index + 1)}`;
}

/**
 * The variable parts of a judge request from REAL values. The CONTEXT line is
 * decided here, on real values, so projection cannot change whether it shows.
 * Behind a privacy shield the evidence is capped before anything is masked
 * and each snippet is named by its handle instead of its node id.
 */
function judgeRequestParts(
  claim: SoftClaim,
  evidence: readonly EvidenceSnippet[],
  shielded: boolean,
): JudgeRequestParts {
  const context =
    claim.context && claim.context.trim().toLowerCase() !== claim.text.trim().toLowerCase()
      ? claim.context
      : '';
  const snippets = shielded ? evidence.slice(0, PRIVACY_MAX_SNIPPETS) : evidence;
  return {
    claimText: claim.text,
    context,
    related: claim.relatedEntities.join(', '),
    evidence: snippets.map((e, idx) => ({
      ref: shielded ? evidenceHandle(idx) : e.nodeId,
      source: e.source,
      title: e.title ?? '',
      content: e.content,
    })),
  };
}

/**
 * Project every variable part of one judge request through the turn's
 * surrogate map in ONE call: the claim, its context and the evidence share a
 * map, so a person is the same placeholder on both sides of the comparison,
 * and the masking pass runs once per request instead of once per field.
 * Besides each snippet's declared identity values, its node id is always
 * replaced wherever the request repeats it (RELATED, a `Graph-Node …` line, a
 * title that falls back to the id) — the detectors alone would pass a key
 * that is not shaped like an e-mail or an IBAN. Refs and source labels stay
 * as they are. Throws when the projection is blocked or came back with a
 * different structure; the caller then sends nothing.
 */
async function projectRequestParts(
  real: JudgeRequestParts,
  evidence: readonly EvidenceSnippet[],
  privacy: VerifierPrivacy,
): Promise<{ parts: JudgeRequestParts; projected: boolean }> {
  const flat = [
    real.claimText,
    real.context,
    real.related,
    ...real.evidence.flatMap((e) => [e.title, e.content]),
  ];
  const joined = flat.join(PART_SEPARATOR);
  const identityValues = [
    ...new Set(
      evidence
        .slice(0, real.evidence.length)
        .flatMap((e) => [e.nodeId, ...(e.identityValues ?? [])]),
    ),
  ];
  const masked = await privacy.projectForWire(joined, identityValues);
  const out = masked.split(PART_SEPARATOR);
  if (out.length !== flat.length) {
    throw new Error('projection changed the structure of the judge request');
  }
  const at = (i: number): string => out[i] ?? '';
  return {
    projected: masked !== joined,
    parts: {
      claimText: at(0),
      context: at(1),
      related: at(2),
      evidence: real.evidence.map((e, idx) => ({
        ref: e.ref,
        source: e.source,
        title: at(3 + idx * 2),
        content: at(4 + idx * 2),
      })),
    },
  };
}

/**
 * Map the ref a verdict cites to the node id of the snippet printed under it
 * in the same request. A ref the request did not print resolves to nothing:
 * a verdict can only cite what its own request showed.
 */
function resolveCitation(
  verdict: JudgeVerdict,
  parts: JudgeRequestParts,
  evidence: readonly EvidenceSnippet[],
): JudgeVerdict {
  const out: JudgeVerdict = { verdict: verdict.verdict };
  const cited = verdict.evidenceNodeId;
  const idx = cited === undefined ? -1 : parts.evidence.findIndex((e) => e.ref === cited);
  const nodeId = idx === -1 ? undefined : evidence[idx]?.nodeId;
  if (nodeId !== undefined) out.evidenceNodeId = nodeId;
  if (verdict.rationale !== undefined) out.rationale = verdict.rationale;
  return out;
}

function parseVerdict(response: LlmResponse): JudgeVerdict | null {
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
    // verified and contradicted MUST cite a node id — otherwise demote.
    if ((verdict === 'verified' || verdict === 'contradicted') && !nodeId) {
      return { verdict: 'unverified', rationale: 'missing evidence_node_id' };
    }
    const rationale =
      typeof raw.rationale === 'string' ? raw.rationale.slice(0, 300) : '';
    const out: JudgeVerdict = { verdict };
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
