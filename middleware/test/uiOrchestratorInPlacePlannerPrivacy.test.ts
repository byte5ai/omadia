// #1540 parity for the learned in-place planner: like the skeleton composer,
// it sends the user's follow-up (and table titles) to a model before the
// turn has a privacy handle, so with a guard running the prompt goes out
// masked, the plan comes back restored, and a refused mask skips the call.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { planInPlace } from '../packages/omadia-ui-orchestrator/src/learnedFastPath.js';
import type { SkeletonPrivacyRun } from '../packages/omadia-ui-orchestrator/src/skeletonPrivacy.js';

const TABLES = [{ containerId: 'invoices', title: 'Rechnungen', fieldKeys: ['name', 'amount'] }];
const PLAN = {
  containerId: 'invoices',
  fetch: {
    tool: 'odoo_query',
    input: { model: 'account.move', domain: [['partner_id.name', '=', 'Surrogat AG']], fields: ['name', 'amount_residual'] },
    map: { name: 'name', amount: 'amount_residual' },
  },
  summary: '{count} Rechnungen.',
};

function llmRecording(reply: string) {
  const prompts: string[] = [];
  return {
    prompts,
    llm: {
      complete: async (req: { messages: { content: string }[] }) => {
        prompts.push(req.messages.map((m) => m.content).join('\n'));
        return { text: reply };
      },
    },
  };
}

const base = {
  model: 'claude-haiku-5-5',
  tables: TABLES,
  currentQueries: new Map(),
  plans: [],
  allowedTools: new Set(['odoo_query']),
  log: () => undefined,
};

describe('in-place planner privacy (#1540 parity)', () => {
  it('a refused mask skips the model call', async () => {
    const rec = llmRecording(JSON.stringify(PLAN));
    const privacy: SkeletonPrivacyRun = {
      mask: async () => ({ send: false, reason: 'blocked' }),
      restore: (t) => t,
    };
    const res = await planInPlace({ ...base, llm: rec.llm as never, question: 'und von Brückner GmbH?', privacy });
    assert.deepEqual(res, { ok: false, reason: 'privacy-refused' });
    assert.equal(rec.prompts.length, 0);
  });

  it('the model sees only the masked prompt and the plan is restored', async () => {
    const rec = llmRecording(JSON.stringify(PLAN));
    const privacy: SkeletonPrivacyRun = {
      mask: async (t) => ({ send: true, text: t.replaceAll('Brückner GmbH', 'Surrogat AG') }),
      restore: (t) => t.replaceAll('Surrogat AG', 'Brückner GmbH'),
    };
    const res = await planInPlace({ ...base, llm: rec.llm as never, question: 'und von Brückner GmbH?', privacy });
    assert.equal(rec.prompts.length, 1);
    assert.doesNotMatch(rec.prompts[0] ?? '', /Brückner/);
    assert.equal(res.ok, true);
    if (res.ok) assert.match(JSON.stringify(res.fetch.input), /Brückner GmbH/);
  });

  it('without a guard the prompt goes out unchanged', async () => {
    const rec = llmRecording(JSON.stringify({ none: true }));
    await planInPlace({ ...base, llm: rec.llm as never, question: 'und im Februar?' });
    assert.match(rec.prompts[0] ?? '', /und im Februar\?/);
  });
});
