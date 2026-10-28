// The generic Odoo read tool (`odoo_query`, integration-odoo with
// `odoo_generic_read_enabled`) fetches live data in the turn. The verifier's
// "did this turn actually look at Odoo" cross-check must count it — otherwise
// every figure the main agent read through it is withheld as
// `tool_not_called` (observed live: "Offene Posten", 4/4 claims blocked).
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  VerifierPipeline,
  type ClaimExtraction,
  type ClaimExtractor,
  type DeterministicChecker,
  type EvidenceJudge,
  type HardClaim,
  type VerifierInput,
} from '../packages/harness-verifier/src/index.js';
import { summarise } from '../packages/harness-orchestrator/src/verifierVerdicts.js';

const CLAIM: HardClaim = {
  id: 'c_001',
  text: '1.234,56 €',
  type: 'amount',
  expectedSource: 'odoo',
  value: 1234.56,
  odooRecord: { model: 'account.move', id: 42 },
  relatedEntities: [],
};

const pipeline = (): VerifierPipeline =>
  new VerifierPipeline({
    extractor: {
      extract: (): Promise<ClaimExtraction> => Promise.resolve({ claims: [CLAIM], gaps: [] }),
    } as unknown as ClaimExtractor,
    deterministic: {
      checkAll: (cs: HardClaim[]) =>
        Promise.resolve(cs.map((c) => ({ status: 'verified', claim: c, source: 'odoo' }))),
      check: (c: HardClaim) => Promise.resolve({ status: 'verified', claim: c, source: 'odoo' }),
    } as unknown as DeterministicChecker,
    judge: {
      checkAll: () => Promise.resolve([]),
      check: () => Promise.reject(new Error('unused')),
    } as unknown as EvidenceJudge,
    log: () => undefined,
  });

const input = (domainToolsCalled: string[]): VerifierInput => ({
  runId: 'r',
  userMessage: 'Welche Posten sind offen?',
  answer: 'Offen sind 1.234,56 €.',
  domainToolsCalled,
  failedToolsCalled: [],
});

describe('verifier counts odoo_query as a live Odoo read', () => {
  it('does not withhold a figure the turn read via odoo_query', async () => {
    const verdict = await pipeline().verify(input(['odoo_query', 'canvas_publish_rows']));
    assert.notEqual(summarise(verdict, 0, 'enforce').withheldCause, 'tool_not_called');
    assert.notEqual(verdict.status, 'blocked');
  });

  it('still withholds when the turn only described the schema', async () => {
    const verdict = await pipeline().verify(input(['odoo_describe']));
    assert.equal(verdict.status, 'blocked');
    assert.equal(summarise(verdict, 0, 'enforce').withheldCause, 'tool_not_called');
  });

  it('still withholds when no Odoo tool ran at all', async () => {
    const verdict = await pipeline().verify(input(['memory']));
    assert.equal(summarise(verdict, 0, 'enforce').withheldCause, 'tool_not_called');
  });
});
