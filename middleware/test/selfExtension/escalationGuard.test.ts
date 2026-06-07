import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { evaluateProposal } from '../../src/plugins/selfExtension/escalationGuard.js';
import { parseExtensionProposal } from '../../src/plugins/selfExtension/extensionProposal.js';
import { baseSpec } from './_fixtures.js';

const PLUGIN_ID = 'de.byte5.agent.dynamics';

function proposal(patches: unknown[], pluginId = PLUGIN_ID) {
  return parseExtensionProposal({
    pluginId,
    rationale: 'dynamics_query hits the 50-row cap; add server-side aggregation',
    patches,
  });
}

describe('evaluateProposal — the escalation guard', () => {
  it('needs_approval for the Dynamics aggregate example (read-only stays read-only)', () => {
    const ev = evaluateProposal(
      baseSpec(),
      proposal([
        {
          op: 'add',
          path: '/tools/-',
          value: { id: 'dynamics_aggregate', description: '$apply group-by aggregation', input: {} },
        },
      ]),
    );
    assert.equal(ev.decision, 'needs_approval');
    assert.equal(ev.escalations.length, 0);
    assert.ok(ev.proposedSpec);
    assert.equal(ev.proposedSpec?.tools.some((t) => t.id === 'dynamics_aggregate'), true);
  });

  it('denied_escalation when the proposal grants itself a new graph write', () => {
    const ev = evaluateProposal(
      baseSpec(),
      proposal([{ op: 'add', path: '/permissions/graph/writes/-', value: 'odoo:invoices:*' }]),
    );
    assert.equal(ev.decision, 'denied_escalation');
    assert.equal(ev.escalations.length, 1);
    assert.equal(ev.escalations[0]?.dimension, 'graph.writes');
  });

  it('denied_escalation when enabling web_scanner', () => {
    const ev = evaluateProposal(
      baseSpec(),
      proposal([{ op: 'add', path: '/network/web_scanner', value: true }]),
    );
    assert.equal(ev.decision, 'denied_escalation');
  });

  it('invalid_spec when the proposal pluginId does not match the live spec', () => {
    const ev = evaluateProposal(
      baseSpec(),
      proposal([{ op: 'add', path: '/tools/-', value: { id: 't', description: 'd', input: {} } }], 'de.byte5.agent.other'),
    );
    assert.equal(ev.decision, 'invalid_spec');
    assert.match(ev.invalidReason ?? '', /does not match/);
  });

  it('invalid_spec when the patches mutate the immutable plugin id', () => {
    const ev = evaluateProposal(
      baseSpec(),
      proposal([{ op: 'replace', path: '/id', value: 'de.byte5.agent.impostor' }]),
    );
    assert.equal(ev.decision, 'invalid_spec');
    assert.match(ev.invalidReason ?? '', /immutable plugin id/);
  });

  it('invalid_spec when a patch targets an illegal pointer', () => {
    const ev = evaluateProposal(
      baseSpec(),
      proposal([{ op: 'replace', path: '/nonexistent/field', value: 1 }]),
    );
    assert.equal(ev.decision, 'invalid_spec');
  });

  it('combines multiple escalations into one verdict', () => {
    const ev = evaluateProposal(
      baseSpec(),
      proposal([
        { op: 'add', path: '/network/outbound/-', value: 'evil.example.com' },
        { op: 'replace', path: '/privacy_class', value: 'default' },
      ]),
    );
    assert.equal(ev.decision, 'denied_escalation');
    assert.equal(ev.escalations.length, 2);
  });
});
