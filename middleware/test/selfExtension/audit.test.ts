import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  SelfExtensionAudit,
  type SelfExtensionAuditEvent,
} from '../../src/plugins/selfExtension/audit.js';

describe('SelfExtensionAudit', () => {
  it('appends with monotonic seq and an injected clock', () => {
    let t = 100;
    const audit = new SelfExtensionAudit({ now: () => t });
    audit.record({ type: 'proposed', pluginId: 'p', proposalId: 'x', actor: 'a', detail: 'd' });
    t = 200;
    audit.record({ type: 'approved', pluginId: 'p', proposalId: 'x', actor: 'op', detail: 'd' });
    const events = audit.list();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
    assert.deepEqual(events.map((e) => e.at), [100, 200]);
  });

  it('filters by proposalId and pluginId', () => {
    const audit = new SelfExtensionAudit({ now: () => 0 });
    audit.record({ type: 'proposed', pluginId: 'p1', proposalId: 'a', actor: 'x', detail: '' });
    audit.record({ type: 'proposed', pluginId: 'p2', proposalId: 'b', actor: 'x', detail: '' });
    assert.equal(audit.list({ proposalId: 'a' }).length, 1);
    assert.equal(audit.list({ pluginId: 'p2' }).length, 1);
  });

  it('carries escalations on a denial event', () => {
    const audit = new SelfExtensionAudit({ now: () => 0 });
    audit.record({
      type: 'denied_escalation',
      pluginId: 'p',
      proposalId: 'a',
      actor: 'system',
      detail: 'escalation',
      escalations: [{ dimension: 'graph.writes', item: 'odoo:*', reason: 'r' }],
    });
    assert.equal(audit.list()[0]?.escalations?.[0]?.dimension, 'graph.writes');
  });

  it('mirrors to a sink and survives a throwing sink', () => {
    const seen: SelfExtensionAuditEvent[] = [];
    const audit = new SelfExtensionAudit({
      now: () => 0,
      sink: (e) => {
        seen.push(e);
        throw new Error('sink boom');
      },
    });
    // Must not throw despite the sink throwing.
    audit.record({ type: 'installed', pluginId: 'p', proposalId: 'a', actor: 's', detail: 'd' });
    assert.equal(seen.length, 1);
    assert.equal(audit.list().length, 1);
  });
});
