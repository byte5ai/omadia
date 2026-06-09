import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  OperatorGate,
  NarrowingWidensError,
  IllegalProposalTransitionError,
} from '../../src/plugins/selfExtension/operatorGate.js';
import { SelfExtensionAudit } from '../../src/plugins/selfExtension/audit.js';
import {
  parseExtensionProposal,
  parseTemplateProposal,
} from '../../src/plugins/selfExtension/extensionProposal.js';
import type { ExtensionTemplate } from '@omadia/plugin-api';
import type { Plugin } from '../../src/api/admin-v1.js';
import { baseSpec } from './_fixtures.js';

const PLUGIN_ID = 'de.byte5.agent.dynamics';

function makeGate() {
  let n = 0;
  const audit = new SelfExtensionAudit({ now: () => 1000 });
  const gate = new OperatorGate({ now: () => 1000, genId: () => `p${++n}`, audit });
  return { gate, audit };
}

function cleanProposal() {
  return parseExtensionProposal({
    pluginId: PLUGIN_ID,
    rationale: 'add aggregation tool',
    patches: [
      { op: 'add', path: '/tools/-', value: { id: 'dynamics_aggregate', description: 'agg', input: {} } },
    ],
  });
}

function escalatingProposal() {
  return parseExtensionProposal({
    pluginId: PLUGIN_ID,
    rationale: 'grab odoo write access',
    patches: [{ op: 'add', path: '/permissions/graph/writes/-', value: 'odoo:invoices:*' }],
  });
}

describe('OperatorGate', () => {
  it('submits a clean proposal as pending and audits it', () => {
    const { gate, audit } = makeGate();
    const rec = gate.submit({ pluginId: PLUGIN_ID, currentSpec: baseSpec(), proposal: cleanProposal(), submittedBy: 'agent:dynamics' });
    assert.equal(rec.status, 'pending');
    assert.equal(rec.id, 'p1');
    assert.equal(audit.list({ proposalId: 'p1' }).some((e) => e.type === 'proposed'), true);
  });

  it('auto-denies an escalating proposal on submit — it never becomes pending', () => {
    const { gate, audit } = makeGate();
    const rec = gate.submit({ pluginId: PLUGIN_ID, currentSpec: baseSpec(), proposal: escalatingProposal(), submittedBy: 'agent:dynamics' });
    assert.equal(rec.status, 'denied');
    assert.equal(rec.denialReason, 'privilege escalation');
    assert.equal(audit.list({ proposalId: rec.id }).some((e) => e.type === 'denied_escalation'), true);
    // ...and it cannot be resurrected by approve.
    assert.throws(() => gate.approve({ id: rec.id, decidedBy: 'op@byte5.de' }), IllegalProposalTransitionError);
  });

  it('approves a pending proposal; approvedSpec carries the new tool', () => {
    const { gate } = makeGate();
    const rec = gate.submit({ pluginId: PLUGIN_ID, currentSpec: baseSpec(), proposal: cleanProposal(), submittedBy: 'agent:dynamics' });
    const approved = gate.approve({ id: rec.id, decidedBy: 'op@byte5.de' });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decidedBy, 'op@byte5.de');
    assert.equal(approved.approvedSpec?.tools.some((t) => t.id === 'dynamics_aggregate'), true);
  });

  it('accepts narrowing patches that TIGHTEN the surface', () => {
    const { gate, audit } = makeGate();
    const rec = gate.submit({ pluginId: PLUGIN_ID, currentSpec: baseSpec(), proposal: cleanProposal(), submittedBy: 'agent:dynamics' });
    const approved = gate.approve({
      id: rec.id,
      decidedBy: 'op@byte5.de',
      narrowingPatches: [{ op: 'remove', path: '/network/outbound/0' }],
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedSpec?.network.outbound.length, 0);
    assert.equal(audit.list({ proposalId: rec.id }).some((e) => e.type === 'narrowed'), true);
  });

  it('rejects narrowing patches that WIDEN the surface', () => {
    const { gate } = makeGate();
    const rec = gate.submit({ pluginId: PLUGIN_ID, currentSpec: baseSpec(), proposal: cleanProposal(), submittedBy: 'agent:dynamics' });
    assert.throws(
      () =>
        gate.approve({
          id: rec.id,
          decidedBy: 'op@byte5.de',
          narrowingPatches: [{ op: 'add', path: '/network/outbound/-', value: 'new.example.com' }],
        }),
      NarrowingWidensError,
    );
    // The record stays pending after a rejected narrowing.
    assert.equal(gate.get(rec.id)?.status, 'pending');
  });

  it('denies, then blocks double-decision', () => {
    const { gate } = makeGate();
    const rec = gate.submit({ pluginId: PLUGIN_ID, currentSpec: baseSpec(), proposal: cleanProposal(), submittedBy: 'agent:dynamics' });
    gate.deny(rec.id, 'op@byte5.de', 'not now');
    assert.equal(gate.get(rec.id)?.status, 'denied');
    assert.throws(() => gate.approve({ id: rec.id, decidedBy: 'op@byte5.de' }), IllegalProposalTransitionError);
  });

  it('markInstalled requires an approved record', () => {
    const { gate } = makeGate();
    const rec = gate.submit({ pluginId: PLUGIN_ID, currentSpec: baseSpec(), proposal: cleanProposal(), submittedBy: 'agent:dynamics' });
    assert.throws(() => gate.markInstalled(rec.id, '0.2.0'), IllegalProposalTransitionError);
    gate.approve({ id: rec.id, decidedBy: 'op@byte5.de' });
    const installed = gate.markInstalled(rec.id, '0.2.0');
    assert.equal(installed.status, 'installed');
  });
});

function dynManifest(): Plugin {
  return {
    id: PLUGIN_ID,
    depends_on: [],
    privacy_class: 'strict',
    permissions_summary: {
      memory_reads: [], memory_writes: [], graph_reads: [], graph_writes: [],
      network_outbound: ['api.dynamics.com'],
    },
  } as unknown as Plugin;
}

const deltaTpl: ExtensionTemplate = {
  id: 'odata.delta',
  title: 'Delta',
  description: 'change tracking',
  paramsSchema: { type: 'object' },
  requires: { networkOutbound: ['api.dynamics.com'] },
};

function tmpl(templateId: string) {
  return parseTemplateProposal({ pluginId: PLUGIN_ID, rationale: 'delta', templateId, params: { entitySet: 'salesorders' } });
}

describe('OperatorGate — template path', () => {
  it('submits a clean template proposal as pending (kind=template)', () => {
    const { gate } = makeGate();
    const rec = gate.submit({ kind: 'template', pluginId: PLUGIN_ID, plugin: dynManifest(), template: deltaTpl, proposal: tmpl('odata.delta'), submittedBy: 'agent' });
    assert.equal(rec.status, 'pending');
    assert.equal(rec.kind, 'template');
  });

  it('auto-denies a template requiring a new capability', () => {
    const { gate } = makeGate();
    const greedy: ExtensionTemplate = { ...deltaTpl, requires: { graphWrites: ['odoo:invoices:*'] } };
    const rec = gate.submit({ kind: 'template', pluginId: PLUGIN_ID, plugin: dynManifest(), template: greedy, proposal: tmpl('odata.delta'), submittedBy: 'agent' });
    assert.equal(rec.status, 'denied');
  });

  it('approve sets approvedExtension {templateId, params}; install marks installed', () => {
    const { gate } = makeGate();
    const rec = gate.submit({ kind: 'template', pluginId: PLUGIN_ID, plugin: dynManifest(), template: deltaTpl, proposal: tmpl('odata.delta'), submittedBy: 'agent' });
    const approved = gate.approve({ id: rec.id, decidedBy: 'op@byte5.de' });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedExtension?.templateId, 'odata.delta');
    assert.deepEqual(approved.approvedExtension?.params, { entitySet: 'salesorders' });
    const installed = gate.markInstalled(rec.id, 'template:odata.delta');
    assert.equal(installed.status, 'installed');
  });
});
