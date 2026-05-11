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
 * already attached to the claim (format "<source>:<model>:<id>" or
 * "<model>:<id>"). Broader recall (full-text search over turns / facts)
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
          snippets.push({
            nodeId: hit.id,
            source: 'graph',
            title: displayNameOf(hit),
            content: formatNode(hit),
          });
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
              snippets.push({
                nodeId: hit.id,
                source: 'graph',
                title: displayNameOf(hit),
                content: formatNode(hit),
              });
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

function formatNode(node: GraphNode): string {
  const display = displayNameOf(node);
  const extras: string[] = [];
  for (const [k, v] of Object.entries(node.props)) {
    if (k === 'displayName') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      extras.push(`${k}=${String(v)}`);
    }
    if (extras.length >= 6) break;
  }
  const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
  return `Graph-Node ${node.id} — ${display}${suffix}`;
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
