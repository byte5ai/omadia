/**
 * `[ref:…]` citation markers are the verifier's own metadata, not what the
 * answer says (`harness-verifier/src/citationMarkers.ts`).
 *
 * Live (2026-10-08) they cost real answers: a marker in the middle of a
 * sentence made a claim that quotes the sentence as the user reads it fail
 * the verbatim guard (`not_in_answer`), and a marker's id digits could fire
 * the trigger router on an answer that states no figure. Measured on
 * synthetic text (Haiku 4.5, 4 runs each): 8 claims kept from the checkers
 * with mid-sentence markers, 3 without.
 *
 * Extraction, its verbatim guard and the trigger see the answer without
 * markers; the citation check still reads them on the answer itself.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ClaimExtractor,
  EvidenceJudge,
  GraphEvidenceFetcher,
  VerifierPipeline,
  shouldTriggerVerifier,
  type Claim,
  type ClaimExtraction,
  type ClaimVerdict,
  type DeterministicChecker,
  type HardClaim,
  type SoftClaim,
  type VerifierPrivacy,
} from '@omadia/verifier';
import {
  citationAnchors,
  citedRefs,
  stripCitationMarkers,
} from '../packages/harness-verifier/src/citationMarkers.js';
import { stripCitationMarkers as channelStrip } from '../packages/harness-channel-sdk/src/citationMarkers.js';

const PARTNER_REF = 'odoo:res.partner:4711';
const TURN_REF = 'turn:talk-a:2026-10-08T09:15:00.000Z';
const ANSWER = `Die byte5 GmbH [ref:${PARTNER_REF}] sitzt in Frankfurt. Ansprechpartnerin ist Jana Beispielfrau [ref:${TURN_REF}].`;
const AS_READ = 'Die byte5 GmbH sitzt in Frankfurt. Ansprechpartnerin ist Jana Beispielfrau.';

function capturingLlm(claims: unknown[]): { llm: unknown; requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    llm: {
      complete(req: unknown): Promise<{ content: unknown[] }> {
        requests.push(req);
        return Promise.resolve({
          content: [{ type: 'tool_call', name: 'record_claims', id: 'toolu_x', input: { claims } }],
        });
      },
    },
  };
}

describe('verifier — citation markers are stripped before extraction', () => {
  it('the extraction request carries the answer as the user reads it, without markers', async () => {
    const { llm, requests } = capturingLlm([]);
    const extractor = new ClaimExtractor({ llm: llm as never, log: () => undefined });
    await extractor.extract({ userMessage: 'Wo sitzt byte5?', answer: ANSWER });
    assert.equal(requests.length, 1);
    const wire = JSON.stringify(requests[0]);
    assert.equal(wire.includes('[ref:'), false, 'a citation marker reached the extraction model');
    assert.ok(wire.includes(AS_READ), 'the answer as read reached the model');
  });

  it('keeps a faithful claim that spans a marker (was: not_in_answer)', async () => {
    const { llm } = capturingLlm([
      { text: 'Die byte5 GmbH sitzt in Frankfurt.', type: 'qualitative', expected_source: 'odoo' },
      {
        text: 'Ansprechpartnerin ist Jana Beispielfrau.',
        type: 'qualitative',
        expected_source: 'graph',
      },
    ]);
    const extractor = new ClaimExtractor({ llm: llm as never, log: () => undefined });
    const { claims, gaps } = await extractor.extract({ userMessage: 'Wo sitzt byte5?', answer: ANSWER });
    assert.deepEqual(
      claims.map((c) => c.text),
      ['Die byte5 GmbH sitzt in Frankfurt.', 'Ansprechpartnerin ist Jana Beispielfrau.'],
    );
    assert.deepEqual(gaps, [], 'no claim was kept from the checkers');
  });

  it('an answer that is only markers holds nothing to extract', async () => {
    const { llm, requests } = capturingLlm([]);
    const extractor = new ClaimExtractor({ llm: llm as never, log: () => undefined });
    const out = await extractor.extract({ userMessage: 'x', answer: `[ref:${PARTNER_REF}]` });
    assert.deepEqual(out, { claims: [], gaps: [] });
    assert.equal(requests.length, 0, 'no model call for an answer with nothing in it');
  });
});

describe('verifier — the trigger ignores a marker’s id digits', () => {
  // "insgesamt" plus any 3+ digit number fires `aggregate_keyword_with_number`;
  // the only number here is inside the marker.
  const NO_FIGURE = `Insgesamt ist das Ticket an den Support übergeben worden [ref:odoo:helpdesk.ticket:9182].`;

  it('the raw text would fire the trigger on the marker alone', () => {
    assert.equal(shouldTriggerVerifier(NO_FIGURE).shouldVerify, true);
    assert.equal(shouldTriggerVerifier(stripCitationMarkers(NO_FIGURE)).shouldVerify, false);
  });

  it('the pipeline does not extract claims from it, and the citation check still reads the marker', async () => {
    let extractions = 0;
    const pipeline = new VerifierPipeline({
      extractor: {
        extract(): Promise<ClaimExtraction> {
          extractions += 1;
          return Promise.resolve({ claims: [] as Claim[], gaps: [] });
        },
      } as never,
      deterministic: {
        checkAll: (cs: HardClaim[]): Promise<ClaimVerdict[]> =>
          Promise.resolve(cs.map((c) => ({ status: 'verified', claim: c, source: 'odoo' }) as ClaimVerdict)),
      } as unknown as DeterministicChecker,
      judge: {
        checkAll: (cs: SoftClaim[]): Promise<ClaimVerdict[]> =>
          Promise.resolve(cs.map((c) => ({ status: 'verified', claim: c, source: 'graph' }) as ClaimVerdict)),
      } as unknown as EvidenceJudge,
      log: () => undefined,
    });
    const verdict = await pipeline.verify({
      runId: 'r_marker_trigger',
      userMessage: 'Was ist mit dem Ticket?',
      answer: NO_FIGURE,
      knowledgeGraphToolsCalled: true,
    });
    assert.equal(extractions, 0, 'the marker digits fired an extraction');
    // The marker is still seen: with KG called and a marker present there is
    // no citation_missing, so nothing blocks — the answer had nothing to check.
    assert.equal(verdict.status, 'skipped');
    if (verdict.status === 'skipped') assert.equal(verdict.reason, 'no_trigger');
  });
});

/**
 * Stripping the markers took away the one place the extraction saw record
 * handles (`related_entities` such as `odoo:res.partner:42`), which pin the
 * evidence fetch to exactly the cited record. They are put back
 * deterministically, from the raw answer, to the claims of the marker's own
 * sentence — never as evidence, only as where to look.
 */
describe('verifier — a marker’s record pins the claims of its own sentence', () => {
  const q = (text: string, related?: string[]) => ({
    text,
    type: 'qualitative',
    expected_source: 'graph',
    ...(related ? { related_entities: related } : {}),
  });

  async function extracted(answer: string, claims: unknown[], privacy?: VerifierPrivacy) {
    const { llm } = capturingLlm(claims);
    const lines: string[] = [];
    const extractor = new ClaimExtractor({
      llm: llm as never,
      log: (l: string) => {
        lines.push(l);
      },
    });
    const out = await extractor.extract({ userMessage: 'Wer ist das?', answer, ...(privacy ? { privacy } : {}) });
    return { ...out, lines };
  }

  it('adds the cited record to the claim of its sentence only, and a turn ref to none', async () => {
    const { claims, gaps, lines } = await extracted(ANSWER, [
      q('Die byte5 GmbH sitzt in Frankfurt.'),
      q('Ansprechpartnerin ist Jana Beispielfrau.'),
    ]);
    assert.deepEqual(claims[0]!.relatedEntities, [PARTNER_REF]);
    assert.deepEqual(claims[1]!.relatedEntities, [], 'a turn ref pins no record');
    assert.deepEqual(gaps, []);
    assert.ok(lines.some((l) => / cited_records=1( |$)/.test(l)), lines.join(' | '));
  });

  it('a marker right after the full stop counts for the sentence it closes', async () => {
    for (const answer of [
      `Die Rechnung ging an die byte5 GmbH.[ref:${PARTNER_REF}] Sie ist bezahlt.`,
      `Die Rechnung ging an die byte5 GmbH. [ref:${PARTNER_REF}] Sie ist bezahlt.`,
    ]) {
      const { claims } = await extracted(answer, [
        q('Die Rechnung ging an die byte5 GmbH.'),
        q('Sie ist bezahlt.'),
      ]);
      assert.deepEqual(claims[0]!.relatedEntities, [PARTNER_REF], answer);
      assert.deepEqual(claims[1]!.relatedEntities, [], answer);
    }
  });

  it('whitespace between the full stop and the marker does not move it to the next sentence', async () => {
    for (const gap of ['  ', '\t ', ' \t']) {
      const answer = `Die Rechnung ging an die byte5 GmbH.${gap}[ref:${PARTNER_REF}] Sie ist bezahlt.`;
      const { claims } = await extracted(answer, [
        q('Die Rechnung ging an die byte5 GmbH.'),
        q('Sie ist bezahlt.'),
      ]);
      assert.deepEqual(claims[0]!.relatedEntities, [PARTNER_REF], JSON.stringify(gap));
      assert.deepEqual(claims[1]!.relatedEntities, [], JSON.stringify(gap));
    }
  });

  it('a marker glued to the next word cites the text before it, not that word', async () => {
    // Stripped, this reads as one sentence: "… GmbH.Sie ist bezahlt."
    const answer = `Die Rechnung ging an die byte5 GmbH. [ref:${PARTNER_REF}]Sie ist bezahlt.`;
    const { claims } = await extracted(answer, [
      q('Die Rechnung ging an die byte5 GmbH.'),
      q('Sie ist bezahlt.'),
    ]);
    assert.deepEqual(claims[0]!.relatedEntities, [PARTNER_REF]);
    assert.deepEqual(claims[1]!.relatedEntities, []);
  });

  it('a claim that starts after the marker in the same sentence is not the cited text', async () => {
    const answer = `Laut Odoo ist die byte5 GmbH [ref:${PARTNER_REF}] Kundin, Bob Meier betreut sie.`;
    const { claims } = await extracted(answer, [q('die byte5 GmbH'), q('Bob Meier betreut sie')]);
    assert.deepEqual(claims[0]!.relatedEntities, [PARTNER_REF]);
    assert.deepEqual(claims[1]!.relatedEntities, []);
  });

  it('a claim the extraction already pinned to a record keeps only its own', async () => {
    const { claims } = await extracted(ANSWER, [
      q('Die byte5 GmbH sitzt in Frankfurt.', ['odoo:res.partner:7']),
    ]);
    assert.deepEqual(claims[0]!.relatedEntities, ['odoo:res.partner:7']);
  });

  it('each line of a list is its own sentence', async () => {
    const answer = '- Anna Müller: IT [ref:odoo:hr.employee:7]\n- Bob Meier: Sales [ref:odoo:hr.employee:9]';
    const { claims } = await extracted(answer, [q('Anna Müller: IT'), q('Bob Meier: Sales')]);
    assert.deepEqual(claims[0]!.relatedEntities, ['odoo:hr.employee:7']);
    assert.deepEqual(claims[1]!.relatedEntities, ['odoo:hr.employee:9']);
  });

  it('keeps the handles the extraction returned, without duplicates', async () => {
    const { claims } = await extracted(ANSWER, [
      q('Die byte5 GmbH sitzt in Frankfurt.', [PARTNER_REF, 'odoo:hr.employee:7']),
    ]);
    assert.deepEqual(claims[0]!.relatedEntities, [PARTNER_REF, 'odoo:hr.employee:7']);
  });

  it('behind a Privacy Shield the restored claim gets the record of its real sentence', async () => {
    const REAL = 'Jana Beispielfrau';
    const FAKE = 'Erika Musterfrau';
    const real = `${REAL} leitet das Team [ref:odoo:hr.employee:7].`;
    const swap = (text: string, from: string, to: string): string => text.split(from).join(to);
    const privacy: VerifierPrivacy = {
      wireUserMessage: 'Wer leitet das Team?',
      wireAnswer: swap(real, REAL, FAKE),
      async admitWireView(): Promise<void> {},
      async projectForWire(text: string): Promise<string> {
        return swap(text, REAL, FAKE);
      },
      async restore(text: string): Promise<string> {
        return swap(text, FAKE, REAL);
      },
    };
    const { claims } = await extracted(real, [q(`${FAKE} leitet das Team.`)], privacy);
    assert.equal(claims[0]!.text, `${REAL} leitet das Team.`);
    assert.deepEqual(claims[0]!.relatedEntities, ['odoo:hr.employee:7']);
  });

  it('a cited record only says where to look: one the graph does not hold verifies nothing', async () => {
    let judgeCalls = 0;
    const judge = new EvidenceJudge({
      llm: {
        complete(): Promise<unknown> {
          judgeCalls += 1;
          return Promise.resolve({
            content: [{ type: 'tool_call', name: 'record_verdict', id: 'x', input: { verdict: 'verified' } }],
          });
        },
      } as never,
      fetcher: new GraphEvidenceFetcher({ graph: { findEntities: () => Promise.resolve([]) } as never }),
      log: () => undefined,
    });
    const claim: SoftClaim = {
      id: 'c_1',
      text: 'Die byte5 GmbH sitzt in Frankfurt.',
      type: 'qualitative',
      expectedSource: 'graph',
      relatedEntities: ['odoo:res.partner:999999'],
    };
    const verdict = await judge.check(claim);
    assert.equal(verdict.status, 'unverified');
    assert.equal(judgeCalls, 0, 'no evidence, no judgement — the handle is not evidence');
  });

  it('anchors each marker where it sat in the stripped text', () => {
    const raw = `A [ref:${PARTNER_REF}] b.[ref:x] c`;
    const asRead = stripCitationMarkers(raw);
    assert.equal(asRead, 'A b. c');
    assert.deepEqual(citationAnchors(raw), [
      { id: PARTNER_REF, at: 1 },
      { id: 'x', at: 4 },
    ]);
  });
});

describe('citation markers — detection and stripping', () => {
  it('names every cited id, in order', () => {
    assert.deepEqual(citedRefs(ANSWER), [PARTNER_REF, TURN_REF]);
  });

  it('strips markers with the one space before them, and is idempotent', () => {
    assert.equal(stripCitationMarkers(ANSWER), AS_READ);
    assert.equal(stripCitationMarkers(AS_READ), AS_READ);
    assert.equal(stripCitationMarkers('kein [ref: getrennt] Marker'), 'kein [ref: getrennt] Marker');
  });

  it('strips exactly like the channels do, so the verifier checks the text the user reads', () => {
    for (const text of [
      ANSWER,
      AS_READ,
      'A [REF:x] b\t[ref:y].',
      '- Punkt [ref:n1]\n- Punkt 2 [ref:n2]',
      'kein [ref: getrennt] Marker, [ref:n_user_42] schon',
      '[ref:]',
    ]) {
      assert.equal(stripCitationMarkers(text), channelStrip(text), JSON.stringify(text));
    }
  });
});
