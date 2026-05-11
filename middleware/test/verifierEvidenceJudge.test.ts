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

function stubAnthropic(sequence: RecordedVerdict[]): {
  anthropic: unknown;
  callCount: () => number;
} {
  let i = 0;
  const client = {
    messages: {
      create(): Promise<{ content: unknown[] }> {
        const v = sequence[i] ?? sequence[sequence.length - 1];
        i += 1;
        return Promise.resolve({
          content: [
            {
              type: 'tool_use',
              name: 'record_verdict',
              id: 'toolu_x',
              input: v,
            },
          ],
        });
      },
    },
  };
  return {
    anthropic: client,
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
    text: 'Marcel Wege ist Senior Developer bei byte5',
    type: 'qualitative',
    expectedSource: 'graph',
    relatedEntities: ['person:marcel-wege'],
    ...overrides,
  } as SoftClaim;
}

const SNIPPET: EvidenceSnippet = {
  nodeId: 'person:marcel-wege',
  source: 'graph',
  content: 'Marcel Wege, Senior Dev bei byte5, seit 2020.',
  title: 'Marcel Wege',
};

// --- Tests ---------------------------------------------------------------

describe('verifier/evidenceJudge', () => {
  it('returns unverified when no evidence is found', async () => {
    const { anthropic } = stubAnthropic([{ verdict: 'verified' }]);
    const judge = new EvidenceJudge({
      anthropic: anthropic as never,
      fetcher: stubFetcher([]),
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('verifies when judge says verified with node id', async () => {
    const { anthropic, callCount } = stubAnthropic([
      { verdict: 'verified', evidence_node_id: 'person:marcel-wege' },
    ]);
    const judge = new EvidenceJudge({
      anthropic: anthropic as never,
      fetcher: stubFetcher([SNIPPET]),
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'verified');
    assert.equal(callCount(), 1);
  });

  it('downgrades "verified" without node id to unverified', async () => {
    const { anthropic } = stubAnthropic([{ verdict: 'verified' }]);
    const judge = new EvidenceJudge({
      anthropic: anthropic as never,
      fetcher: stubFetcher([SNIPPET]),
      log: (): void => {
        /* silent */
      },
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('confirms contradiction only when second judge call agrees', async () => {
    const { anthropic, callCount } = stubAnthropic([
      { verdict: 'contradicted', evidence_node_id: 'person:marcel-wege', rationale: 'not senior' },
      { verdict: 'contradicted', evidence_node_id: 'person:marcel-wege', rationale: 'not senior' },
    ]);
    const judge = new EvidenceJudge({
      anthropic: anthropic as never,
      fetcher: stubFetcher([SNIPPET]),
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'contradicted');
    assert.equal(callCount(), 2);
  });

  it('downgrades flaky contradiction to unverified when recheck disagrees', async () => {
    const { anthropic, callCount } = stubAnthropic([
      { verdict: 'contradicted', evidence_node_id: 'person:marcel-wege' },
      { verdict: 'unverified' },
    ]);
    const judge = new EvidenceJudge({
      anthropic: anthropic as never,
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
      messages: {
        create(): Promise<unknown> {
          return Promise.reject(new Error('rate limit'));
        },
      },
    };
    const judge = new EvidenceJudge({
      anthropic: client as never,
      fetcher: stubFetcher([SNIPPET]),
      log: (): void => {
        /* silent */
      },
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('returns unverified when fetcher throws', async () => {
    const { anthropic } = stubAnthropic([{ verdict: 'verified' }]);
    const fetcher: EvidenceFetcher = {
      fetch(): Promise<EvidenceSnippet[]> {
        return Promise.reject(new Error('graph down'));
      },
    };
    const judge = new EvidenceJudge({
      anthropic: anthropic as never,
      fetcher,
      log: (): void => {
        /* silent */
      },
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
  });

  it('handles unverified verdict from judge', async () => {
    const { anthropic } = stubAnthropic([
      { verdict: 'unverified', rationale: 'evidence silent' },
    ]);
    const judge = new EvidenceJudge({
      anthropic: anthropic as never,
      fetcher: stubFetcher([SNIPPET]),
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.match(verdict.reason, /silent/);
    }
  });
});
