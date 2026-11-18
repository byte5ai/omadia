import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type {
  FindEntitiesOptions,
  GraphNode,
  KnowledgeGraph,
} from '@omadia/plugin-api';
import {
  EvidenceJudge,
  GraphEvidenceFetcher,
  type EvidenceFetcher,
  type EvidenceSnippet,
  type SoftClaim,
} from '@omadia/verifier';

/**
 * The verifier's graph evidence is resolved by exact entity id.
 *
 * A soft claim carries entity handles from the claim extractor
 * (`odoo:hr.employee:7`, `hr.employee:7`, or a bare `hr.department`). The
 * judge sees ONLY the snippets the fetcher returns, so a snippet about
 * another record of the same model reads to it as evidence for the claim's
 * record. These tests pin that an id-bearing handle resolves exactly that
 * record or nothing, that the fetcher re-checks identity instead of trusting
 * the backend, and that the judge cannot rest a verdict on a different
 * record of a model the claim pins.
 */

type EntityGraph = Pick<KnowledgeGraph, 'findEntities'>;

function entity(
  model: string,
  id: number | string,
  displayName: string,
  system = 'odoo',
): GraphNode {
  return {
    id: `${system}:${model}:${String(id)}`,
    type: system === 'confluence' ? 'ConfluencePage' : 'OdooEntity',
    props: { system, model, id, displayName },
  };
}

const ANNA_12 = entity('hr.employee', 12, 'Anna Schmidt');
const BEN_13 = entity('hr.employee', 13, 'Ben Wagner');
const CARLA_7 = entity('hr.employee', 7, 'Carla Weber');
const SALES = entity('hr.department', 3, 'Vertrieb');

/** Recording stub that honours the exact-id contract of `findEntities`. */
function contractGraph(
  nodes: readonly GraphNode[],
  calls: FindEntitiesOptions[] = [],
): EntityGraph {
  return {
    findEntities(opts: FindEntitiesOptions): Promise<GraphNode[]> {
      calls.push({ ...opts });
      const wanted = opts.id === undefined ? undefined : String(opts.id).trim();
      const needle = opts.nameContains?.trim().toLowerCase();
      const hits = nodes.filter((n) => {
        if (n.props['model'] !== opts.model) return false;
        if (wanted !== undefined && String(n.props['id']) !== wanted) return false;
        if (needle === undefined) return true;
        const hay = `${String(n.props['displayName'])} ${String(n.props['id'])}`;
        return hay.toLowerCase().includes(needle);
      });
      return Promise.resolve(hits.slice(0, opts.limit ?? 25));
    },
  };
}

/** A provider compiled against the contract before `id` existed: it ignores
 *  the option and answers model-wide, like the backends used to. */
function idBlindGraph(nodes: readonly GraphNode[]): EntityGraph {
  return {
    findEntities(opts: FindEntitiesOptions): Promise<GraphNode[]> {
      const hits = nodes.filter((n) => n.props['model'] === opts.model);
      return Promise.resolve(hits.slice(0, opts.limit ?? 25));
    },
  };
}

function softClaim(overrides: Partial<SoftClaim> = {}): SoftClaim {
  return {
    id: 'c_001',
    // Capitalised on purpose: the name search keys on the first capitalised
    // phrase, so a lower-case claim would hide it rather than prove the gate.
    text: 'Anna Schmidt leitet seit 2020 den Vertrieb',
    type: 'qualitative',
    expectedSource: 'graph',
    relatedEntities: [],
    ...overrides,
  } as SoftClaim;
}

// --- GraphEvidenceFetcher --------------------------------------------------

describe('verifier/graphEvidenceFetcher — id-bearing handles', () => {
  it('resolves hr.employee:7 by exact id, passing the id as a string', async () => {
    const calls: FindEntitiesOptions[] = [];
    const fetcher = new GraphEvidenceFetcher({
      graph: contractGraph([ANNA_12, BEN_13, CARLA_7], calls),
    });

    const snippets = await fetcher.fetch(
      softClaim({ relatedEntities: ['hr.employee:7'] }),
    );

    assert.deepEqual(calls, [{ model: 'hr.employee', id: '7', limit: 1 }]);
    assert.deepEqual(
      snippets.map((s) => s.nodeId),
      ['odoo:hr.employee:7'],
    );
    assert.equal(snippets[0]?.title, 'Carla Weber');
  });

  it('never presents another entity as evidence for a specific id', async () => {
    const calls: FindEntitiesOptions[] = [];
    // 7 is not in the graph; 12 even carries the name the claim text starts
    // with, so neither a model-wide nor a name search may bring it in.
    const fetcher = new GraphEvidenceFetcher({
      graph: contractGraph([ANNA_12, BEN_13], calls),
    });

    const snippets = await fetcher.fetch(
      softClaim({ relatedEntities: ['hr.employee:7'] }),
    );

    assert.deepEqual(snippets, []);
    assert.deepEqual(calls, [{ model: 'hr.employee', id: '7', limit: 1 }]);
  });

  it('re-checks identity when the provider ignores the id option', async () => {
    const fetcher = new GraphEvidenceFetcher({
      graph: idBlindGraph([ANNA_12, BEN_13]),
    });

    const snippets = await fetcher.fetch(
      softClaim({ relatedEntities: ['hr.employee:7'] }),
    );

    assert.deepEqual(snippets, []);
  });

  it('accepts the three-part odoo:hr.employee:7 form and dedupes with hr.employee:7', async () => {
    const calls: FindEntitiesOptions[] = [];
    const fetcher = new GraphEvidenceFetcher({
      graph: contractGraph([ANNA_12, CARLA_7], calls),
    });

    const snippets = await fetcher.fetch(
      softClaim({ relatedEntities: ['odoo:hr.employee:7', 'hr.employee:7'] }),
    );

    assert.deepEqual(calls, [
      { model: 'hr.employee', id: '7', limit: 1 },
      { model: 'hr.employee', id: '7', limit: 1 },
    ]);
    assert.deepEqual(
      snippets.map((s) => s.nodeId),
      ['odoo:hr.employee:7'],
    );
  });

  it('holds a three-part handle to its system as well', async () => {
    const fetcher = new GraphEvidenceFetcher({
      graph: contractGraph([CARLA_7, ANNA_12]),
    });

    const snippets = await fetcher.fetch(
      softClaim({ relatedEntities: ['confluence:hr.employee:7'] }),
    );

    assert.deepEqual(snippets, []);
  });

  it('adds no model sample and no name search once the claim pins a record', async () => {
    const calls: FindEntitiesOptions[] = [];
    const fetcher = new GraphEvidenceFetcher({
      graph: contractGraph([ANNA_12, CARLA_7, SALES], calls),
    });

    const snippets = await fetcher.fetch(
      softClaim({ relatedEntities: ['hr.department', 'hr.employee:7'] }),
    );

    assert.deepEqual(calls, [{ model: 'hr.employee', id: '7', limit: 1 }]);
    assert.deepEqual(
      snippets.map((s) => s.nodeId),
      ['odoo:hr.employee:7'],
    );
  });

  it('graph errors stay soft', async () => {
    const fetcher = new GraphEvidenceFetcher({
      graph: {
        findEntities(): Promise<GraphNode[]> {
          return Promise.reject(new Error('connection reset'));
        },
      },
    });

    const snippets = await fetcher.fetch(
      softClaim({ relatedEntities: ['hr.employee:7'] }),
    );

    assert.deepEqual(snippets, []);
  });
});

describe('verifier/graphEvidenceFetcher — handles without an id', () => {
  it('falls back to a labelled model-wide sample only when no id is given', async () => {
    const calls: FindEntitiesOptions[] = [];
    const fetcher = new GraphEvidenceFetcher({
      graph: contractGraph([SALES, entity('hr.department', 4, 'Einkauf')], calls),
    });

    const snippets = await fetcher.fetch(
      softClaim({ text: 'der vertrieb hat zwölf stellen', relatedEntities: ['hr.department'] }),
    );

    assert.deepEqual(calls, [{ model: 'hr.department', limit: 3 }]);
    assert.equal('id' in calls[0]!, false);
    assert.deepEqual(
      snippets.map((s) => s.nodeId),
      ['odoo:hr.department:3', 'odoo:hr.department:4'],
    );
    for (const s of snippets) {
      assert.match(s.title ?? '', /model sample, not a referenced record/);
      assert.match(s.content, /model sample, not a referenced record/);
    }
  });

  it('reads odoo:res.partner as a system-qualified model, not as an id', async () => {
    const calls: FindEntitiesOptions[] = [];
    const fetcher = new GraphEvidenceFetcher({
      graph: contractGraph([entity('res.partner', 42, 'Lindenhof GmbH')], calls),
    });

    const snippets = await fetcher.fetch(
      softClaim({ text: 'ein kunde aus köln', relatedEntities: ['odoo:res.partner'] }),
    );

    assert.deepEqual(calls, [{ model: 'res.partner', limit: 3 }]);
    assert.deepEqual(
      snippets.map((s) => s.nodeId),
      ['odoo:res.partner:42'],
    );
  });

  it('runs the labelled name search for a claim that pins no record', async () => {
    const calls: FindEntitiesOptions[] = [];
    const fetcher = new GraphEvidenceFetcher({
      graph: contractGraph([ANNA_12, BEN_13], calls),
    });

    const snippets = await fetcher.fetch(softClaim());

    assert.deepEqual(calls, [
      { model: 'res.partner', nameContains: 'Anna Schmidt', limit: 2 },
      { model: 'hr.employee', nameContains: 'Anna Schmidt', limit: 2 },
    ]);
    assert.deepEqual(
      snippets.map((s) => s.nodeId),
      ['odoo:hr.employee:12'],
    );
    assert.match(snippets[0]?.title ?? '', /name match, not a referenced record/);
  });
});

// --- Fetcher + judge -------------------------------------------------------

interface CapturedRequest {
  system?: string;
}

function stubJudgeLlm(
  sequence: ReadonlyArray<Record<string, string>>,
): { llm: unknown; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const llm = {
    complete(req: CapturedRequest): Promise<{ content: unknown[] }> {
      const input = sequence[requests.length] ?? sequence[sequence.length - 1];
      requests.push(req);
      return Promise.resolve({
        content: [
          { type: 'tool_call', name: 'record_verdict', id: 'toolu_x', input },
        ],
      });
    },
  };
  return { llm, requests };
}

function fixedFetcher(snippets: EvidenceSnippet[]): EvidenceFetcher {
  return {
    fetch(): Promise<EvidenceSnippet[]> {
      return Promise.resolve(snippets);
    },
  };
}

function snippetOf(node: GraphNode): EvidenceSnippet {
  return {
    nodeId: node.id,
    source: 'graph',
    title: String(node.props['displayName']),
    content: `Graph-Node ${node.id} — ${String(node.props['displayName'])}`,
  };
}

const silent = (): void => {
  /* quiet */
};

describe('verifier/evidenceJudge — the referenced record', () => {
  it('leaves an id-anchored claim unverified when its record is absent, without asking the judge', async () => {
    const { llm, requests } = stubJudgeLlm([
      { verdict: 'verified', evidence_node_id: 'odoo:hr.employee:12' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: new GraphEvidenceFetcher({ graph: contractGraph([ANNA_12, BEN_13]) }),
      log: silent,
    });

    const verdict = await judge.check(
      softClaim({ relatedEntities: ['hr.employee:7'] }),
    );

    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.equal(verdict.reason, 'no evidence available');
    }
    assert.equal(requests.length, 0);
  });

  it('demotes a verdict that cites another record of the model the claim pins', async () => {
    const { llm, requests } = stubJudgeLlm([
      { verdict: 'verified', evidence_node_id: 'odoo:hr.employee:12' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: fixedFetcher([snippetOf(ANNA_12)]),
      log: silent,
    });

    const verdict = await judge.check(
      softClaim({ relatedEntities: ['hr.employee:7'] }),
    );

    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.match(verdict.reason, /different record/);
    }
    assert.equal(requests.length, 1);
  });

  it('does not confirm a contradiction whose recheck cites another record', async () => {
    const { llm, requests } = stubJudgeLlm([
      { verdict: 'contradicted', evidence_node_id: 'odoo:hr.employee:7', rationale: 'leitet den Einkauf' },
      { verdict: 'contradicted', evidence_node_id: 'odoo:hr.employee:12', rationale: 'leitet den Einkauf' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: fixedFetcher([snippetOf(CARLA_7), snippetOf(ANNA_12)]),
      log: silent,
    });

    const verdict = await judge.check(
      softClaim({ relatedEntities: ['odoo:hr.employee:7'] }),
    );

    assert.equal(verdict.status, 'unverified');
    assert.equal(requests.length, 2);
  });

  it('still verifies on the pinned record itself', async () => {
    const { llm } = stubJudgeLlm([
      { verdict: 'verified', evidence_node_id: 'odoo:hr.employee:7' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: new GraphEvidenceFetcher({ graph: contractGraph([ANNA_12, CARLA_7]) }),
      log: silent,
    });

    const verdict = await judge.check(
      softClaim({ relatedEntities: ['hr.employee:7'] }),
    );

    assert.equal(verdict.status, 'verified');
  });

  it('tells the judge that another record of a pinned model is not evidence', async () => {
    const { llm, requests } = stubJudgeLlm([{ verdict: 'unverified' }]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: fixedFetcher([snippetOf(CARLA_7)]),
      log: silent,
    });

    await judge.check(softClaim({ relatedEntities: ['hr.employee:7'] }));

    const system = requests[0]?.system ?? '';
    assert.match(system, /another record of that model/);
    assert.match(system, /"model sample" or "name match"/);
  });
});
