/**
 * Spec 2042 §5.11 — the discretion core: labels, the turn label set, the flow
 * rule at every egress and the disclosure levels. Pure functions; the wiring
 * into turns, consultations and tool dispatch is pinned in the neighbouring
 * test files.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EVERYONE,
  UNKNOWN_READERS,
  parseLabelSet,
  readersOf,
  serializeLabelSet,
  unionLabels,
  type DiscretionLabel,
} from '../../packages/harness-orchestrator/src/discretion/labels.js';
import { checkFlow, violationSummary } from '../../packages/harness-orchestrator/src/discretion/flowRule.js';
import {
  decideDisclosure,
  existenceText,
  levelFor,
  parseDisclosurePolicy,
} from '../../packages/harness-orchestrator/src/discretion/disclosure.js';

const hrChat: DiscretionLabel = {
  kind: 'context',
  key: 'teams:hr-group',
  readers: readersOf(['hr-1', 'hr-2']),
};
const hrSystem: DiscretionLabel = { kind: 'source', system: '@omadia/odoo-hr', restricted: true };

test('the label set merges per id and keeps the strictest readers', () => {
  const set = unionLabels(
    [{ kind: 'context', key: 'k', readers: readersOf(['a', 'b', 'c']) }],
    [{ kind: 'context', key: 'k', readers: readersOf(['b', 'c', 'd']) }],
    [{ kind: 'source', system: 's', restricted: false }],
    [{ kind: 'source', system: 's', restricted: true }],
  );
  assert.deepEqual(set.labels, [
    { kind: 'context', key: 'k', readers: { kind: 'set', ids: ['b', 'c'] } },
    { kind: 'source', system: 's', restricted: true },
  ]);
  const unknown = unionLabels([hrChat], [{ kind: 'context', key: hrChat.key, readers: UNKNOWN_READERS }]);
  assert.deepEqual(unknown.labels[0], { kind: 'context', key: hrChat.key, readers: UNKNOWN_READERS });
});

test('a persisted label set round-trips, and a damaged one fails closed', () => {
  const set = unionLabels([hrChat, hrSystem, { kind: 'classification', class: 'personal' }]);
  assert.deepEqual(parseLabelSet(JSON.parse(JSON.stringify(serializeLabelSet(set)))), set);
  for (const damaged of [null, 'x', [{ kind: 'context' }], [{ kind: 'nope' }], new Array(300).fill(hrSystem)]) {
    const parsed = parseLabelSet(damaged);
    assert.equal(parsed.labels.length, 1);
    assert.deepEqual(parsed.labels[0], { kind: 'context', key: 'unreadable', readers: UNKNOWN_READERS });
    // ...and the unreadable label blocks every flow to people.
    assert.equal(checkFlow(parsed, { kind: 'people', readers: readersOf(['a']) }).allowed, false);
  }
});

test('people: the answer flows only when every reader may know every context', () => {
  const labels = unionLabels([hrChat]);
  assert.equal(checkFlow(labels, { kind: 'people', readers: readersOf(['hr-1']) }).allowed, true);
  assert.equal(checkFlow(labels, { kind: 'people', readers: readersOf(['hr-1', 'hr-2']) }).allowed, true);
  const sales = checkFlow(labels, { kind: 'people', readers: readersOf(['hr-1', 'sales-1']) });
  assert.equal(sales.allowed, false);
  assert.deepEqual(violationSummary(sales), ['context:teams:hr-group:readers_not_covered']);
  // An unknown room never receives restricted context ...
  assert.equal(checkFlow(labels, { kind: 'people', readers: UNKNOWN_READERS }).allowed, false);
  // ... but the conversation's own context always passes back to it.
  assert.equal(
    checkFlow(labels, { kind: 'people', contextKey: hrChat.key, readers: UNKNOWN_READERS }).allowed,
    true,
  );
  // Tenant-wide knowledge flows anywhere.
  const open = unionLabels([{ kind: 'context', key: 'wiki', readers: EVERYONE }]);
  assert.equal(checkFlow(open, { kind: 'people', readers: UNKNOWN_READERS }).allowed, true);
});

test('agent: the receiving agent needs its own grant for every source', () => {
  const labels = unionLabels([hrSystem]);
  const egress = { kind: 'agent', agentId: 'a', contextKey: 'x', readers: readersOf(['u']) } as const;
  assert.equal(checkFlow(labels, { ...egress, grantedSystems: new Set(['@omadia/odoo-hr']) }).allowed, true);
  const refused = checkFlow(labels, { ...egress, grantedSystems: new Set(['@omadia/crm']) });
  assert.deepEqual(violationSummary(refused), ['source:@omadia/odoo-hr:agent_lacks_grant']);
});

test('criterion 17: an HR record never reaches a CRM whose readership does not accept HR', () => {
  // A 1:1 with the HR manager, who read an HR record through the agent's grant.
  const oneToOne: DiscretionLabel = { kind: 'context', key: 'teams:dm-hr', readers: readersOf(['hr-1']) };
  const labels = unionLabels([oneToOne, hrSystem]);
  const crm = {
    kind: 'integration',
    system: '@omadia/crm',
    currentContextKey: oneToOne.key,
    readership: { readers: EVERYONE, acceptsSystems: ['@omadia/crm'], acceptsClassifications: [] },
  } as const;
  const decision = checkFlow(labels, crm);
  assert.equal(decision.allowed, false);
  assert.deepEqual(violationSummary(decision), ['source:@omadia/odoo-hr:integration_readership']);
  // Without any declaration the CRM gets nothing restricted either.
  const { readership: _r, ...undeclared } = crm;
  assert.deepEqual(violationSummary(checkFlow(labels, undeclared)), [
    'source:@omadia/odoo-hr:integration_undeclared',
  ]);
  // The manager's own words in this 1:1 may be written (no restricted source read).
  assert.equal(checkFlow(unionLabels([oneToOne]), crm).allowed, true);
  // Writing back to the HR system itself is not a cross-system flow.
  assert.equal(checkFlow(labels, { ...crm, system: '@omadia/odoo-hr' }).allowed, true);
  // A readership that accepts HR data, read by HR only, takes it.
  assert.equal(
    checkFlow(labels, {
      ...crm,
      readership: {
        readers: readersOf(['hr-1']),
        acceptsSystems: ['@omadia/odoo-hr'],
        acceptsClassifications: [],
      },
    }).allowed,
    true,
  );
});

test('criterion 27: a summary that kept the HR label is refused weeks later', () => {
  // The 1:1 turn was summarised into memory with its label set ...
  const persisted = serializeLabelSet(
    unionLabels([{ kind: 'context', key: 'teams:dm-hr', readers: readersOf(['hr-1']) }, hrSystem]),
  );
  // ... and recalled into a later turn in another conversation.
  const later = unionLabels(
    [{ kind: 'context', key: 'teams:dm-hr-2', readers: readersOf(['hr-1']) }],
    parseLabelSet(persisted),
  );
  const crmWrite = checkFlow(later, {
    kind: 'integration',
    system: '@omadia/crm',
    currentContextKey: 'teams:dm-hr-2',
    readership: { readers: EVERYONE, acceptsSystems: [], acceptsClassifications: [] },
  });
  assert.equal(crmWrite.allowed, false);
  assert.ok(violationSummary(crmWrite).includes('context:teams:dm-hr:integration_readership'));
  assert.ok(violationSummary(crmWrite).includes('source:@omadia/odoo-hr:integration_readership'));
  const consultation = checkFlow(later, {
    kind: 'agent',
    agentId: 'sales',
    grantedSystems: new Set(),
    contextKey: 'teams:sales',
    readers: readersOf(['sales-1']),
  });
  assert.equal(consultation.allowed, false);
});

test('criterion 18: an answer whose label set exceeds the group is refused as a whole', () => {
  const labels = unionLabels([
    { kind: 'context', key: 'teams:group', readers: readersOf(['a', 'b', 'c']) },
    { kind: 'context', key: 'members:ab', readers: readersOf(['a', 'b']) },
  ]);
  assert.equal(
    checkFlow(labels, { kind: 'people', contextKey: 'teams:group', readers: readersOf(['a', 'b', 'c']) }).allowed,
    false,
  );
});

test('memory: a write lands only where every reader of the tier may know it', () => {
  const labels = unionLabels([hrChat]);
  assert.equal(checkFlow(labels, { kind: 'memory', readers: readersOf(['hr-2']) }).allowed, true);
  assert.equal(checkFlow(labels, { kind: 'memory', readers: readersOf(['hr-2', 'x']) }).allowed, false);
});

test('classified data seen unmasked never flows to another agent or an undeclared integration', () => {
  const labels = unionLabels([{ kind: 'classification', class: 'personal' }]);
  assert.equal(
    checkFlow(labels, { kind: 'agent', agentId: 'b', grantedSystems: new Set(), readers: EVERYONE }).allowed,
    false,
  );
  assert.equal(checkFlow(labels, { kind: 'integration', system: 'mail' }).allowed, false);
  assert.equal(
    checkFlow(labels, {
      kind: 'integration',
      system: 'mail',
      readership: { readers: readersOf(['a']), acceptsSystems: [], acceptsClassifications: ['personal'] },
    }).allowed,
    true,
  );
});

test('disclosure policies validate and fall through from specific to default to none', () => {
  assert.deepEqual(parseDisclosurePolicy(undefined), {});
  assert.equal(parseDisclosurePolicy({ context: 'everything' }), undefined);
  assert.equal(parseDisclosurePolicy(['full']), undefined);
  const policy = parseDisclosurePolicy({ 'source:@omadia/odoo-hr': 'existence', source: 'full' });
  assert.ok(policy);
  assert.equal(levelFor(policy, hrSystem), 'existence');
  assert.equal(levelFor(policy, { kind: 'source', system: 'other', restricted: false }), 'full');
  assert.equal(levelFor(policy, hrChat), 'none');
  assert.equal(levelFor({ default: 'redacted' }, hrChat), 'redacted');
});

test('criterion 16: knowledge from the HR chat reaches a sales consultation only as existence', () => {
  const contribution = unionLabels([hrChat]);
  const requester = unionLabels([{ kind: 'context', key: 'teams:sales', readers: readersOf(['sales-1']) }]);
  const flow = checkFlow(contribution, {
    kind: 'agent',
    agentId: 'a',
    grantedSystems: new Set(),
    contextKey: 'teams:sales',
    readers: readersOf(['sales-1']),
  });
  assert.equal(flow.allowed, false);
  const base = { contribution, requester, requesterSystems: new Set<string>(), flow };
  // Default: nothing at all.
  assert.deepEqual(decideDisclosure({ ...base, policy: {} }), { kind: 'none' });
  // `existence`: only that the colleague can help.
  assert.deepEqual(decideDisclosure({ ...base, policy: { context: 'existence' } }), { kind: 'existence' });
  // Even `full` never delivers a refused flow.
  assert.deepEqual(decideDisclosure({ ...base, policy: { context: 'full' } }), { kind: 'existence' });
  assert.equal(existenceText('Hanna', 'en'), 'Hanna can help with this, but not here. Best ask Hanna directly.');
  assert.match(existenceText('Hanna', 'de-DE'), /^Hanna kann dazu etwas beitragen/);
});

test('a contribution adds nothing new: delivered in full; novel knowledge is capped by the grant', () => {
  const requester = unionLabels([{ kind: 'context', key: 'teams:sales', readers: readersOf(['s']) }]);
  const ownOnly = { contribution: requester, requester, requesterSystems: new Set<string>(), flow: { allowed: true } as const };
  assert.deepEqual(decideDisclosure({ ...ownOnly, policy: {} }), { kind: 'deliver', view: 'full' });
  // B used a system A holds a grant for itself: no access gained, delivered.
  const crm: DiscretionLabel = { kind: 'source', system: '@omadia/crm', restricted: false };
  const viaCrm = { ...ownOnly, contribution: unionLabels(requester, [crm]) };
  assert.deepEqual(
    decideDisclosure({ ...viaCrm, requesterSystems: new Set(['@omadia/crm']), policy: {} }),
    { kind: 'deliver', view: 'full' },
  );
  // Knowledge new to A, flow allowed: the grant's level decides.
  const memory: DiscretionLabel = { kind: 'context', key: 'members:x', readers: readersOf(['s']) };
  const novel = { ...ownOnly, contribution: unionLabels(requester, [memory]) };
  assert.deepEqual(decideDisclosure({ ...novel, policy: {} }), { kind: 'none' });
  assert.deepEqual(decideDisclosure({ ...novel, policy: { context: 'redacted' } }), { kind: 'deliver', view: 'redacted' });
  assert.deepEqual(decideDisclosure({ ...novel, policy: { context: 'aggregate' } }), { kind: 'existence' });
  assert.deepEqual(decideDisclosure({ ...novel, policy: { context: 'full' } }), { kind: 'deliver', view: 'full' });
});
