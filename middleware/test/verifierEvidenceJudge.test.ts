import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  EvidenceJudge,
  type EvidenceFetcher,
  type EvidenceSnippet,
  type SoftClaim,
  type VerifierPrivacy,
} from '@omadia/verifier';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';

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
    // The check ran and found nothing: not a failed check.
    assert.equal(verdict.status === 'unverified' ? verdict.cause : 'n/a', undefined);
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
    assert.equal(verdict.status === 'unverified' ? verdict.cause : 'n/a', 'check_failed');
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
    assert.equal(verdict.status === 'unverified' ? verdict.cause : 'n/a', 'check_failed');
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
      assert.equal(verdict.cause, undefined, 'an inconclusive judge is not a failed check');
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

// With a privacy view the judge's request is projected through the turn's
// surrogate map: CLAIM, CONTEXT and EVIDENCE share one map, so the same person
// becomes the same placeholder everywhere and the comparison still works.
describe('verifier/evidenceJudge - privacy view', () => {
  const REAL_NAME = 'Anna Müller';
  const REAL_MAIL = 'anna.mueller@firma.example';
  const EVIDENCE: EvidenceSnippet = {
    nodeId: 'odoo:hr.employee:7',
    source: 'graph',
    title: REAL_NAME,
    content: `Graph-Node odoo:hr.employee:7 — ${REAL_NAME} (department=IT, work_email=${REAL_MAIL})`,
    identityValues: [REAL_NAME, REAL_MAIL],
  };
  const CLAIM = makeSoftClaim({
    text: 'in die IT-Abteilung',
    context: `${REAL_NAME} wechselte in die IT-Abteilung.`,
    relatedEntities: ['odoo:hr.employee:7'],
  });

  function capturingJudge(
    reply: (prompt: string) => RecordedVerdict,
  ): { llm: unknown; prompts: string[] } {
    const prompts: string[] = [];
    const provider = {
      complete(req: { messages: Array<{ content: unknown }> }): Promise<{ content: unknown[] }> {
        const first = req.messages[0]?.content;
        const text = Array.isArray(first)
          ? first.map((p) => (p as { text?: string }).text ?? '').join('')
          : String(first);
        prompts.push(text);
        return Promise.resolve({
          content: [
            { type: 'tool_call', name: 'record_verdict', id: 'toolu_x', input: reply(text) },
          ],
        });
      },
    };
    return { llm: provider, prompts };
  }

  /** A privacy view over the REAL privacy-guard service — one turn map. */
  function servicePrivacy(maskUserPrompt: boolean): VerifierPrivacy {
    const service = createPrivacyGuardService({
      readConfig: (key: string) =>
        key === 'mask_user_prompt' && maskUserPrompt ? 'on' : undefined,
    });
    const turn = { sessionId: 's-judge', turnId: 't-judge' };
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

  it('masks CLAIM, CONTEXT and EVIDENCE through one map even with prompt masking off', async () => {
    const { llm, prompts } = capturingJudge(() => ({ verdict: 'unverified' }));
    const judge = new EvidenceJudge({ llm: llm as never, fetcher: stubFetcher([EVIDENCE]) });
    await judge.check(CLAIM, servicePrivacy(false));
    assert.equal(prompts.length, 1);
    assert.deepEqual(findIdentityLeaks(prompts[0], [REAL_NAME, REAL_MAIL]), []);
    // The same person is the same placeholder in the context and the evidence.
    const person = /CONTEXT: (PLATZHALTER-NAME-\d+) wechselte/.exec(prompts[0]!)?.[1];
    assert.ok(person, `expected a placeholder in CONTEXT, got ${prompts[0]}`);
    assert.ok(prompts[0]!.includes(`title=${person}]`));
    assert.ok(prompts[0]!.includes(`— ${person} (department=IT`));
    // The citation is a handle; the node id itself stays in the process.
    assert.match(prompts[0]!, /nodeId=ev-1,/);
    assert.ok(!prompts[0]!.includes('odoo:hr.employee:7'));
  });

  it('a claim about a masked entity verifies against evidence masked through the same map', async () => {
    const { llm } = capturingJudge((prompt) => {
      // The judge only ever sees placeholders — it can still link the
      // claim's subject to the evidence node because both carry the SAME one.
      const subject = /CONTEXT: (PLATZHALTER-NAME-\d+) wechselte/.exec(prompt)?.[1];
      const evidenceSubject = /— (PLATZHALTER-NAME-\d+) \(department=IT/.exec(prompt)?.[1];
      return subject !== undefined && subject === evidenceSubject
        ? { verdict: 'verified', evidence_node_id: 'ev-1', rationale: `${subject} ist in der IT.` }
        : { verdict: 'unverified', rationale: 'placeholders differ' };
    });
    const judge = new EvidenceJudge({ llm: llm as never, fetcher: stubFetcher([EVIDENCE]) });
    const verdict = await judge.check(CLAIM, servicePrivacy(false));
    assert.equal(verdict.status, 'verified');
  });

  it('restores the rationale into the unverified reason', async () => {
    const { llm } = capturingJudge((prompt) => {
      const placeholder = /PLATZHALTER-NAME-\d+/.exec(prompt)?.[0] ?? 'nobody';
      return { verdict: 'unverified', rationale: `Evidenz zu ${placeholder} nennt kein Datum.` };
    });
    const judge = new EvidenceJudge({ llm: llm as never, fetcher: stubFetcher([EVIDENCE]) });
    const verdict = await judge.check(CLAIM, servicePrivacy(false));
    assert.equal(verdict.status, 'unverified');
    if (verdict.status === 'unverified') {
      assert.equal(verdict.reason, `Evidenz zu ${REAL_NAME} nennt kein Datum.`);
    }
  });

  it('restores truth and detail of a confirmed contradiction the projection left untouched', async () => {
    // Evidence without identity data (and no node id in its text): the
    // projection changes nothing, so a contradiction is as trustworthy as
    // without the shield — its rationale still passes through restore before
    // it becomes truth/detail.
    const plain: EvidenceSnippet = {
      nodeId: 'odoo:res.company:1',
      source: 'graph',
      content: 'employees=48',
    };
    const view: VerifierPrivacy = {
      wireUserMessage: '',
      wireAnswer: '',
      admitWireView: async () => undefined,
      projectForWire: async (t) => t,
      restore: async (t) => t.split('PLATZHALTER-NAME-9').join('Firma'),
    };
    const { llm, prompts } = capturingJudge(() => ({
      verdict: 'contradicted',
      evidence_node_id: 'ev-1',
      rationale: 'PLATZHALTER-NAME-9 hat 48 Mitarbeitende, nicht 50.',
    }));
    const judge = new EvidenceJudge({ llm: llm as never, fetcher: stubFetcher([plain]) });
    const verdict = await judge.check(
      makeSoftClaim({ text: 'Die Firma hat 50 Mitarbeitende', relatedEntities: [] }),
      view,
    );
    assert.equal(prompts.length, 2, 'an unaltered contradiction is double-checked as before');
    assert.equal(verdict.status, 'contradicted');
    if (verdict.status === 'contradicted') {
      assert.equal(verdict.truth, 'Firma hat 48 Mitarbeitende, nicht 50.');
      assert.equal(verdict.detail, 'Firma hat 48 Mitarbeitende, nicht 50.');
    }
  });

  it('never confirms a contradiction judged on placeholders', async () => {
    const { llm, prompts } = capturingJudge(() => ({
      verdict: 'contradicted',
      evidence_node_id: 'ev-1',
      rationale: 'widerspricht',
    }));
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([EVIDENCE]),
      log: () => undefined,
    });
    const verdict = await judge.check(CLAIM, servicePrivacy(false));
    assert.equal(verdict.status, 'unverified');
    assert.equal(prompts.length, 1, 'no second request for a contradiction that cannot block');
  });

  it('blocked projection yields unverified without any model request', async () => {
    const { llm, prompts } = capturingJudge(() => ({ verdict: 'verified' }));
    const logs: string[] = [];
    const judge = new EvidenceJudge({
      llm: llm as never,
      fetcher: stubFetcher([EVIDENCE]),
      log: (m: string) => {
        logs.push(m);
      },
    });
    const view: VerifierPrivacy = {
      wireUserMessage: '',
      wireAnswer: '',
      admitWireView: async () => {
        throw new Error('blocked');
      },
      projectForWire: async () => {
        throw new Error('blocked');
      },
      restore: async (t) => t,
    };
    const verdict = await judge.check(CLAIM, view);
    assert.equal(verdict.status, 'unverified');
    assert.equal(prompts.length, 0);
    assert.ok(logs.some((l) => l.includes('prompt masking blocked')));
  });

  it('names a snippet by its handle, never by a node id that embeds an identity value', async () => {
    // Ids of ingested records can carry an external key or a channel user id.
    const nodeId = `mcp:contacts:${REAL_MAIL}`;
    const keyed: EvidenceSnippet = {
      nodeId,
      source: 'odoo',
      title: REAL_NAME,
      content: `Graph-Node ${nodeId} — ${REAL_NAME} (department=IT)`,
      identityValues: [REAL_NAME],
    };
    const { llm, prompts } = capturingJudge((prompt) => ({
      verdict: 'verified',
      // The judge can only cite the id it was shown.
      evidence_node_id: /nodeId=([^,\]]+)/.exec(prompt)?.[1] ?? 'missing',
      rationale: 'passt',
    }));
    const judge = new EvidenceJudge({ llm: llm as never, fetcher: stubFetcher([keyed]) });
    const verdict = await judge.check(CLAIM, servicePrivacy(false));
    assert.equal(prompts.length, 1);
    assert.deepEqual(findIdentityLeaks(prompts[0], [REAL_NAME, REAL_MAIL, nodeId]), []);
    assert.match(prompts[0]!, /nodeId=ev-1,/);
    assert.equal(verdict.status, 'verified');
    // Resolved through the handle: the snippet's source, not the claim's
    // expected source ('graph') a failed lookup falls back to.
    if (verdict.status === 'verified') assert.equal(verdict.source, 'odoo');
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
