import type { SoftClaim, VerifierPrivacy } from './claimTypes.js';
import type { EvidenceSnippet } from './evidenceJudge.js';

/**
 * The variable parts of one evidence-judge request: built from REAL values,
 * projected through the turn's surrogate map behind a Privacy Shield, and the
 * way back from what a verdict cites to the snippet it names.
 */

/** Snippet cap behind a Privacy Shield: bounds both what leaves the process
 *  and what the masking pass (including a C1 sidecar) must scan. */
const PRIVACY_MAX_SNIPPETS = 3;

/**
 * Joins the parts of one judge request for a single projection call. Neither
 * character is a word character, so no detector span can grow across it; a
 * projection that returns a different number of parts is treated as blocked.
 */
const PART_SEPARATOR = '\n\u001e\n';

/** The variable parts of one judge request, before or after projection. */
export interface JudgeRequestParts {
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
export function judgeRequestParts(
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
export async function projectRequestParts(
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
 * The node id of the snippet printed under `cited` in the request `parts`
 * describes. A ref the request did not print resolves to nothing: a verdict
 * can only cite what its own request showed.
 */
export function citedNodeId(
  cited: string | undefined,
  parts: JudgeRequestParts,
  evidence: readonly EvidenceSnippet[],
): string | undefined {
  if (cited === undefined) return undefined;
  const idx = parts.evidence.findIndex((e) => e.ref === cited);
  return idx === -1 ? undefined : evidence[idx]?.nodeId;
}
