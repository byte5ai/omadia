/**
 * A withheld answer is explained by what actually happened — never by
 * something stronger.
 *
 * Production (v0.170.0, 2026-10-07, Teams, 11:16–11:44 Europe/Berlin):
 *  - three answers withheld for missing `[ref:…]` markers told the user the
 *    fact-check had found a CONTRADICTION; no source contradicted anything;
 *  - one answer claimed "kein Zugriff" without a single tool call.
 *
 * The decision to withhold (status `blocked`, which also drives the
 * correction retry) is unchanged. What changed is the cause it is reported
 * under: a contradicted verdict now carries its `basis`, the summary counts
 * only refutations as contradictions, and the notice, the badge and the
 * correction hint follow the cause.
 *
 * Imported from SOURCE so a mutation in `src/` cannot pass over stale `dist/`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  VerifierPipeline,
  buildCorrectionPrompt,
  detectFailureReplay,
  type Claim,
  type ClaimExtraction,
  type ClaimExtractor,
  type ClaimVerdict,
  type DeterministicChecker,
  type EvidenceJudge,
  type HardClaim,
  type VerifierInput,
  type VerifierVerdict,
} from '../packages/harness-verifier/src/index.js';
import { citedRefs } from '../packages/harness-verifier/src/verifierPipeline.js';
import { composeVerifierBlockedText } from '../packages/harness-channel-sdk/src/verifierBlocked.js';
import { stripCitationMarkers } from '../packages/harness-channel-sdk/src/citationMarkers.js';
import { toSemanticAnswer } from '../packages/harness-channel-sdk/src/toSemanticAnswer.js';
import {
  summarise,
  withheldCauseOf,
  withheldLogLine,
} from '../packages/harness-orchestrator/src/verifierVerdicts.js';
import { knowledgeGraphRefsIn } from '../packages/harness-orchestrator/src/knowledgeGraphRefs.js';
import { RunTraceCollector } from '../packages/harness-orchestrator/src/runTraceCollector.js';
import {
  extractFailedToolsCalled,
  extractKnowledgeGraphRefs,
} from '../packages/harness-orchestrator/src/verifierTraceEvidence.js';

// --- fixtures -----------------------------------------------------------

const TURN_REF = 'turn:teams:19:abc@thread.v2:2026-10-07T09:16:00.000Z';
const ENTITY_REF = 'odoo:res.partner:42';

function amountClaim(): HardClaim {
  return {
    id: 'c_001',
    text: '1.234,56 €',
    type: 'amount',
    expectedSource: 'odoo',
    value: 1234.56,
    odooRecord: { model: 'account.move', id: 42 },
    relatedEntities: [],
  };
}

function pipelineWith(verdictFor: (c: HardClaim) => ClaimVerdict, claims: Claim[] = []): VerifierPipeline {
  return new VerifierPipeline({
    extractor: {
      extract: (): Promise<ClaimExtraction> => Promise.resolve({ claims, gaps: [] }),
    } as unknown as ClaimExtractor,
    deterministic: {
      checkAll: (cs: HardClaim[]) => Promise.resolve(cs.map(verdictFor)),
      check: (c: HardClaim) => Promise.resolve(verdictFor(c)),
    } as unknown as DeterministicChecker,
    judge: {
      checkAll: () => Promise.resolve([]),
      check: () => Promise.reject(new Error('unused')),
    } as unknown as EvidenceJudge,
    log: () => undefined,
  });
}

const verifiedPipeline = (claims: Claim[] = []) =>
  pipelineWith((c) => ({ status: 'verified', claim: c, source: 'odoo' }), claims);

const base: VerifierInput = { runId: 'r', userMessage: 'Frage', answer: '' };

const CONTRADICTION_WORDS = /Widerspruch|widersprech|widerspricht|contradict/i;

async function noticeFor(verdict: VerifierVerdict, locale = 'de'): Promise<string> {
  return composeVerifierBlockedText(locale, summarise(verdict, 0, 'enforce'));
}

// --- A: missing citations are not contradictions ------------------------

describe('a missing citation is reported as a missing citation', () => {
  it('blocks (and so still retries), but counts no contradiction and says so', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer: 'Der Kunde hat zwei offene Tickets.',
      knowledgeGraphToolsCalled: true,
      knowledgeGraphRefs: [TURN_REF],
    });
    assert.equal(verdict.status, 'blocked', 'withheld, and the correction retry still fires');
    const summary = summarise(verdict, 0, 'enforce');
    assert.equal(summary.withheldCause, 'citation_missing');
    assert.equal(summary.contradictionCount, 0, 'no source refuted anything');
    assert.equal(summary.unverifiedCount, 1, 'the withhold counts as not confirmed');
    assert.notEqual(summary.badge, 'failed', 'no "contradiction found" badge');
    const text = composeVerifierBlockedText('de', summary);
    assert.doesNotMatch(text, CONTRADICTION_WORDS, text);
    assert.match(text, /keine Quellen/);
    assert.doesNotMatch(await noticeFor(verdict, 'en'), CONTRADICTION_WORDS);
  });

  it('gives a Teams connector no badge for it — the chip would say "Widerspruch"', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer: 'Der Kunde hat zwei offene Tickets.',
      knowledgeGraphToolsCalled: true,
    });
    const summary = summarise(verdict, 0, 'enforce');
    const semantic = toSemanticAnswer({ answer: 'x', toolCalls: 0, iterations: 1, verifier: summary });
    assert.equal(semantic.verifier, undefined);
  });

  it('keeps a REAL contradiction a contradiction — blocked, counted, named', async () => {
    const pipeline = pipelineWith(
      (c) => ({ status: 'contradicted', claim: c, truth: 999.99, source: 'odoo' }),
      [amountClaim()],
    );
    const verdict = await pipeline.verify({ ...base, answer: 'Die Rechnung beträgt 1.234,56 €.' });
    assert.equal(verdict.status, 'blocked');
    const summary = summarise(verdict, 0, 'enforce');
    assert.equal(summary.withheldCause, 'contradicted');
    assert.equal(summary.contradictionCount, 1);
    assert.equal(summary.badge, 'failed');
    assert.match(composeVerifierBlockedText('de', summary), /einen Widerspruch zu den Quelldaten/);
    // Traceable for support: the claim id and its basis, never its words.
    const line = withheldLogLine('run-7', verdict);
    assert.match(line, /cause=contradicted/);
    assert.match(line, /c_001:evidence/);
    assert.doesNotMatch(line, /1\.234,56/);
  });

  it('a real contradiction outranks a missing citation in the same answer', async () => {
    const pipeline = pipelineWith(
      (c) => ({ status: 'contradicted', claim: c, truth: 1, source: 'odoo' }),
      [amountClaim()],
    );
    const verdict = await pipeline.verify({
      ...base,
      answer: 'Die Rechnung beträgt 1.234,56 €.',
      knowledgeGraphToolsCalled: true,
    });
    assert.equal(withheldCauseOf(verdict), 'contradicted');
    assert.equal(summarise(verdict, 0, 'enforce').contradictionCount, 1, 'only the refutation counts');
  });
});

// --- B: citations must name accessible evidence --------------------------

describe('a citation must name a source the turn actually returned', () => {
  it('reads real graph ids with colons and dots', () => {
    assert.deepEqual(citedRefs(`A [ref:${TURN_REF}] und B [ref:${ENTITY_REF}].`), [TURN_REF, ENTITY_REF]);
    assert.deepEqual(citedRefs('kein [ref: getrennt] Marker, [ref:n_user_42] schon'), ['n_user_42']);
  });

  it('accepts a marker with a real graph id — no citation_missing any more', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer: `Der Kunde hat zwei offene Tickets [ref:${TURN_REF}].`,
      knowledgeGraphToolsCalled: true,
      knowledgeGraphRefs: [TURN_REF],
    });
    assert.notEqual(verdict.status, 'blocked');
  });

  it('withholds an invented source as unbacked, not as a contradiction', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer: 'Der Kunde hat zwei offene Tickets [ref:odoo:res.partner:7].',
      knowledgeGraphToolsCalled: true,
      knowledgeGraphRefs: [ENTITY_REF],
    });
    assert.equal(verdict.status, 'blocked');
    const summary = summarise(verdict, 0, 'enforce');
    assert.equal(summary.withheldCause, 'insufficient_evidence');
    assert.equal(summary.contradictionCount, 0);
    assert.doesNotMatch(composeVerifierBlockedText('de', summary), CONTRADICTION_WORDS);
    const hint = buildCorrectionPrompt(verdict) ?? '';
    assert.match(hint, /Erfinde keine Quellen/);
  });

  it('demands no marker when the graph returned nothing citable', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer: 'Dazu habe ich nichts gefunden.',
      knowledgeGraphToolsCalled: true,
      knowledgeGraphRefs: [],
    });
    assert.notEqual(verdict.status, 'blocked');
  });

  it('withholds a source cited although the graph returned nothing citable', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer: 'Dazu gibt es zwei Tickets [ref:odoo:helpdesk.ticket:9].',
      knowledgeGraphToolsCalled: true,
      knowledgeGraphRefs: [],
    });
    assert.equal(verdict.status, 'blocked');
    assert.equal(withheldCauseOf(verdict), 'insufficient_evidence');
  });

  it('the correction hint points at the id fields and reuses the first-run queries', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer: 'Der Kunde hat zwei offene Tickets.',
      knowledgeGraphToolsCalled: true,
      knowledgeGraphRefs: [TURN_REF],
    });
    const hint = buildCorrectionPrompt(verdict) ?? '';
    assert.match(hint, /^# Verifier hat die Antwort zurückgehalten/);
    assert.doesNotMatch(hint, /Widersprüche erkannt/, 'the model must not relay a contradiction');
    assert.match(hint, /`id`- oder `turnId`-Feldes/);
    assert.match(hint, /dieselben Abfragen wie zuvor/);
    assert.doesNotMatch(hint, /vorherigen `query_knowledge_graph`-Tool-Results/, 'the retry cannot see them');
    assert.doesNotMatch(hint, /## Falsche \/ widerlegte Daten/);
  });

  it('collects citable ids from graph output: entity ids and turn ids, nothing else', () => {
    const out = JSON.stringify({
      query: 'Anna',
      hits: [{ turnId: TURN_REF, scope: 'teams:19:abc', userMessage: 'id: not-a-ref' }],
      entities: [{ id: ENTITY_REF, displayName: 'Anna', externalId: 42 }],
    });
    assert.deepEqual(knowledgeGraphRefsIn(out).sort(), [ENTITY_REF, TURN_REF].sort());
    assert.deepEqual(knowledgeGraphRefsIn('Error: graph down'), []);
  });

  it('the run trace carries what orchestrator AND sub-agent graph calls returned', () => {
    const collector = new RunTraceCollector({ scope: 's', startedAt: '2026-10-07T09:00:00.000Z' });
    collector.recordOrchestratorToolCall(
      { callId: 'a', toolName: 'query_knowledge_graph', durationMs: 1, isError: false },
      JSON.stringify({ hits: [{ turnId: TURN_REF }] }),
    );
    const inv = collector.beginInvocation('crm');
    inv.observer.onSubToolUse?.({ id: 'b', name: 'query_knowledge_graph', input: {} });
    inv.observer.onSubToolResult?.({
      id: 'b',
      output: JSON.stringify({ entities: [{ id: ENTITY_REF }] }),
      durationMs: 1,
      isError: false,
    });
    inv.finish({ durationMs: 2, status: 'success' });
    const trace = collector.finish({ iterations: 1, status: 'success', finishedAt: '2026-10-07T09:00:01.000Z' });
    assert.deepEqual(extractKnowledgeGraphRefs(trace), [ENTITY_REF, TURN_REF].sort());
  });

  it('strips real-id markers before any channel shows the answer', () => {
    assert.equal(stripCitationMarkers(`Zwei Tickets [ref:${TURN_REF}].`), 'Zwei Tickets.');
    const semantic = toSemanticAnswer({
      answer: `Zwei Tickets [ref:${ENTITY_REF}] offen.`,
      toolCalls: 0,
      iterations: 1,
    });
    assert.equal(semantic.text, 'Zwei Tickets offen.');
  });
});

// --- A: "kein Zugriff" needs a failed access -----------------------------

describe('"no access" needs an access that actually failed', () => {
  const answer = 'Ich habe leider keinen Zugriff auf Odoo.';

  it('flags it when no tool ran — and reports it as an uncalled tool, not a contradiction', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer,
      domainToolsCalled: [],
      failedToolsCalled: [],
    });
    assert.equal(verdict.status, 'blocked');
    const summary = summarise(verdict, 0, 'enforce');
    assert.equal(summary.withheldCause, 'tool_not_called');
    assert.equal(summary.contradictionCount, 0);
    const text = composeVerifierBlockedText('de', summary);
    assert.doesNotMatch(text, CONTRADICTION_WORDS, text);
    assert.doesNotMatch(text, /kein Zugriff|nicht erreichbar/i, 'the system never repeats the claim');
  });

  it('flags it when tools ran but none failed', () => {
    const verdicts = detectFailureReplay({
      ...base,
      answer,
      domainToolsCalled: ['memory'],
      failedToolsCalled: [],
    });
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]?.status === 'contradicted' && verdicts[0].basis, 'unsupported_failure_claim');
  });

  it('calls ran but none failed: withheld as unbacked — never "no data was retrieved"', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer,
      domainToolsCalled: ['memory'],
      failedToolsCalled: [],
    });
    const summary = summarise(verdict, 0, 'enforce');
    assert.equal(summary.withheldCause, 'insufficient_evidence');
    const text = composeVerifierBlockedText('de', summary);
    assert.doesNotMatch(text, /nicht abgerufen|abgerufen wurden/, 'calls DID run');
    assert.doesNotMatch(text, CONTRADICTION_WORDS, text);
  });

  it('an honest "not found" after a search that ran is NOT withheld', () => {
    for (const notFound of [
      'Ich konnte die Rechnung INV/2026/0042 nicht finden.',
      'Dazu wurden keine Buchungen gefunden.',
    ]) {
      const verdicts = detectFailureReplay({
        ...base,
        answer: notFound,
        domainToolsCalled: ['query_odoo_accounting'],
        failedToolsCalled: [],
      });
      assert.deepEqual(verdicts, [], notFound);
    }
  });

  it('lets it stand when a call in the turn really failed', () => {
    const verdicts = detectFailureReplay({
      ...base,
      answer,
      domainToolsCalled: ['query_odoo_accounting'],
      failedToolsCalled: ['query_odoo_accounting'],
    });
    assert.deepEqual(verdicts, []);
  });

  it('reads the failed calls off the run trace', () => {
    const collector = new RunTraceCollector({ scope: 's', startedAt: '2026-10-07T09:00:00.000Z' });
    collector.recordOrchestratorToolCall({ callId: 'a', toolName: 'memory', durationMs: 1, isError: false });
    collector.recordOrchestratorToolCall({ callId: 'b', toolName: 'query_odoo_accounting', durationMs: 1, isError: true });
    const trace = collector.finish({ iterations: 1, status: 'success', finishedAt: '2026-10-07T09:00:01.000Z' });
    assert.deepEqual(extractFailedToolsCalled(trace), ['query_odoo_accounting']);
  });

  it('a live-data claim without the fetching call goes to "nicht abgerufen", not "widerlegt"', async () => {
    const verdict = await verifiedPipeline([amountClaim()]).verify({
      ...base,
      answer: 'Die Rechnung beträgt 1.234,56 €.',
      domainToolsCalled: ['memory'],
    });
    assert.equal(verdict.status, 'blocked');
    assert.equal(withheldCauseOf(verdict), 'tool_not_called');
    const hint = buildCorrectionPrompt(verdict) ?? '';
    assert.match(hint, /## Live-Daten nicht abgerufen/);
    assert.doesNotMatch(hint, /## Falsche \/ widerlegte Daten/);
  });
});

// --- A: technical faults are technical faults ---------------------------

describe('a technical fault is reported as one', () => {
  it('pipeline and extractor failures are check_failed; Privacy Shield is not_checked', () => {
    const unavailable = (reason: 'pipeline_error' | 'extractor_error' | 'privacy_shield'): VerifierVerdict => ({
      status: 'unavailable',
      reason,
      claims: [],
      latencyMs: 0,
    });
    assert.equal(withheldCauseOf(unavailable('pipeline_error')), 'check_failed');
    assert.equal(withheldCauseOf(unavailable('extractor_error')), 'check_failed');
    assert.equal(withheldCauseOf(unavailable('privacy_shield')), 'not_checked');
  });

  it('a broken tool result is a technical fault, not a contradiction', async () => {
    const verdict = await verifiedPipeline().verify({
      ...base,
      answer: 'Erledigt.',
      toolPostconditionViolations: [
        { toolName: 'query_odoo_accounting', callId: 'c1', agentContext: 'orchestrator', issues: ['amount: expected number'] },
      ],
    });
    assert.equal(verdict.status, 'blocked');
    const summary = summarise(verdict, 0, 'enforce');
    assert.equal(summary.withheldCause, 'check_failed');
    assert.equal(summary.contradictionCount, 0);
    assert.match(composeVerifierBlockedText('de', summary), /technischen Störung/);
  });

  it('an approved verdict and a skipped no-trigger verdict carry no cause', () => {
    assert.equal(withheldCauseOf({ status: 'approved', claims: [{ status: 'verified', claim: amountClaim(), source: 'odoo' }], latencyMs: 0 } as VerifierVerdict), undefined);
    assert.equal(withheldCauseOf({ status: 'skipped', reason: 'no_trigger', claims: [], latencyMs: 0 }), undefined);
  });
});
