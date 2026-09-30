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

/** Returns the same verdict on every call and records each user prompt. */
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

function silentLog(): void {
  /* silent */
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

// A verdict counts only with a citation the judge was actually shown. The
// `record_verdict` input is model output: any string can come back as
// `evidence_node_id`, so the judge checks it against the snippets it passed to
// that very call. An id outside that set is treated like a missing one.
describe('verifier/evidenceJudge - cited evidence id must be in the evidence set', () => {
  const INVOICE_SNIPPET: EvidenceSnippet = {
    nodeId: 'odoo-inv-42',
    source: 'odoo',
    content: 'INV/2026/0042, Kunde Beispiel GmbH, offen.',
  };

  it('demotes "verified" citing an evidence id the judge was never shown', async () => {
    const { llm, callCount } = stubProvider([
      { verdict: 'verified', evidence_node_id: 'person:ghost' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
      log: silentLog,
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.match(verdict.reason, /evidence set/);
    }
    assert.equal(callCount(), 1);
  });

  it('demotes "contradicted" citing an unknown evidence id without spending a recheck call', async () => {
    const { llm, callCount } = stubProvider([
      { verdict: 'contradicted', evidence_node_id: 'person:ghost', rationale: 'not senior' },
      { verdict: 'contradicted', evidence_node_id: 'person:ghost' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
      log: silentLog,
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.match(verdict.reason, /evidence set/);
    }
    assert.equal(callCount(), 1);
  });

  it('a recheck that cites an unknown id does not confirm the contradiction', async () => {
    const { llm, callCount } = stubProvider([
      { verdict: 'contradicted', evidence_node_id: 'person:john-doe', rationale: 'not senior' },
      { verdict: 'contradicted', evidence_node_id: 'person:ghost', rationale: 'not senior' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
      log: silentLog,
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.match(verdict.reason, /not reproduced/);
    }
    assert.equal(callCount(), 2);
  });

  it('tolerates whitespace around a known id, but not a case difference', async () => {
    const padded = stubProvider([
      { verdict: 'verified', evidence_node_id: '  person:john-doe ' },
    ]);
    const paddedVerdict = await new EvidenceJudge({
      llm: padded.llm as never,
      fetcher: stubFetcher([SNIPPET]),
    }).check(makeSoftClaim());
    assert.equal(paddedVerdict.status, 'verified');

    // Ids are opaque: two distinct nodes may differ only in case.
    const upper = stubProvider([
      { verdict: 'verified', evidence_node_id: 'PERSON:JOHN-DOE' },
    ]);
    const upperVerdict = await new EvidenceJudge({
      llm: upper.llm as never,
      fetcher: stubFetcher([SNIPPET]),
      log: silentLog,
    }).check(makeSoftClaim());
    assert.equal(upperVerdict.status, 'unverified');
  });

  it('ignores a stray evidence_node_id on an unverified verdict', async () => {
    const { llm } = stubProvider([
      { verdict: 'unverified', evidence_node_id: 'person:ghost', rationale: 'evidence silent' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
      log: silentLog,
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.match(verdict.reason, /silent/);
    }
  });

  // The cited id is model output: it can repeat whatever the judge was shown
  // (claim text, evidence content) or carry characters that break or disguise
  // a log line. The line names the claim id and the cited id's length only.
  const REJECTED_CITATIONS: ReadonlyArray<readonly [string, string]> = [
    ['an id-shaped unknown id', 'person:jane-doe'],
    ['a line feed', 'person:ghost\n[verifier/judge] forged line'],
    ['a carriage return', 'person:ghost\r[verifier/judge] forged line'],
    ['U+2028 LINE SEPARATOR', 'person:ghost\u2028[verifier/judge] forged line'],
    ['U+2029 PARAGRAPH SEPARATOR', 'person:ghost\u2029[verifier/judge] forged line'],
    ['ANSI escape sequences', 'person:ghost\u001b[2K\u001b[31mforged\u001b[0m'],
    ['a bidi override', 'person:ghost\u202eenil degrof'],
    ['the claim text, echoed back', makeSoftClaim().text],
    ['evidence content, echoed back', SNIPPET.content],
  ];
  const LOG_BREAKERS = ['\n', '\r', '\u2028', '\u2029', '\u001b', '\u202e'];

  for (const [label, cited] of REJECTED_CITATIONS) {
    it(`logs a rejected citation by length only: ${label}`, async () => {
      const { llm } = stubProvider([{ verdict: 'verified', evidence_node_id: cited }]);
      const logs: string[] = [];
      const judge = new EvidenceJudge({
        llm: llm as never,
        fetcher: stubFetcher([SNIPPET]),
        log: (msg: string): void => {
          logs.push(msg);
        },
      });
      const claim = makeSoftClaim();
      const verdict = await judge.check(claim);
      assert.equal(verdict.status, 'unverified');
      if (verdict.status === 'unverified') {
        assert.equal(verdict.reason, 'evidence_node_id not in evidence set');
      }
      assert.equal(logs.length, 1);
      const line = logs[0]!;
      for (const ch of LOG_BREAKERS) {
        const code = ch.codePointAt(0)!.toString(16).padStart(4, '0');
        assert.ok(!line.includes(ch), `U+${code} from the cited id reached the log line`);
      }
      assert.ok(!line.includes(cited), 'the cited id must not be logged');
      assert.ok(!line.includes(claim.text), 'the claim text must not be logged');
      assert.equal(
        line,
        `[verifier/judge] evidence_node_id not in evidence set, downgrading to unverified claim=c_001 cited_len=${String(cited.length)}`,
      );
    });
  }

  it('takes the source of a verified verdict from the cited snippet, not the claim', async () => {
    const { llm } = stubProvider([
      { verdict: 'verified', evidence_node_id: 'person:john-doe' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
    });
    const verdict = await judge.check(makeSoftClaim({ expectedSource: 'odoo' }));
    assert.equal(verdict.status, 'verified');
    if (verdict.status === 'verified') {
      assert.equal(verdict.source, SNIPPET.source);
    }
  });

  it('records the cited snippet as source and truth of a confirmed contradiction', async () => {
    const { llm, callCount } = stubProvider([
      { verdict: 'contradicted', evidence_node_id: 'person:john-doe' },
      { verdict: 'contradicted', evidence_node_id: 'person:john-doe' },
    ]);
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET]),
    });
    const verdict = await judge.check(makeSoftClaim({ expectedSource: 'odoo' }));
    assert.equal(verdict.status, 'contradicted');
    if (verdict.status === 'contradicted') {
      assert.equal(verdict.source, SNIPPET.source);
      assert.equal(verdict.truth, SNIPPET.content);
    }
    assert.equal(callCount(), 2);
  });

  it('accepts exactly the ids printed in the judge prompt', async () => {
    const { llm, prompts } = capturingProvider({
      verdict: 'verified',
      evidence_node_id: 'odoo-inv-42',
    });
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([SNIPPET, INVOICE_SNIPPET]),
    });
    const verdict = await judge.check(makeSoftClaim());
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /\[nodeId=person:john-doe, source=graph/);
    assert.match(prompts[0]!, /\[nodeId=odoo-inv-42, source=odoo/);
    assert.equal(verdict.status, 'verified');
    if (verdict.status === 'verified') {
      assert.equal(verdict.source, 'odoo');
    }
  });
});
