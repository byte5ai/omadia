import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  evaluateProposal,
  evaluateTemplateProposal,
} from '../../src/plugins/selfExtension/escalationGuard.js';
import {
  parseExtensionProposal,
  parseTemplateProposal,
} from '../../src/plugins/selfExtension/extensionProposal.js';
import type { ExtensionTemplate } from '@omadia/plugin-api';
import type { Plugin } from '../../src/api/admin-v1.js';
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

function dynamicsManifest(over: Partial<Plugin['permissions_summary']> = {}): Plugin {
  return {
    id: PLUGIN_ID,
    depends_on: ['de.byte5.integration.dynamics'],
    privacy_class: 'strict',
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: ['api.dynamics.com'],
      ...over,
    },
  } as unknown as Plugin;
}

const deltaTemplate: ExtensionTemplate = {
  id: 'odata.delta',
  title: 'Change tracking',
  description: 'Delta-query via odata.track-changes',
  paramsSchema: { type: 'object' },
  // read-only over the already-allowed Dataverse host — requires nothing new
  requires: { networkOutbound: ['api.dynamics.com'] },
};

function tmplProposal(templateId: string, pluginId = PLUGIN_ID) {
  return parseTemplateProposal({ pluginId, rationale: 'pipeline monitoring needs delta', templateId, params: { entitySet: 'salesorders' } });
}

describe('evaluateTemplateProposal — standalone path', () => {
  it('needs_approval when the template requires only what the manifest holds', () => {
    const ev = evaluateTemplateProposal(dynamicsManifest(), deltaTemplate, tmplProposal('odata.delta'));
    assert.equal(ev.decision, 'needs_approval');
    assert.equal(ev.escalations.length, 0);
  });

  it('denied_escalation when the template requires a new egress host', () => {
    const greedy: ExtensionTemplate = { ...deltaTemplate, requires: { networkOutbound: ['evil.example.com'] } };
    const ev = evaluateTemplateProposal(dynamicsManifest(), greedy, tmplProposal('odata.delta'));
    assert.equal(ev.decision, 'denied_escalation');
    assert.equal(ev.escalations[0]?.dimension, 'network.outbound');
  });

  it('invalid when the template is unknown', () => {
    const ev = evaluateTemplateProposal(dynamicsManifest(), undefined, tmplProposal('does.not.exist'));
    assert.equal(ev.decision, 'invalid_spec');
    assert.match(ev.invalidReason ?? '', /no self-extend template/);
  });

  it('invalid when the proposal targets another plugin', () => {
    const ev = evaluateTemplateProposal(dynamicsManifest(), deltaTemplate, tmplProposal('odata.delta', 'de.byte5.agent.other'));
    assert.equal(ev.decision, 'invalid_spec');
  });
});
