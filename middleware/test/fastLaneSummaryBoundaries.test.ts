/**
 * Spec 2042 §6 criterion 33 — "a planner summary … contradicting the agent's
 * boundaries is blocked". The planner's own words (summary template, column
 * labels) are checked against the agent's boundaries in the fast-path
 * service, beside the data-plan check and before the fetch, new or from the
 * cache: presets with a text constraint deterministically, every other rule
 * by the agent's model on the shield-masked text with figures masked;
 * fail-closed. A refused summary never runs, is evicted from the cache, and
 * the agent's full loop answers instead.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent } from '@omadia/channel-sdk';
import type { PrivacyGuardService, PrivacyPromptMaskResult } from '@omadia/plugin-api';

import { wrapChatAgentWithFastPath, type FastPathTriagePort } from '../packages/harness-orchestrator/src/fastPathAgent.js';
import {
  createSummaryBoundaryGuard,
  maskFigures,
  type SummaryBoundaryGuard,
  type SummaryBoundaryJudge,
} from '../packages/harness-orchestrator/src/summaryBoundaryGuard.js';
import type { AnswerCache } from '../packages/harness-plugin-fast-path/src/answerCache.js';
import type { PlannedQuery } from '../packages/harness-plugin-fast-path/src/index.js';
import { PERSON_CANARY } from '../packages/harness-plugin-fast-path/src/exampleMasking.js';
import { createFastPathService } from '../packages/harness-plugin-fast-path/src/service.js';
import { withRouterPlanner } from './_helpers/fastPathRouterPlanner.js';

const OPEN_INVOICES = {
  tool: 'odoo_query',
  input: { model: 'account.move', fields: ['name', 'partner_id', 'amount_residual'], domain: [['payment_state', '=', 'not_paid']], limit: 100 },
  map: { number: 'name', customer: 'partner_id.1', open: 'amount_residual' },
};
const LABELS = { number: 'Nummer', customer: 'Kunde', open: 'Offen' };

/** A shield that masks the one name it knows (and finds its canary). */
const shield = {
  openStoredTextScope: () => ({
    maskStoredText: (text: string): Promise<PrivacyPromptMaskResult> =>
      Promise.resolve({
        outcome: 'masked',
        maskedText: text.split('Müller GmbH').join('‹P1›'),
        spans: text === PERSON_CANARY ? [{ type: 'person', detector: 'c1-test' }] : [],
        degraded: false,
      }),
    restoreStoredText: (text: string) => text.split('‹P1›').join('Müller GmbH'),
  }),
} as unknown as PrivacyGuardService;

function service(opts: { summary: string; cached?: boolean; checkSummary: SummaryBoundaryGuard }) {
  const invokes: string[] = [];
  const evicted: string[] = [];
  const plan = { fetch: OPEN_INVOICES, labels: LABELS, summary: opts.summary } as unknown as PlannedQuery;
  const cache: AnswerCache = {
    load: async () => undefined,
    lookup: () => (opts.cached ? { hit: true, key: 'k1', plan, slots: 0 } : { hit: false, reason: 'empty' }),
    remember: async () => ({ stored: false, reason: 'test' }),
    recordHit: () => undefined,
    evict: (key) => evicted.push(key),
    entries: () => [],
    settled: async () => undefined,
  };
  const reply = JSON.stringify({ decision: 'deterministic', fetch: OPEN_INVOICES, labels: LABELS, summary: opts.summary, locale: 'de-DE' });
  const svc = createFastPathService({
    config: { get: () => undefined },
    llm: withRouterPlanner({ complete: () => Promise.resolve({ text: reply }) }),
    model: 'class:fast',
    invoke: (name) => {
      invokes.push(name);
      return Promise.resolve(JSON.stringify({ records: [{ id: 1, name: 'RE-1', partner_id: [7, 'Müller GmbH'], amount_residual: 99 }] }));
    },
    privacyGuard: () => shield,
    privacyForced: () => false,
    log: () => undefined,
    answerCache: cache,
  });
  const ask = () =>
    svc.triageChatTurn({
      channel: 'web',
      userMessage: 'Offene Posten von Müller GmbH?',
      permittedTools: new Set(['odoo_query']),
      agentSlug: 'erika',
      checkSummary: opts.checkSummary,
    });
  return { ask, invokes, evicted };
}

const judgeOf = (verdict: 'pass' | 'block', seen: string[] = []): SummaryBoundaryJudge => ({
  judge: (text) => {
    seen.push(text);
    return Promise.resolve(verdict);
  },
});

describe('criterion 33 — the planner summary under the agent boundaries (fast-path service)', () => {
  it('a summary contradicting a free-text boundary is refused before anything runs; the agent takes the turn', async () => {
    const guard = createSummaryBoundaryGuard({ boundaries: { custom: ['Never promise payment dates.'] }, judge: judgeOf('block') });
    const s = service({ summary: '{count} offene Posten, wir zahlen garantiert morgen.', checkSummary: guard });
    const out = await s.ask();
    assert.equal(out.kind, 'agent');
    assert.equal(out.kind === 'agent' && out.reason, 'summary-boundary');
    assert.deepEqual(s.invokes, [], 'no fetch for a refused summary');
  });

  it('the same summary as a cache hit is refused and evicted', async () => {
    const guard = createSummaryBoundaryGuard({ boundaries: { presets: ['no-external-links'] } });
    const s = service({ summary: '{count} Posten, Details unter https://example.com/x', cached: true, checkSummary: guard });
    const out = await s.ask();
    assert.equal(out.kind === 'agent' && out.reason, 'summary-boundary');
    assert.deepEqual(s.invokes, []);
    assert.deepEqual(s.evicted, ['k1']);
  });

  it('a summary that keeps the boundaries is answered; the judge sees the shield-masked template and labels', async () => {
    const seen: string[] = [];
    const guard = createSummaryBoundaryGuard({ boundaries: { custom: ['Never promise payment dates.'] }, judge: judgeOf('pass', seen) });
    const s = service({ summary: '{count} offene Posten von Müller GmbH.', checkSummary: guard });
    const out = await s.ask();
    assert.equal(out.kind, 'answer');
    assert.deepEqual(s.invokes, ['odoo_query']);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.includes('Müller'), false, 'no restored value reaches the judge');
    assert.match(seen[0] ?? '', /von ‹P/, 'the shield token stands in for the name');
    assert.match(seen[0] ?? '', /Nummer · Kunde · Offen/);
    assert.equal(/\d/.test(seen[0] ?? ''), false, 'no figure either');
  });

  it('the agent wrapper hands its summary guard to the service', async () => {
    const guard: SummaryBoundaryGuard = () => Promise.resolve({ allowed: true });
    let received: unknown;
    const port: FastPathTriagePort = {
      channelEnabled: () => true,
      triageChatTurn: (req) => {
        received = req.checkSummary;
        return Promise.resolve({ kind: 'agent', reason: 'test', ms: 1 });
      },
    };
    const inner: ChatAgent = { chat: () => Promise.resolve({ text: 'x' }), chatStream: () => { throw new Error('unused'); } };
    const agent = wrapChatAgentWithFastPath(inner, {
      fastPath: () => port,
      permittedTools: () => new Set(['odoo_query']),
      privacyGuarded: () => false,
      checkSummary: guard,
      log: () => undefined,
    });
    await agent.chat({ userMessage: 'Offene Posten?', sessionScope: 'tab_1' });
    assert.equal(received, guard);
  });
});

describe('criterion 33 — the summary guard', () => {
  it('presets with a text constraint are decided without a model', async () => {
    const noJudge = createSummaryBoundaryGuard({ boundaries: { presets: ['no-individual-rankings', 'no-external-links'] } });
    assert.equal((await noJudge('Die Top 5 Kunden nach Umsatz.')).allowed, false);
    assert.equal((await noJudge('Ihr größter Kunde ist …')).allowed, false);
    assert.equal((await noJudge('Details unter https://example.com/x')).allowed, false);
    assert.equal((await noJudge('{count} offene Rechnungen über {sum:open} EUR.')).allowed, true);
  });

  it('fails closed: no judge for model rules, a throwing judge, a timeout', async () => {
    const preset = { presets: ['no-commitments'] };
    assert.equal((await createSummaryBoundaryGuard({ boundaries: preset })('{count} Posten.')).allowed, false);
    const throwing = createSummaryBoundaryGuard({ boundaries: preset, judge: { judge: () => Promise.reject(new Error('down')) } });
    assert.equal((await throwing('{count} Posten.')).allowed, false);
    const slow = createSummaryBoundaryGuard({ boundaries: preset, judge: { judge: () => new Promise(() => undefined) }, timeoutMs: 5 });
    const verdict = await slow('{count} Posten.');
    assert.equal(verdict.allowed, false);
    assert.equal(!verdict.allowed && verdict.reason, 'the boundary check timed out');
  });

  it('an agent without boundaries keeps every summary, with no model call', async () => {
    const seen: string[] = [];
    const guard = createSummaryBoundaryGuard({ boundaries: undefined, judge: judgeOf('block', seen) });
    assert.equal((await guard('Top 3 Kunden.')).allowed, true);
    assert.equal(seen.length, 0);
  });

  it('masks figures for the judge', () => {
    assert.equal(maskFigures('3 Rechnungen über 1.200,50 EUR'), '‹n› Rechnungen über ‹n› EUR');
  });
});
