import type { GraphNode, KnowledgeGraph } from '@omadia/plugin-api';
import type { SoftClaim } from './claimTypes.js';
import type {
  EvidenceFetcher,
  EvidenceSnippet,
} from './evidenceJudge.js';

/**
 * Default EvidenceFetcher: resolves soft-claim related-entities into
 * graph nodes and surfaces their properties + neighbour labels as
 * evidence snippets for the judge.
 *
 * Coverage today is intentionally narrow: we look up by the entity refs
 * already attached to the claim (format "odoo:hr.employee:7" or
 * "hr.employee:7"). Broader recall (full-text search over turns / facts)
 * is a follow-up — start small so the judge isn't drowned in irrelevant
 * context.
 */

export interface GraphEvidenceFetcherOptions {
  graph: KnowledgeGraph;
  /** How many snippets to return per claim. Judge cost scales with this. */
  maxSnippets?: number;
}

const DEFAULTS = {
  maxSnippets: 5,
};

export class GraphEvidenceFetcher implements EvidenceFetcher {
  private readonly graph: KnowledgeGraph;
  private readonly maxSnippets: number;

  constructor(opts: GraphEvidenceFetcherOptions) {
    this.graph = opts.graph;
    this.maxSnippets = opts.maxSnippets ?? DEFAULTS.maxSnippets;
  }

  async fetch(claim: SoftClaim): Promise<EvidenceSnippet[]> {
    const snippets: EvidenceSnippet[] = [];

    // 1) entity-anchored lookup: for each "model:id" or "system:model:id"
    //    ref, probe the graph for matching entity nodes and their neighbours.
    for (const ref of claim.relatedEntities) {
      if (snippets.length >= this.maxSnippets) break;
      const parsed = parseEntityRef(ref);
      if (!parsed) continue;
      try {
        const hits = await this.graph.findEntities({
          model: parsed.model,
          ...(parsed.name ? { nameContains: parsed.name } : {}),
          limit: 3,
        });
        for (const hit of hits) {
          if (snippets.length >= this.maxSnippets) break;
          snippets.push(toSnippet(hit));
        }
      } catch {
        // Graph errors are soft: return what we have, let the judge
        // default to `unverified` rather than fail the pipeline.
      }
    }

    // 2) if the claim text carries an obvious proper-noun candidate and we
    //    haven't hit the cap yet, try a name-contains lookup on the most
    //    common entity models.
    if (snippets.length < this.maxSnippets) {
      const candidate = extractCandidateName(claim.text);
      if (candidate) {
        for (const model of ['res.partner', 'hr.employee']) {
          if (snippets.length >= this.maxSnippets) break;
          try {
            const hits = await this.graph.findEntities({
              model,
              nameContains: candidate,
              limit: 2,
            });
            for (const hit of hits) {
              if (snippets.length >= this.maxSnippets) break;
              snippets.push(toSnippet(hit));
            }
          } catch {
            // swallow
          }
        }
      }
    }

    return dedupeByNodeId(snippets);
  }
}

// --- helpers --------------------------------------------------------------

function parseEntityRef(ref: string): {
  model: string;
  id?: string;
  name?: string;
} | null {
  const parts = ref.split(':').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  // Accept "model:id", "system:model:id", or "model" alone.
  if (parts.length >= 3) {
    return { model: parts[1]!, id: parts[2]! };
  }
  if (parts.length === 2) {
    return { model: parts[0]!, id: parts[1]! };
  }
  return { model: parts[0]! };
}

function displayNameOf(node: GraphNode): string {
  const raw = node.props['displayName'];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  return node.id;
}

/** Props that name the node's kind rather than describe the record. The
 *  record's own key (`id`) is not one of them: a string key can be a login or
 *  an address, so it is judged like any other value below — a numeric one
 *  stays, as it would in a v4 digest. */
const STRUCTURAL_PROPS: ReadonlySet<string> = new Set(['model', 'system', 'type']);

/** Values the v4 shape classifier would keep as cleartext on its own: ISO
 *  dates and plain numbers. Everything else a string prop holds is treated as
 *  identity-bearing (deny by default). */
const ISO_DATE_VALUE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC_VALUE = /^[+-]?\d+([.,]\d+)?$/;

function toSnippet(node: GraphNode): EvidenceSnippet {
  const display = displayNameOf(node);
  const extras: string[] = [];
  // Display name plus every free-text value shown below, a string record key
  // included: behind a Privacy Shield these are always replaced before the
  // judge's request leaves the process (see EvidenceSnippet.identityValues).
  // The node id needs no entry — the judge never sends a snippet's node id.
  const identityValues = display !== node.id ? [display] : [];
  for (const [k, v] of Object.entries(node.props)) {
    if (k === 'displayName') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      extras.push(`${k}=${String(v)}`);
      if (
        typeof v === 'string' &&
        !STRUCTURAL_PROPS.has(k) &&
        !ISO_DATE_VALUE.test(v.trim()) &&
        !NUMERIC_VALUE.test(v.trim())
      ) {
        identityValues.push(v);
      }
    }
    if (extras.length >= 6) break;
  }
  const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
  return {
    nodeId: node.id,
    source: 'graph',
    title: display,
    content: `Graph-Node ${node.id} — ${display}${suffix}`,
    identityValues,
  };
}

/**
 * Very cheap capitalised-token extraction. Picks the first 1-3-word
 * proper-noun-looking phrase, e.g. "John Doe" / "Lilium GmbH".
 */
function extractCandidateName(text: string): string | undefined {
  const match =
    /\b([A-ZÄÖÜ][\wäöüß]+(?:\s+[A-ZÄÖÜ][\wäöüß]+){0,2})\b/.exec(text);
  return match?.[1];
}

function dedupeByNodeId(snippets: EvidenceSnippet[]): EvidenceSnippet[] {
  const seen = new Set<string>();
  const out: EvidenceSnippet[] = [];
  for (const s of snippets) {
    if (seen.has(s.nodeId)) continue;
    seen.add(s.nodeId);
    out.push(s);
  }
  return out;
}
