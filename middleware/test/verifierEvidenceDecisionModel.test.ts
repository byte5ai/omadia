/**
 * Verifier evidence judge on `decisionModel@1`: every claim of a turn in ONE
 * batch (verdict choice + evidence choice per claim). Conservative mapping:
 * below 0.8 nothing is verified or contradicted, a citation must name a
 * printed snippet of the pinned record, and a contradiction still needs the
 * LLM recheck. Any failure → the LLM judge. Plus the `verifier_decision_model`
 * kill switch through the real `activate()`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import YAML from 'yaml';
import type { DecisionBatchRequest, DecisionModelService, PluginContext } from '@omadia/plugin-api';

import type { SoftClaim, VerifierPrivacy } from '../packages/harness-verifier/src/claimTypes.js';
import {
  EvidenceJudge,
  type EvidenceFetcher,
  type EvidenceSnippet,
} from '../packages/harness-verifier/src/evidenceJudge.js';
import { activate, type VerifierBundle } from '../packages/harness-verifier/src/plugin.js';
import { useBuiltinProviders } from './_helpers/builtinProviders.js';

useBuiltinProviders();

interface LlmVerdict {
  verdict: 'verified' | 'unverified' | 'contradicted';
  evidence_node_id?: string;
  rationale?: string;
}

function stubLlm(verdict: LlmVerdict): { llm: never; calls: () => number } {
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      return { content: [{ type: 'tool_call', name: 'record_verdict', id: 't', input: verdict }] };
    },
  };
  return { llm: llm as never, calls: () => calls };
}

function fakeDecision(
  answer: (req: DecisionBatchRequest) => Record<string, unknown> | Error,
): DecisionModelService & { requests: DecisionBatchRequest[] } {
  const requests: DecisionBatchRequest[] = [];
  return {
    provider: 'fake',
    requests,
    choose: async () => {
      throw new Error('choose must not be used');
    },
    decideAll: async (req: DecisionBatchRequest) => {
      requests.push(req);
      const out = answer(req);
      if (out instanceof Error) throw out;
      return { answers: out as never };
    },
  };
}

function claim(id: string, overrides: Partial<SoftClaim> = {}): SoftClaim {
  return {
    id,
    text: 'John Doe ist Senior Developer bei byte5',
    type: 'qualitative',
    expectedSource: 'graph',
    relatedEntities: ['person:john-doe'],
    ...overrides,
  } as SoftClaim;
}

const SNIPPET: EvidenceSnippet = {
  nodeId: 'person:john-doe',
  source: 'graph',
  content: 'John Doe, Senior Dev bei byte5, seit 2020.',
  title: 'John Doe',
};

const fetcher = (snippets: EvidenceSnippet[]): EvidenceFetcher => ({ fetch: async () => snippets });

const choice = (c: string, confidence: number) => ({ kind: 'choice', choice: c, confidence });

function judgeWith(
  decide: DecisionModelService | undefined,
  llmVerdict: LlmVerdict = { verdict: 'unverified' },
  snippets: EvidenceSnippet[] = [SNIPPET],
) {
  const { llm, calls } = stubLlm(llmVerdict);
  const logs: string[] = [];
  const judge = new EvidenceJudge({
    llm,
    fetcher: fetcher(snippets),
    log: (m) => logs.push(m),
    decide: () => decide,
  });
  return { judge, llmCalls: calls, logs };
}

describe('verifier evidence judge · decisionModel@1', () => {
  it('judges every claim in ONE batch without an LLM call', async () => {
    const decide = fakeDecision(() => ({
      c0_verdict: choice('verified', 0.93),
      c0_evidence: choice('e1', 0.9),
      c1_verdict: choice('unverifiable', 0.7),
      c1_evidence: choice('none', 0.8),
    }));
    const { judge, llmCalls, logs } = judgeWith(decide);
    const [a, b] = await judge.checkAll([claim('c_001'), claim('c_002')]);
    assert.deepEqual(a, { status: 'verified', claim: claim('c_001'), source: 'graph' });
    assert.equal(b?.status, 'unverified');
    assert.equal(b?.status === 'unverified' ? b.cause : 'x', undefined);
    assert.equal(llmCalls(), 0);
    assert.equal(decide.requests.length, 1);
    const req = decide.requests[0]!;
    assert.deepEqual(Object.keys(req.questions), ['c0_verdict', 'c0_evidence', 'c1_verdict', 'c1_evidence']);
    const ev = req.questions['c0_evidence'];
    assert.deepEqual(ev?.kind === 'choice' ? ev.options.map((o) => o.id) : [], ['e1', 'none']);
    const verdict = req.questions['c0_verdict'];
    assert.deepEqual(
      verdict?.kind === 'choice' ? verdict.options.map((o) => o.id) : [],
      ['verified', 'contradicted', 'unverifiable'],
    );
    const line = logs.find((l) => l.includes('decision model'));
    assert.match(line ?? '', /provider=fake ms=\d+ claims=2 verified=1 contradicted=0 unverifiable=1 low_confidence=0 llm_fallback=0/);
    assert.ok(!logs.join('\n').includes('John'));
  });

  for (const v of ['verified', 'contradicted'] as const) {
    it(`a ${v} below 0.8 is unverified, with no LLM call`, async () => {
      const decide = fakeDecision(() => ({ c0_verdict: choice(v, 0.79), c0_evidence: choice('e1', 0.99) }));
      const { judge, llmCalls } = judgeWith(decide, { verdict: 'contradicted', evidence_node_id: SNIPPET.nodeId });
      const [r] = await judge.checkAll([claim('c_001')]);
      assert.equal(r?.status, 'unverified');
      assert.equal(llmCalls(), 0);
    });
  }

  it('a verified citing none is unverified', async () => {
    const decide = fakeDecision(() => ({ c0_verdict: choice('verified', 0.95), c0_evidence: choice('none', 0.9) }));
    const { judge } = judgeWith(decide);
    const [r] = await judge.checkAll([claim('c_001')]);
    assert.equal(r?.status, 'unverified');
    assert.equal(r?.status === 'unverified' ? r.reason : '', 'missing evidence_node_id');
  });

  it('a verified citing another record of the pinned model is unverified', async () => {
    const other: EvidenceSnippet = { nodeId: 'odoo:hr.employee:12', source: 'odoo', content: 'Max, Senior Dev' };
    const decide = fakeDecision(() => ({ c0_verdict: choice('verified', 0.95), c0_evidence: choice('e1', 0.9) }));
    const { judge } = judgeWith(decide, undefined, [other]);
    const [r] = await judge.checkAll([claim('c_001', { relatedEntities: ['odoo:hr.employee:7'] })]);
    assert.equal(r?.status, 'unverified');
  });

  it('a confident contradiction is confirmed by the LLM recheck', async () => {
    const decide = fakeDecision(() => ({ c0_verdict: choice('contradicted', 0.9), c0_evidence: choice('e1', 0.9) }));
    const { judge, llmCalls } = judgeWith(decide, {
      verdict: 'contradicted',
      evidence_node_id: SNIPPET.nodeId,
      rationale: 'Evidence says Junior Developer',
    });
    const [r] = await judge.checkAll([claim('c_001')]);
    assert.equal(llmCalls(), 1);
    assert.equal(r?.status, 'contradicted');
    assert.equal(r?.status === 'contradicted' ? r.truth : '', 'Evidence says Junior Developer');
  });

  it('a confident contradiction the LLM does not reproduce is unconfirmed', async () => {
    const decide = fakeDecision(() => ({ c0_verdict: choice('contradicted', 0.95), c0_evidence: choice('e1', 0.9) }));
    const { judge, llmCalls } = judgeWith(decide, { verdict: 'unverified' });
    const [r] = await judge.checkAll([claim('c_001')]);
    assert.equal(llmCalls(), 1);
    assert.equal(r?.status, 'unverified');
    assert.equal(r?.status === 'unverified' ? r.cause : '', 'contradiction_unconfirmed');
  });

  it('falls back to the LLM for every claim when the batch throws', async () => {
    const decide = fakeDecision(() => new Error('timeout'));
    const { judge, llmCalls, logs } = judgeWith(decide, { verdict: 'verified', evidence_node_id: SNIPPET.nodeId });
    const verdicts = await judge.checkAll([claim('c_001'), claim('c_002')]);
    assert.deepEqual(verdicts.map((v) => v.status), ['verified', 'verified']);
    assert.equal(llmCalls(), 2);
    assert.ok(logs.some((l) => /decision model provider=fake failed — LLM judge for claims=2/.test(l)));
  });

  it('falls back to the LLM only for a claim whose answers are missing', async () => {
    const decide = fakeDecision(() => ({
      c0_verdict: choice('verified', 0.95),
      c0_evidence: choice('e1', 0.9),
      c1_verdict: choice('verified', 0.95),
    }));
    const { judge, llmCalls } = judgeWith(decide, { verdict: 'verified', evidence_node_id: SNIPPET.nodeId });
    const verdicts = await judge.checkAll([claim('c_001'), claim('c_002')]);
    assert.deepEqual(verdicts.map((v) => v.status), ['verified', 'verified']);
    assert.equal(llmCalls(), 1);
  });

  it('uses the LLM without decideAll, without a provider, or when the lookup throws', async () => {
    const single: DecisionModelService = { provider: 's', choose: async () => ({ choice: 'x', confidence: 1 }) };
    for (const lookup of [() => single, () => undefined, () => { throw new Error('undeclared'); }]) {
      const { llm, calls } = stubLlm({ verdict: 'verified', evidence_node_id: SNIPPET.nodeId });
      const judge = new EvidenceJudge({ llm, fetcher: fetcher([SNIPPET]), log: () => {}, decide: lookup });
      const [r] = await judge.checkAll([claim('c_001')]);
      assert.equal(r?.status, 'verified');
      assert.equal(calls(), 1);
    }
  });

  it('keeps no-evidence and fetch-failure verdicts without asking anyone', async () => {
    const decide = fakeDecision(() => ({}));
    const { llm, calls } = stubLlm({ verdict: 'verified' });
    const failing: EvidenceFetcher = { fetch: async () => { throw new Error('down'); } };
    const judge = new EvidenceJudge({ llm, fetcher: failing, log: () => {}, decide: () => decide });
    const [r] = await judge.checkAll([claim('c_001')]);
    assert.equal(r?.status === 'unverified' ? r.cause : '', 'check_failed');
    assert.equal(decide.requests.length, 0);
    assert.equal(calls(), 0);
  });

  it('behind the shield: sends placeholders only, and never confirms a contradiction', async () => {
    const privacy = {
      wireUserMessage: '',
      wireAnswer: '',
      admitWireView: async () => {},
      // contract: identityValues (node ids, names) are always replaced
      projectForWire: async (text: string, identityValues: readonly string[]) =>
        identityValues
          .reduce((t, v, i) => t.split(v).join(`[ID_${String(i + 1)}]`), text)
          .split('John Doe')
          .join('[PERSON_1]'),
      restore: async (text: string) => text.split('[PERSON_1]').join('John Doe'),
    } as unknown as VerifierPrivacy;
    const decide = fakeDecision(() => ({ c0_verdict: choice('contradicted', 0.99), c0_evidence: choice('e1', 0.9) }));
    const { judge, llmCalls } = judgeWith(decide, { verdict: 'contradicted', evidence_node_id: 'ev-1' });
    const [r] = await judge.checkAll([claim('c_001')], privacy);
    assert.equal(r?.status === 'unverified' ? r.cause : '', 'contradiction_unconfirmed');
    assert.equal(llmCalls(), 0);
    const wire = JSON.stringify(decide.requests);
    assert.ok(!wire.includes('John Doe'), wire);
    assert.ok(!wire.includes('person:john-doe'), 'node ids never leave behind the shield');
  });
});

describe('verifier_decision_model kill switch', () => {
  async function judgeDecide(config: Record<string, unknown>): Promise<unknown> {
    let bundle: VerifierBundle | undefined;
    const ctx = {
      agentId: '@omadia/verifier',
      config: { get: (key: string) => config[key] },
      secrets: { get: async () => 'sk-test' },
      services: {
        get: (name: string) => (name === 'knowledgeGraph' ? {} : undefined),
        getOptional: () => undefined,
        provide: (name: string, value: unknown) => {
          if (name === 'verifier') bundle = value as VerifierBundle;
          return () => {};
        },
      },
      log: () => undefined,
    } as unknown as PluginContext;
    await activate(ctx);
    assert.ok(bundle);
    return (bundle.pipeline as unknown as { judge: { decide?: unknown } }).judge.decide;
  }

  it('wires the decision model by default and drops it for an explicit false', async () => {
    assert.equal(typeof (await judgeDecide({ verifier_enabled: 'true' })), 'function');
    assert.equal(await judgeDecide({ verifier_enabled: 'true', verifier_decision_model: false }), undefined);
    assert.equal(await judgeDecide({ verifier_enabled: 'true', verifier_decision_model: 'false' }), undefined);
  });

  it('the manifest declares decisionModel@1 and the switch (boolean, default on)', () => {
    const manifest = YAML.parse(
      readFileSync(new URL('../packages/harness-verifier/manifest.yaml', import.meta.url), 'utf8'),
    ) as {
      optional_requires: string[];
      setup: { fields: Array<{ key: string; type: string; default?: string; label: Record<string, string>; help: Record<string, string> }> };
    };
    assert.ok(manifest.optional_requires.includes('decisionModel@1'));
    const field = manifest.setup.fields.find((f) => f.key === 'verifier_decision_model');
    assert.ok(field);
    assert.equal(field.type, 'boolean');
    assert.equal(field.default, 'true');
    assert.ok(field.label['en'] && field.label['de'] && field.help['en'] && field.help['de']);
  });
});
