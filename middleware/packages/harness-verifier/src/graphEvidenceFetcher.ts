import type {
  FindEntitiesOptions,
  GraphNode,
  KnowledgeGraph,
} from '@omadia/plugin-api';
import type { SoftClaim } from './claimTypes.js';
import {
  isRecordHandle,
  matchesRecord,
  parseEntityHandle,
  type EntityHandle,
  type RecordHandle,
} from './entityHandle.js';
import type {
  EvidenceFetcher,
  EvidenceSnippet,
} from './evidenceJudge.js';

/**
 * Default EvidenceFetcher: resolves soft-claim related-entities into
 * graph nodes and surfaces their properties as evidence snippets for the
 * judge — the only evidence the judge ever sees.
 *
 * Lookup rules for the claim's entity handles (see entityHandle.ts):
 *  - A handle with an id (`odoo:hr.employee:7`, `hr.employee:7`) names one
 *    record. It is resolved by exact id (`findEntities({ model, id })`) and
 *    the returned node's identity is re-checked here. A record that is not
 *    in the graph contributes no snippet; another record of the same model
 *    is never substituted.
 *  - A claim that pins at least one record gets ONLY those records: no model
 *    sample and no name search. If none resolves, the claim has no evidence
 *    and the judge leaves it unverified.
 *  - A claim that pins no record gets a labelled sample of each model it
 *    names without an id (`hr.department`), and a labelled name search on
 *    res.partner / hr.employee for the first capitalised phrase of its text.
 *    The labels tell the judge these are search results, not the record the
 *    claim is about.
 *
 * `findEntities` covers Odoo and Confluence entity nodes only; a handle in a
 * plugin namespace (`PluginEntity`, e.g. `dataset:…`) never resolves and
 * yields no evidence. Broader recall (full-text search over turns / facts)
 * is a follow-up — start small so the judge isn't drowned in irrelevant
 * context.
 */

export interface GraphEvidenceFetcherOptions {
  /** Only `findEntities` is used; the narrow type keeps stubs honest. */
  graph: Pick<KnowledgeGraph, 'findEntities'>;
  /** How many snippets to return per claim. Judge cost scales with this. */
  maxSnippets?: number;
}

const DEFAULTS = {
  maxSnippets: 5,
};

/** Records sampled for a model handle without an id. */
const MODEL_SAMPLE_LIMIT = 3;
/** Records the name search takes per model. */
const NAME_SEARCH_LIMIT = 2;
/** Models the name search probes, in order. */
const NAME_SEARCH_MODELS: readonly string[] = ['res.partner', 'hr.employee'];

const MODEL_SAMPLE_LABEL = 'model sample, not a referenced record';
const NAME_MATCH_LABEL = 'name match, not a referenced record';

export class GraphEvidenceFetcher implements EvidenceFetcher {
  private readonly graph: Pick<KnowledgeGraph, 'findEntities'>;
  private readonly maxSnippets: number;

  constructor(opts: GraphEvidenceFetcherOptions) {
    this.graph = opts.graph;
    this.maxSnippets = opts.maxSnippets ?? DEFAULTS.maxSnippets;
  }

  async fetch(claim: SoftClaim): Promise<EvidenceSnippet[]> {
    const handles = claim.relatedEntities
      .map(parseEntityHandle)
      .filter((h): h is EntityHandle => h !== null);
    const pinned = handles.filter(isRecordHandle);
    if (pinned.length > 0) return this.fetchPinned(pinned);

    const snippets: EvidenceSnippet[] = [];
    for (const handle of handles) {
      if (snippets.length >= this.maxSnippets) break;
      const hits = await this.search({
        model: handle.model,
        limit: MODEL_SAMPLE_LIMIT,
      });
      this.collect(snippets, hits, MODEL_SAMPLE_LABEL);
    }

    const candidate = extractCandidateName(claim.text);
    if (candidate) {
      for (const model of NAME_SEARCH_MODELS) {
        if (snippets.length >= this.maxSnippets) break;
        const hits = await this.search({
          model,
          nameContains: candidate,
          limit: NAME_SEARCH_LIMIT,
        });
        this.collect(snippets, hits, NAME_MATCH_LABEL);
      }
    }
    return snippets;
  }

  /** Exactly the pinned records that exist in the graph — nothing else. */
  private async fetchPinned(
    pinned: readonly RecordHandle[],
  ): Promise<EvidenceSnippet[]> {
    const snippets: EvidenceSnippet[] = [];
    for (const handle of pinned) {
      if (snippets.length >= this.maxSnippets) break;
      const hits = await this.search({
        model: handle.model,
        id: handle.id,
        limit: 1,
      });
      const record = hits.filter((node) => matchesRecord(node, handle));
      this.collect(snippets, record);
    }
    return snippets;
  }

  /** Graph errors are soft: the claim just gets less evidence, and the
   *  judge defaults to `unverified` rather than failing the pipeline. */
  private async search(opts: FindEntitiesOptions): Promise<GraphNode[]> {
    try {
      return await this.graph.findEntities(opts);
    } catch {
      return [];
    }
  }

  /** Append snippets for `nodes`, skipping nodes already present and
   *  stopping at the cap. `label` marks search results. */
  private collect(
    snippets: EvidenceSnippet[],
    nodes: readonly GraphNode[],
    label?: string,
  ): void {
    for (const node of nodes) {
      if (snippets.length >= this.maxSnippets) return;
      if (snippets.some((s) => s.nodeId === node.id)) continue;
      snippets.push(toSnippet(node, label));
    }
  }
}

// --- helpers --------------------------------------------------------------

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

/**
 * One node as evidence. `label` marks a search result (a model sample, a
 * name match) so the judge can tell it from the record a claim names.
 */
function toSnippet(node: GraphNode, label?: string): EvidenceSnippet {
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
  const content = `Graph-Node ${node.id} — ${display}${suffix}`;
  return {
    nodeId: node.id,
    source: 'graph',
    title: label ? `${display} (${label})` : display,
    content: label ? `[${label}] ${content}` : content,
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
