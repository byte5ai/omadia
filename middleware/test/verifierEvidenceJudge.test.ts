import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  EvidenceJudge,
  type EvidenceFetcher,
  type EvidenceSnippet,
  type SoftClaim,
} from '@omadia/verifier';

// --- Stubs ---------------------------------------------------------------

interface RecordedVerdict {
  verdict: 'verified' | 'unverified' | 'contradicted';
  evidence_node_id?: string;
  rationale?: string;
}

function stubProvider(sequence: RecordedVerdict[]): {
  llm: unknown;
  callCount: () => number;
} {
  let i = 0;
  const provider = {
    complete(): Promise<{ content: unknown[] }> {
      const v = sequence[i] ?? sequence[sequence.length - 1];
      i += 1;
      return Promise.resolve({
        content: [
          {
            type: 'tool_call',
            name: 'record_verdict',
            id: 'toolu_x',
            input: v,
          },
        ],
      });
    },
  };
  return {
    llm: provider,
    callCount: () => i,
  };
}

function stubFetcher(snippets: EvidenceSnippet[]): EvidenceFetcher {
  return {
    fetch(): Promise<EvidenceSnippet[]> {
      return Promise.resolve(snippets);
    },
  };
}

function makeSoftClaim(overrides: Partial<SoftClaim> = {}): SoftClaim {
  return {
    id: 'c_001',
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

// --- Tests ---------------------------------------------------------------

describe('verifier/evidenceJudge', () => {
  it('returns unverified when no evidence is found', async () => {
    const { llm } = stubProvider([{ verdict: 'verified' }]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([]),
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('verifies when judge says verified with node id', async () => {
    const { llm, callCount } = stubProvider([
      { verdict: 'verified', evidence_node_id: 'person:john-doe' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'verified');
    assert.equal(callCount(), 1);
  });

  it('downgrades "verified" without node id to unverified', async () => {
    const { llm } = stubProvider([{ verdict: 'verified' }]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
      log: (): void => {
        /* silent */
      },
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('confirms contradiction only when second judge call agrees', async () => {
    const { llm, callCount } = stubProvider([
      { verdict: 'contradicted', evidence_node_id: 'person:john-doe', rationale: 'not senior' },
      { verdict: 'contradicted', evidence_node_id: 'person:john-doe', rationale: 'not senior' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'contradicted');
    assert.equal(callCount(), 2);
  });

  it('downgrades flaky contradiction to unverified when recheck disagrees', async () => {
    const { llm, callCount } = stubProvider([
      { verdict: 'contradicted', evidence_node_id: 'person:john-doe' },
      { verdict: 'unverified' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
      log: (): void => {
        /* silent */
      },
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
    assert.equal(callCount(), 2);
  });

  it('returns unverified when API call fails', async () => {
    const client = {
      complete(): Promise<unknown> {
        return Promise.reject(new Error('rate limit'));
      },
    };
    const judge = new EvidenceJudge({
      llm: client as never,
      fetcher: stubFetcher([SNIPPET]),
      log: (): void => {
        /* silent */
      },
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('returns unverified when fetcher throws', async () => {
    const { llm } = stubProvider([{ verdict: 'verified' }]);
    const fetcher: EvidenceFetcher = {
      fetch(): Promise<EvidenceSnippet[]> {
        return Promise.reject(new Error('graph down'));
      },
    };
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher,
      log: (): void => {
        /* silent */
      },
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('handles unverified verdict from judge', async () => {
    const { llm } = stubProvider([
      { verdict: 'unverified', rationale: 'evidence silent' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.match(verdict.reason, /silent/);
    }
  });
});

// #129 golden flake `blocked_contradiction_role`: the extractor sometimes
// emits a subject-less fragment ("in die IT-Abteilung") as the qualitative
// claim. The judge deliberately never sees the answer, so it cannot know who
// moved where → `unverified`. `claim.context` (the enclosing sentence, cut
// deterministically by the extractor) restores the subject without leaking
// the whole answer.
describe('verifier/evidenceJudge - claim context', () => {
  function capturingProvider(v: RecordedVerdict): { llm: unknown; prompts: string[] } {
    const prompts: string[] = [];
    const provider = {
      complete(req: { messages: Array<{ content: unknown }> }): Promise<{ content: unknown[] }> {
        const first = req.messages[0]?.content;
        const text = Array.isArray(first)
          ? first.map((p) => (p as { text?: string }).text ?? '').join('')
          : String(first);
        prompts.push(text);
        return Promise.resolve({
          content: [{ type: 'tool_call', name: 'record_verdict', id: 'toolu_x', input: v }],
        });
      },
    };
    return { llm: provider, prompts };
  }

  it('passes the enclosing sentence as CONTEXT when the claim carries one', async () => {
    const { llm, prompts } = capturingProvider({ verdict: 'unverified' });
    const judge = new EvidenceJudge({ llm: llm as never, fetcher: stubFetcher([SNIPPET]) });
    await judge.check(
      makeSoftClaim({
        text: 'in die IT-Abteilung',
        context: 'Anna Müller wechselte am 01.03.2023 in die IT-Abteilung.',
      }),
    );
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /CLAIM: in die IT-Abteilung/);
    assert.match(prompts[0]!, /CONTEXT: Anna Müller wechselte am 01\.03\.2023 in die IT-Abteilung\./);
  });

  it('omits CONTEXT when the claim has none or it equals the claim text', async () => {
    const { llm, prompts } = capturingProvider({ verdict: 'unverified' });
    const judge = new EvidenceJudge({ llm: llm as never, fetcher: stubFetcher([SNIPPET]) });
    await judge.check(makeSoftClaim());
    await judge.check(makeSoftClaim({ context: 'John Doe ist Senior Developer bei byte5' }));
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0]!, /CONTEXT:/);
    assert.doesNotMatch(prompts[1]!, /CONTEXT:/);
  });
});
