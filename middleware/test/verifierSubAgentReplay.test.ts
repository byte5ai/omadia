/**
 * A verifier re-entry never runs a sub-agent's inner tool twice either.
 *
 * A domain tool wraps a `LocalSubAgent` whose own model calls inner tools —
 * writes among them, and `LocalSubAgentTool` carries no write declaration. A
 * re-entry replays the whole first run, so:
 *  - without Privacy Shield the domain tool's result (the sub-agent's answer
 *    and the inner tool events of its trace) is replayed and the sub-agent
 *    does not run again;
 *  - under Privacy Shield the sub-agent's answer only means something next to
 *    the datasets it interned in the FIRST run's privacy scope, which ended with
 *    that run. The sub-agent therefore runs again, and every inner call it
 *    repeats is replayed at its own seam and interned afresh in the re-entry's
 *    scope, so the dataset bridge still carries real rows;
 *  - an inner call the first run did not make abandons the whole re-entry.
 *
 * Drives the REAL `Orchestrator`, `LocalSubAgent` and `VerifierService`; only
 * the two models, the pipeline and the store are scripted. All values are
 * synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LocalSubAgentTool } from '@omadia/plugin-api';

import { LocalSubAgent } from '../packages/harness-orchestrator/src/localSubAgent.js';
import type { OrchestratorOptions } from '../packages/harness-orchestrator/src/orchestrator.js';
import { createDomainTool } from '../packages/harness-orchestrator/src/tools/domainQueryTool.js';
import {
  REQUEST,
  maskingPrivacy,
  scriptedModel,
  text,
  toolCalls,
  toolResultContents,
  verifiedTurn,
} from './_helpers/replayTurnFixture.js';
import { approved, blocked } from './_helpers/verifierVerdictFixtures.js';

const ADDRESS = { partner_id: 42, street: 'Musterweg 1' };
const OTHER_ADDRESS = { partner_id: 42, street: 'Musterweg 2' };
const UPDATED = '{"partner_id":42,"street":"Musterweg 1","status":"saved"}';
const NARRATION = 'Die Adresse von Partner 42 ist gespeichert.';
const QUESTION = { question: 'Speichere die neue Adresse von Partner 42.' };
const ANSWER = 'Erledigt: die Adresse von Partner 42 ist aktualisiert.';

interface SubAgentRig {
  readonly writes: unknown[];
  readonly subModel: ReturnType<typeof scriptedModel>;
  readonly options: Partial<OrchestratorOptions>;
}

/** A domain tool `ask_crm` backed by a LocalSubAgent with one inner write. */
function crmSubAgent(
  subResponses: Parameters<typeof scriptedModel>[0],
  extra: Partial<OrchestratorOptions> = {},
  postcondition = false,
): SubAgentRig {
  const writes: unknown[] = [];
  const update: LocalSubAgentTool = {
    spec: {
      name: 'crm_update_address',
      description: 'updates a partner address (test write)',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    handle: (input: unknown) => {
      writes.push(input);
      return Promise.resolve(
        postcondition ? { output: UPDATED, postcondition: { issues: ['zip: missing'] } } : UPDATED,
      );
    },
  };
  const subModel = scriptedModel(subResponses);
  const agent = new LocalSubAgent({
    name: 'crm',
    provider: subModel.provider,
    model: 'test',
    maxTokens: 1024,
    maxIterations: 4,
    systemPrompt: 'CRM sub-agent (test).',
    tools: [update],
  });
  const askCrm = createDomainTool({
    name: 'ask_crm',
    description: 'CRM specialist (test)',
    agent,
    domain: 'crm',
  });
  return { writes, subModel, options: { domainTools: [askCrm], ...extra } };
}

const parentRun = () => [toolCalls(['ask_crm', QUESTION]), text(ANSWER)];
const subRun = (input: unknown = ADDRESS) => [
  toolCalls(['crm_update_address', input]),
  text(NARRATION),
];

describe('VerifierService — a re-entry replays a sub-agent’s inner writes', () => {
  it('MUTATION CHECK, no Privacy Shield: the sub-agent does not run again', async () => {
    const rig = crmSubAgent([...subRun(), ...subRun()]);
    const t = verifiedTurn({
      responses: [...parentRun(), ...parentRun()],
      verdicts: [blocked(), approved()],
      orchestrator: rig.options,
    });

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(rig.writes, [ADDRESS], 'the inner write ran once');
    assert.equal(rig.subModel.requests.length, 2, 'the sub-agent ran in the first run only');
    assert.ok(
      toolResultContents(t.model.requests[3]).includes(NARRATION),
      'the retry got the sub-agent’s first answer',
    );
    assert.deepEqual(sa.verifier, { status: 'corrected' });
  });

  it('control: a replayed sub-agent result keeps its postcondition evidence for the verifier', async () => {
    const rig = crmSubAgent([...subRun(), ...subRun()], {}, true);
    const t = verifiedTurn({
      responses: [...parentRun(), ...parentRun()],
      verdicts: [blocked(), approved()],
      orchestrator: rig.options,
    });

    await t.service.chat(REQUEST);

    const evidence = (i: number) =>
      (t.verifyInputs[i]?.toolPostconditionViolations ?? []).map((v) => ({
        toolName: v.toolName,
        issues: v.issues,
      }));
    assert.equal(t.verifyInputs.length, 2);
    assert.deepEqual(evidence(0), [{ toolName: 'crm_update_address', issues: ['zip: missing'] }]);
    assert.deepEqual(evidence(1), evidence(0), 'the re-entry’s trace carries the same postcondition');
  });

  it('MUTATION CHECK, under Privacy Shield: the sub-agent re-runs over replayed inner results', async () => {
    const privacy = maskingPrivacy();
    const rig = crmSubAgent([...subRun(), ...subRun()], { privacyGuard: () => privacy.service });
    const t = verifiedTurn({
      responses: [...parentRun(), ...parentRun()],
      verdicts: [blocked(), approved()],
      orchestrator: rig.options,
    });

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(rig.writes, [ADDRESS], 'the inner write ran once');
    assert.equal(rig.subModel.requests.length, 4, 'the sub-agent ran again in the retry');
    // The inner result was replayed — and interned afresh for the re-entry.
    const replayedInner = toolResultContents(rig.subModel.requests[3]);
    assert.ok(
      replayedInner.some((r) => r.startsWith('«dataset:crm_update_address»') && r.includes('Musterweg 1')),
      `the re-run sub-agent got the replayed result as a digest: ${replayedInner.join(' | ')}`,
    );
    assert.ok(
      toolResultContents(t.model.requests[3]).some((r) => r.startsWith('«bridged»')),
      'the parent got the sub-agent’s datasets through the bridge',
    );
    assert.deepEqual(sa.verifier, { status: 'corrected' });
  });

  it('an inner call the first run did not make abandons the re-entry; the write never runs', async () => {
    const privacy = maskingPrivacy();
    const rig = crmSubAgent([...subRun(), ...subRun(OTHER_ADDRESS)], {
      privacyGuard: () => privacy.service,
    });
    const t = verifiedTurn({
      responses: [...parentRun(), ...parentRun()],
      verdicts: [blocked(), approved()],
      orchestrator: rig.options,
    });

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(rig.writes, [ADDRESS], 'the other address was never written');
    assert.equal(rig.subModel.requests.length, 3, 'the sub-agent re-ran until it asked for the new write');
    assert.ok(t.logs.some((l) => /retry abandoned/.test(l) && l.includes('crm_update_address')));
    assert.equal(sa.answerSource, 'verifier-blocked');
    assert.deepEqual(sa.verifier, { status: 'failed' });
  });
});
