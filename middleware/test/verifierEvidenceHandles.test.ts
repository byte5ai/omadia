/**
 * Behind a Privacy Shield the evidence judge never sends a node id. Each
 * snippet is named by an opaque per-request handle (`ev-1`, `ev-2`, …) that
 * the verdict cites and the server resolves back to the snippet, and a node id
 * or record key that appears in the evidence text is replaced like a display
 * name — whether or not the operator enabled prompt masking. Without a shield
 * the request is unchanged.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { GraphNode, KnowledgeGraph } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';
import {
  EvidenceJudge,
  GraphEvidenceFetcher,
  type EvidenceSnippet,
  type SoftClaim,
  type VerifierPrivacy,
} from '@omadia/verifier';

interface RecordedVerdict {
  verdict: 'verified' | 'unverified' | 'contradicted';
  evidence_node_id?: string;
  rationale?: string;
}

interface CapturedRequest {
  /** The whole request as the judge's provider received it. */
  readonly request: unknown;
  /** The user message text of that request. */
  readonly prompt: string;
}

/** The judge's model: records every request, answers with `reply(prompt)`. */
function capturingJudge(reply: (prompt: string) => RecordedVerdict): {
  llm: unknown;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const provider = {
    complete(req: { messages: Array<{ content: unknown }> }): Promise<{ content: unknown[] }> {
      const first = req.messages[0]?.content;
      const prompt = Array.isArray(first)
        ? first.map((p) => (p as { text?: string }).text ?? '').join('')
        : String(first);
      captured.push({ request: req, prompt });
      return Promise.resolve({
        content: [
          { type: 'tool_call', name: 'record_verdict', id: 'toolu_x', input: reply(prompt) },
        ],
      });
    },
  };
  return { llm: provider, captured };
}

/** Cite whatever the request printed for its first snippet. */
const citeFirstShown = (prompt: string): RecordedVerdict => ({
  verdict: 'verified',
  evidence_node_id: /nodeId=([^,\]]+)/.exec(prompt)?.[1] ?? 'missing',
  rationale: 'passt',
});

/** A privacy view over the REAL privacy-guard service — one turn map. */
function servicePrivacy(maskUserPrompt: boolean): VerifierPrivacy {
  const service = createPrivacyGuardService({
    readConfig: (key: string) =>
      key === 'mask_user_prompt' && maskUserPrompt ? 'on' : undefined,
  });
  const turn = { sessionId: 's-handles', turnId: 't-handles' };
  return {
    wireUserMessage: '',
    wireAnswer: '',
    async admitWireView(): Promise<void> {
      const r = await service.maskUserPrompt!({ ...turn, text: '', stage: 'verifier' });
      if (r.outcome === 'blocked') throw new Error(r.reason);
    },
    async projectForWire(text: string, identityValues: readonly string[]): Promise<string> {
      const r = await service.projectVerifierText!({ ...turn, text, identityValues });
      if (r.outcome !== 'masked') throw new Error('projection blocked');
      return r.maskedText;
    },
    async restore(text: string): Promise<string> {
      return service.restorePromptPseudonyms!(turn.turnId, text);
    },
  };
}

/** A knowledge graph holding exactly `nodes`; `findEntities` filters like the
 *  in-memory backend (model, then display name or id). */
function graphOf(nodes: readonly GraphNode[]): KnowledgeGraph {
  return {
    findEntities: async (opts: { model: string; nameContains?: string; limit?: number }) =>
      nodes
        .filter((n) => n.props['model'] === opts.model)
        .filter((n) => {
          const needle = opts.nameContains?.trim().toLowerCase();
          if (!needle) return true;
          const hay = `${String(n.props['displayName'] ?? '')} ${String(n.props['id'] ?? '')}`;
          return hay.toLowerCase().includes(needle);
        })
        .slice(0, opts.limit ?? 25),
  } as unknown as KnowledgeGraph;
}

function softClaim(overrides: Partial<SoftClaim> = {}): SoftClaim {
  return {
    id: 'c_001',
    text: 'ist ein aktiver Kunde',
    type: 'qualitative',
    expectedSource: 'graph',
    relatedEntities: ['res.partner'],
    ...overrides,
  } as SoftClaim;
}

/** A partner whose record key is a login, not a number — as a plugin that
 *  stages its own entities may mint it. Synthetic. */
const LOGIN = 'alice-confidential-login';
const KEYED_NODE_ID = `odoo:res.partner:${LOGIN}`;
const KEYED_PARTNER: GraphNode = {
  id: KEYED_NODE_ID,
  type: 'OdooEntity',
  props: { system: 'odoo', model: 'res.partner', id: LOGIN, displayName: 'Customer' },
};

describe('verifier/evidenceJudge — evidence handles behind a privacy shield', () => {
  for (const maskUserPrompt of [false, true]) {
    it(`a string record key never reaches the judge (prompt masking ${maskUserPrompt ? 'on' : 'off'})`, async () => {
      const { llm, captured } = capturingJudge(citeFirstShown);
      const judge = new EvidenceJudge({
        llm: llm as never,
        fetcher: new GraphEvidenceFetcher({ graph: graphOf([KEYED_PARTNER]) }),
        log: () => undefined,
      });

      const verdict = await judge.check(softClaim(), servicePrivacy(maskUserPrompt));

      assert.equal(captured.length, 1);
      // Neither the node id nor the key inside it — in the header, the
      // `Graph-Node …` line or the `id=…` field — is on the wire.
      assert.deepEqual(findIdentityLeaks(captured[0]!.request, [KEYED_NODE_ID, LOGIN]), []);
      assert.match(captured[0]!.prompt, /Evidence #1 \[nodeId=ev-1, source=graph/);
      // The handle the judge cited still names the snippet.
      assert.equal(verdict.status, 'verified');
    });
  }

  it('replaces a node id no fetcher declared, wherever the request repeats it', async () => {
    const nodeId = 'crm:contact:bob.builder-private';
    const undeclared: EvidenceSnippet = {
      nodeId,
      source: 'graph',
      title: nodeId,
      content: `Kontakt ${nodeId} ist seit 2020 Kunde.`,
    };
    const { llm, captured } = capturingJudge(citeFirstShown);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: { fetch: async () => [undeclared] },
      log: () => undefined,
    });

    await judge.check(softClaim({ relatedEntities: [nodeId] }), servicePrivacy(false));

    assert.equal(captured.length, 1);
    const { request, prompt } = captured[0]!;
    assert.deepEqual(findIdentityLeaks(request, [nodeId]), []);
    // RELATED, title and content name the record by ONE placeholder, so the
    // judge can still tell they are the same record.
    const placeholders = new Set(prompt.match(/PLATZHALTER-NAME-\d+/g) ?? []);
    assert.equal(placeholders.size, 1, prompt);
    assert.match(prompt, /RELATED: PLATZHALTER-NAME-\d+/);
  });

  it('resolves the cited handle to the snippet printed under it', async () => {
    const handbook: EvidenceSnippet = {
      nodeId: 'confluence:page:hr-handbook',
      source: 'graph',
      content: 'Handbuch der Personalabteilung',
    };
    const employee: EvidenceSnippet = {
      nodeId: 'odoo:hr.employee:jdoe',
      source: 'odoo',
      content: 'Abteilung IT',
    };
    const { llm, captured } = capturingJudge(() => ({ verdict: 'verified', evidence_node_id: 'ev-2' }));
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: { fetch: async () => [handbook, employee] },
      log: () => undefined,
    });

    const verdict = await judge.check(softClaim({ relatedEntities: [] }), servicePrivacy(false));

    assert.match(captured[0]!.prompt, /Evidence #2 \[nodeId=ev-2, source=odoo\]/);
    assert.equal(verdict.status, 'verified');
    // Only the snippet printed as ev-2 can supply the source ('odoo'); the
    // claim's own expectation would have been 'graph'.
    if (verdict.status === 'verified') assert.equal(verdict.source, 'odoo');
  });

  it('without a privacy view the request names snippets by node id, as before', async () => {
    const snippet: EvidenceSnippet = {
      nodeId: 'odoo:hr.employee:7',
      source: 'odoo',
      content: 'Graph-Node odoo:hr.employee:7 — Abteilung IT',
    };
    const { llm, captured } = capturingJudge(() => ({
      verdict: 'verified',
      evidence_node_id: 'odoo:hr.employee:7',
    }));
    const judge = new EvidenceJudge({ llm: llm as never, fetcher: { fetch: async () => [snippet] } });

    const verdict = await judge.check(softClaim({ relatedEntities: [] }));

    assert.match(captured[0]!.prompt, /Evidence #1 \[nodeId=odoo:hr\.employee:7, source=odoo\]/);
    assert.equal(verdict.status, 'verified');
    if (verdict.status === 'verified') assert.equal(verdict.source, 'odoo');
  });
});

describe('GraphEvidenceFetcher — record keys', () => {
  it('lists a string record key as identity-bearing, never a numeric one', async () => {
    const numeric: GraphNode = {
      id: 'odoo:res.partner:42',
      type: 'OdooEntity',
      props: { system: 'odoo', model: 'res.partner', id: 42, displayName: 'ACME GmbH' },
    };
    const numericString: GraphNode = {
      id: 'odoo:res.partner:43',
      type: 'OdooEntity',
      props: { system: 'odoo', model: 'res.partner', id: '43', displayName: 'Beta AG' },
    };
    const fetcher = new GraphEvidenceFetcher({
      graph: graphOf([KEYED_PARTNER, numeric, numericString]),
    });

    const snippets = await fetcher.fetch(softClaim());
    const byId = new Map(snippets.map((s) => [s.nodeId, s]));

    assert.deepEqual(byId.get(KEYED_NODE_ID)?.identityValues, ['Customer', LOGIN]);
    assert.deepEqual(byId.get('odoo:res.partner:42')?.identityValues, ['ACME GmbH']);
    assert.deepEqual(byId.get('odoo:res.partner:43')?.identityValues, ['Beta AG']);
  });
});
