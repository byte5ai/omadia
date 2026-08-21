import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { AggregateHolderLookup, TargetedSendProvider } from '@omadia/channel-sdk';

import { createTargetedDeliveryService } from '../src/channels/targetedDeliveryService.js';
import { TargetedSendRegistry } from '../src/channels/targetedSendRegistry.js';

// #330 B3 — Principal fan-out semantics: one delivery per current role holder
// (notification, no quorum), partial surfaced, empty role = diagnostic, never
// a silent drop or a throw.

function lookup(holders: string[], partial = false): AggregateHolderLookup {
  return { holders, partial, bySource: [] };
}

function harness(opts?: {
  unreachableFor?: string[];
  holders?: AggregateHolderLookup;
  resolverError?: Error;
  noResolver?: boolean;
  noProvider?: boolean;
  refs?: Map<string, unknown>;
}): {
  service: ReturnType<typeof createTargetedDeliveryService>;
  sent: Array<{ principalId: string; conversationRef?: unknown }>;
} {
  const sent: Array<{ principalId: string; conversationRef?: unknown }> = [];
  const providers = new TargetedSendRegistry();
  if (!opts?.noProvider) {
    const provider: TargetedSendProvider = {
      channelType: 'teams',
      sendToUser: async (target) => {
        sent.push(target);
        if (opts?.unreachableFor?.includes(target.principalId)) {
          return { outcome: 'unreachable', code: 'no_binding', message: 'no 1:1 conversation known' };
        }
        return { outcome: 'delivered' };
      },
    };
    providers.register('plugin-teams', provider);
  }

  const service = createTargetedDeliveryService({
    providers,
    ...(opts?.noResolver
      ? {}
      : {
          resolveRoleHolders: async () => {
            if (opts?.resolverError) throw opts.resolverError;
            return opts?.holders ?? lookup([]);
          },
        }),
    ...(opts?.refs ? { lookupConversationRefs: async () => opts.refs! } : {}),
  });
  return { service, sent };
}

describe('TargetedSendRegistry ownership', () => {
  it('rejects a FOREIGN replace — delivery redirection is security-relevant', () => {
    const providers = new TargetedSendRegistry();
    const mine: TargetedSendProvider = { channelType: 'teams', sendToUser: async () => ({ outcome: 'delivered' }) };
    const thief: TargetedSendProvider = { channelType: 'teams', sendToUser: async () => ({ outcome: 'delivered' }) };
    providers.register('plugin-a', mine);
    assert.throws(() => providers.register('plugin-b', thief), /already owned by channel 'plugin-a'/);
    assert.equal(providers.get('teams'), mine);
    // Re-registering your OWN provider (re-activate / upgrade) stays allowed.
    providers.register('plugin-a', thief);
    assert.equal(providers.get('teams'), thief);
  });
});

describe('targeted delivery — user principal', () => {
  it('delivers exactly once to the canonicalized user', async () => {
    const { service, sent } = harness();
    const report = await service.sendToPrincipal({
      channelType: 'teams',
      principal: 'user:Jane@Co.com ',
      message: { text: 'hi' },
    });

    assert.deepEqual(report.resolution, { kind: 'single-user' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.principalId, 'jane@co.com');
    assert.deepEqual(report.deliveries, [{ principalId: 'jane@co.com', outcome: { outcome: 'delivered' } }]);
    assert.deepEqual(report.diagnostics, []);
  });

  it('passes the cached conversationRef through when the kernel has one', async () => {
    const refs = new Map<string, unknown>([['jane@co.com', { convId: 'c-1' }]]);
    const { service, sent } = harness({ refs });
    await service.sendToPrincipal({ channelType: 'teams', principal: 'user:jane@co.com', message: { text: 'hi' } });
    assert.deepEqual(sent[0]!.conversationRef, { convId: 'c-1' });
  });

  it("reports 'invalid_principal' for garbage — no throw", async () => {
    const { service, sent } = harness();
    const report = await service.sendToPrincipal({ channelType: 'teams', principal: 'banana', message: { text: 'x' } });
    assert.equal(report.diagnostics[0]?.code, 'invalid_principal');
    assert.equal(sent.length, 0);
  });

  it("reports 'no_targeted_send_provider' for an unserved channel type", async () => {
    const { service } = harness({ noProvider: true });
    const report = await service.sendToPrincipal({ channelType: 'teams', principal: 'user:jane@co.com', message: { text: 'x' } });
    assert.equal(report.diagnostics[0]?.code, 'no_targeted_send_provider');
    assert.deepEqual(report.deliveries, []);
  });
});

describe('targeted delivery — role principal (late-bound fan-out, no quorum)', () => {
  it('a role with two holders produces exactly two deliveries', async () => {
    const { service, sent } = harness({ holders: lookup(['a@co.com', 'b@co.com']) });
    const report = await service.sendToPrincipal({ channelType: 'teams', principal: 'role:management', message: { text: 'report' } });

    assert.deepEqual(report.resolution, { kind: 'role', holders: ['a@co.com', 'b@co.com'], partial: false });
    assert.equal(sent.length, 2);
    assert.deepEqual(report.deliveries.map((d) => d.principalId), ['a@co.com', 'b@co.com']);
    assert.deepEqual(report.diagnostics, []);
  });

  it("an empty role yields zero deliveries + 'role_has_no_holders' — no silent drop, no throw", async () => {
    const { service, sent } = harness({ holders: lookup([]) });
    const report = await service.sendToPrincipal({ channelType: 'teams', principal: 'role:management', message: { text: 'x' } });

    assert.equal(sent.length, 0);
    assert.equal(report.diagnostics[0]?.code, 'role_has_no_holders');
  });

  it('a partial holder list is surfaced AND the known holders are still delivered to', async () => {
    const { service, sent } = harness({ holders: lookup(['a@co.com'], true) });
    const report = await service.sendToPrincipal({ channelType: 'teams', principal: 'role:management', message: { text: 'x' } });

    assert.equal(sent.length, 1);
    assert.deepEqual(report.resolution, { kind: 'role', holders: ['a@co.com'], partial: true });
    assert.equal(report.diagnostics[0]?.code, 'role_resolution_partial');
  });

  it('one unreachable holder gets a per-holder diagnostic while the second is still delivered', async () => {
    const { service } = harness({ holders: lookup(['a@co.com', 'b@co.com']), unreachableFor: ['a@co.com'] });
    const report = await service.sendToPrincipal({ channelType: 'teams', principal: 'role:management', message: { text: 'x' } });

    assert.deepEqual(
      report.deliveries.map((d) => ({ id: d.principalId, ok: d.outcome.outcome === 'delivered' })),
      [{ id: 'a@co.com', ok: false }, { id: 'b@co.com', ok: true }],
    );
    const diag = report.diagnostics.find((d) => d.code === 'holder_unreachable');
    assert.equal(diag?.principalId, 'a@co.com');
  });

  it("without a role resolver (no Postgres) roles degrade to 'role_resolution_unavailable' while users keep working", async () => {
    const { service, sent } = harness({ noResolver: true });
    const roleReport = await service.sendToPrincipal({ channelType: 'teams', principal: 'role:management', message: { text: 'x' } });
    assert.equal(roleReport.diagnostics[0]?.code, 'role_resolution_unavailable');
    assert.equal(sent.length, 0);

    const userReport = await service.sendToPrincipal({ channelType: 'teams', principal: 'user:jane@co.com', message: { text: 'x' } });
    assert.deepEqual(userReport.deliveries, [{ principalId: 'jane@co.com', outcome: { outcome: 'delivered' } }]);
  });

  it("a throwing resolver is reported as 'role_resolution_unavailable', not thrown", async () => {
    const { service } = harness({ resolverError: new Error('graph down') });
    const report = await service.sendToPrincipal({ channelType: 'teams', principal: 'role:management', message: { text: 'x' } });
    assert.equal(report.diagnostics[0]?.code, 'role_resolution_unavailable');
    assert.ok(report.diagnostics[0]?.message.includes('graph down'));
  });
});
