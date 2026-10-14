/**
 * The claim extractor's repair attempt against the REAL Orchestrator, the
 * REAL privacy-guard service and the REAL verifier pipeline: the repair is a
 * request of its own — admitted through the turn's privacy view, booked in
 * the turn's one receipt (`verifierEgress.requests`), placeholders only on
 * the wire — and it re-runs neither the agent's turn nor any tool.
 *
 * Only the two models are scripted: the turn's (it answers once with an
 * accounting reference, so the verifier triggers) and the verifier's (its
 * first `record_claims` call carries no claims array, as in production on
 * 2026-10-08). Built packages throughout, like the end-to-end egress suite
 * (`verifierPrivacyEgressEndToEnd.test.ts`). All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { VerifierService } from '@omadia/orchestrator';
import type { TurnReceiptRecordInput } from '@omadia/plugin-api';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';
import {
  ClaimExtractor,
  DeterministicChecker,
  EvidenceJudge,
  VerifierPipeline,
  type EvidenceSnippet,
} from '@omadia/verifier';

import {
  RAW_EMAIL,
  buildOrch,
  countingService,
  echoingProvider,
} from './_helpers/privacyEgressHarness.js';

const REAL_NAME = 'Jana Beispielfrau';
const ASK = `Schick die Rechnung an ${RAW_EMAIL} bitte`;
const invoiceReply = (email: string): string => `Rechnung INV/2026/0042 geht an ${email} heute`;

const EVIDENCE: EvidenceSnippet = {
  nodeId: 'odoo:res.partner:7',
  source: 'graph',
  title: REAL_NAME,
  content: `Graph-Node odoo:res.partner:7 — ${REAL_NAME} (email=${RAW_EMAIL}, customer_rank=1)`,
  identityValues: [REAL_NAME, RAW_EMAIL],
};

/** The verifier's model: the first `unusable` record_claims calls carry no
 *  claims array, later ones extract the answer's sentence; the judge
 *  verifies. Records every request as sent. */
function verifierLlm(requests: string[], unusable: number): LlmProvider {
  let extractions = 0;
  return {
    id: 'anthropic',
    complete: (req: LlmRequest): Promise<LlmResponse> => {
      const serialized = JSON.stringify(req);
      requests.push(serialized);
      const tool = (req.tools ?? [])[0]?.name;
      let input: unknown;
      if (tool === 'record_claims') {
        extractions += 1;
        const sentence = /Rechnung INV\/2026\/0042 geht an \S+ heute/.exec(
          serialized.split('ASSISTANT ANSWER:')[1] ?? '',
        )?.[0];
        input =
          extractions <= unusable
            ? {}
            : {
                claims: [
                  {
                    text: sentence ?? 'missing',
                    type: 'qualitative',
                    expected_source: 'graph',
                    related_entities: ['odoo:res.partner:7'],
                  },
                ],
              };
      } else {
        input = { verdict: 'verified', evidence_node_id: 'ev-1', rationale: 'passt' };
      }
      return Promise.resolve({
        content: [{ type: 'tool_call', id: 'toolu_x', name: tool ?? 'none', input }],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'claude-haiku-4-5-20251001',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      } as unknown as LlmResponse);
    },
  } as unknown as LlmProvider;
}

function wired(opts: { unusable: number; mode: 'shadow' | 'enforce' }) {
  const verifierRequests: string[] = [];
  const turnRequests: string[] = [];
  const recorded: TurnReceiptRecordInput[] = [];
  const { service } = countingService(true);
  const orch = buildOrch({ service, provider: echoingProvider(turnRequests, invoiceReply), recorded });
  const llm = verifierLlm(verifierRequests, opts.unusable);
  const pipeline = new VerifierPipeline({
    extractor: new ClaimExtractor({ llm, log: () => undefined }),
    deterministic: new DeterministicChecker({ log: () => undefined }),
    judge: new EvidenceJudge({ llm, fetcher: { fetch: () => Promise.resolve([EVIDENCE]) }, log: () => undefined }),
    log: () => undefined,
  });
  const agent = new VerifierService({
    orchestrator: orch,
    pipeline,
    enabled: true,
    mode: opts.mode,
    log: () => undefined,
  });
  return { agent, verifierRequests, turnRequests, recorded };
}

describe('the extractor repair under the turn’s privacy policy', () => {
  it('is admitted and booked as a request of its own; the turn runs once', async () => {
    const { agent, verifierRequests, turnRequests, recorded } = wired({ unusable: 1, mode: 'shadow' });

    const answer = await agent.chat({ userMessage: ASK, sessionScope: 'sess-repair-1' });

    // Extraction, its one repair, then the judge for the repaired claim.
    assert.equal(verifierRequests.length, 3, 'extraction + repair + judge');
    assert.match(verifierRequests[1]!, /REPAIR: your previous record_claims call had no claims array/);
    assert.doesNotMatch(verifierRequests[0]!, /REPAIR/);
    // The repair re-sends the same wire view — placeholders, never the real values.
    assert.equal(
      verifierRequests[1]!.split('ASSISTANT ANSWER:')[1],
      verifierRequests[0]!.split('ASSISTANT ANSWER:')[1],
    );
    for (const request of verifierRequests) {
      assert.deepEqual(findIdentityLeaks(request, [RAW_EMAIL, REAL_NAME]), []);
    }
    // One receipt covers the turn and every verifier request — the repair included.
    assert.equal(answer.privacyReceipt?.verifierEgress?.requests, 3);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]!.receipt, answer.privacyReceipt);
    // No agent re-run: the turn's own model was asked once.
    assert.equal(turnRequests.length, 1, 'the turn model ran once');
    assert.ok(answer.text.includes(RAW_EMAIL), 'the user still gets the real values');
  });

  it('two unusable extractions: unavailable, both booked, a technical fault — not a contradiction', async () => {
    const { agent, verifierRequests, turnRequests } = wired({ unusable: 2, mode: 'enforce' });

    const answer = await agent.chat({ userMessage: ASK, sessionScope: 'sess-repair-2' });

    assert.equal(verifierRequests.length, 2, 'extraction + one repair, no judge, no third call');
    assert.equal(answer.privacyReceipt?.verifierEgress?.requests, 2);
    assert.equal(turnRequests.length, 1, 'the turn model ran once');
    assert.equal(answer.answerSource, 'verifier-blocked');
    assert.match(answer.text, /technischen Störung/);
    assert.doesNotMatch(answer.text, /Widerspruch/);
    assert.ok(!answer.text.includes(RAW_EMAIL), 'the withheld answer stays withheld');
  });
});
