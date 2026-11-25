/**
 * ADR-0018 / spec 2042 §5.4 "One authorization" — a discussion needs mutual
 * consultation grants (and the peer switch) on EVERY start path, not only
 * from the chat, and a grant revoked mid-discussion refuses the next
 * utterance.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Step } from '@omadia/conductor-core';
import type { OrchestratorRegistry } from '@omadia/orchestrator';

import { DiscussionNotGrantedError, DiscussionPeerDisabledError } from '../src/conductor/discussionHere.js';
import { ConductorDiscussionService, DISCUSSION_AUTHORIZATION } from '../src/conductor/discussionService.js';
import type { EphemeralAttachment } from '../src/conductor/ephemeralAttachmentsStore.js';
import { RealStepEffects } from '../src/conductor/realStepEffects.js';
import { ConductorSayService } from '../src/conductor/sayService.js';

const IDENTITIES: Record<string, string> = { hr: '28:a', accounting: '28:b', sales: '28:c' };
const identityFor = (slug: string) => (IDENTITIES[slug] ? { channelKey: IDENTITIES[slug] } : undefined);

function discussionService(opts: {
  granted: ReadonlySet<string>;
  disabled?: ReadonlySet<string>;
  mutualGrant?: (a: string, b: string) => Promise<boolean>;
}) {
  const created: unknown[] = [];
  const service = new ConductorDiscussionService({
    identityFor,
    peerGate: async (_c, _k, slug) => !(opts.disabled ?? new Set()).has(slug),
    mutualGrant: opts.mutualGrant ?? (async (a, b) => opts.granted.has([a, b].sort().join('+'))),
    ephemeralRuns: {
      createEphemeralRun: async (input: unknown) => {
        created.push(input);
        return { runId: 'r', workflowId: 'wf', workflowSlug: 's', expiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
    } as never,
    attachments: {
      getByConversation: async () => undefined,
      upsertPending: async () => ({}) as EphemeralAttachment,
      attachToWorkflow: async () => undefined,
    } as never,
  });
  return { service, created };
}

const start = { channelType: 'teams', conversationId: 'conv-1', topic: 'Budget' };

describe('discussion start — one authorization on every path', () => {
  it('refuses a pair without mutual grants and starts nothing', async () => {
    const { service, created } = discussionService({ granted: new Set(['accounting+hr']) });
    await assert.rejects(
      service.start({ ...start, participants: ['hr', 'accounting', 'sales'] }),
      (err: unknown) => err instanceof DiscussionNotGrantedError && err.agentA === 'hr' && err.agentB === 'sales',
    );
    assert.equal(created.length, 0);
  });

  it('refuses a participant whose peer switch is off', async () => {
    const { service } = discussionService({ granted: new Set(['accounting+hr']), disabled: new Set(['accounting']) });
    await assert.rejects(service.start({ ...start, participants: ['hr', 'accounting'] }), DiscussionPeerDisabledError);
  });

  it('fails closed when the grant lookup throws', async () => {
    const { service } = discussionService({
      granted: new Set(),
      mutualGrant: async () => {
        throw new Error('db down');
      },
    });
    await assert.rejects(service.start({ ...start, participants: ['hr', 'accounting'] }), DiscussionNotGrantedError);
  });

  it('starts when every pair is granted', async () => {
    const { service, created } = discussionService({ granted: new Set(['accounting+hr']) });
    await service.start({ ...start, participants: ['hr', 'accounting'] });
    assert.equal(created.length, 1);
  });
});

describe('say — a revoked grant bites at the next utterance', () => {
  const attachment: EphemeralAttachment = {
    id: 'a',
    workflowId: 'wf-1',
    agentSlug: 'hr',
    channelType: 'teams',
    channelKey: 'conv-1',
    roleKey: null,
    state: 'attached',
    expiresAt: new Date(Date.now() + 60_000),
  };
  function sayService(granted: boolean) {
    const sent: string[] = [];
    const service = new ConductorSayService({
      attachments: { getByConversation: async () => attachment },
      providers: {
        get: () => ({
          channelType: 'teams',
          sendToConversation: async (_c: string, m: { text: string }) => {
            sent.push(m.text);
            return { outcome: 'delivered' as const };
          },
        }),
      } as never,
      identityFor,
      mutualGrant: async () => granted,
    });
    return { service, sent };
  }
  const input = {
    workflowId: 'wf-1',
    runId: 'run-1',
    agentSlug: 'hr',
    speaker: 'HR',
    channelType: 'teams',
    conversationId: 'conv-1',
    text: 'Beitrag',
  };

  it('refuses with not_granted and posts nothing', async () => {
    const { service, sent } = sayService(false);
    const outcome = await service.say({ ...input, participants: ['hr', 'accounting'] });
    assert.equal(outcome.said, false);
    assert.equal(outcome.said === false ? outcome.reason : undefined, 'not_granted');
    assert.deepEqual(sent, []);
  });

  it('delivers while the grants hold', async () => {
    const { service, sent } = sayService(true);
    assert.deepEqual(await service.say({ ...input, participants: ['hr', 'accounting'] }), { said: true });
    assert.deepEqual(sent, ['Beitrag']);
  });

  it('does not check grants for a say outside a discussion', async () => {
    const { service } = sayService(false);
    assert.deepEqual(await service.say(input), { said: true });
  });
});

describe('agent step — a revoked grant ends the discussion run', () => {
  function registry(turns: { n: number }): OrchestratorRegistry {
    const entry = {
      agent: { slug: 'hr', id: 'id-hr' },
      bindings: [],
      built: {
        bundle: {
          agent: {
            chat: async () => {
              turns.n += 1;
              return { text: 'Beitrag' };
            },
          },
        },
      },
    };
    return {
      get: (slug: string) => (slug === 'hr' ? entry : undefined),
      list: () => [entry],
      resolveByChannel: () => entry,
      identityForChannel: () => undefined,
      identityOwnerFor: () => undefined,
      channelIdentityFor: () => undefined,
    } as unknown as OrchestratorRegistry;
  }
  const step = { id: 'speak', kind: 'agent', agentId: 'hr', prompt: 'p', say: { channel: 'teams' } } as unknown as Step;
  const meta = { runId: 'run-1', workflowId: 'wf-1', triggerKind: 'manual' as const } as never;
  const discussionContext = {
    conversationId: 'conv-1',
    participants: ['hr', 'accounting'],
    authorization: DISCUSSION_AUTHORIZATION,
  };

  function effects(turns: { n: number }, ungranted: string | undefined, sayOutcome: unknown = { said: true }) {
    const said: Array<{ participants?: readonly string[] }> = [];
    return {
      said,
      effects: new RealStepEffects({
        getRegistry: () => registry(turns),
        say: {
          ungrantedPartner: async () => ungranted,
          say: async (i: { participants?: readonly string[] }) => {
            said.push(i);
            return sayOutcome;
          },
          startTyping: () => () => undefined,
        } as never,
      }),
    };
  }

  it('refuses before the agent works when a grant is gone', async () => {
    const turns = { n: 0 };
    const { effects: fx } = effects(turns, 'accounting');
    await assert.rejects(fx.runAgentStep(step, discussionContext, meta), /no longer hold consultation grants/);
    assert.equal(turns.n, 0, 'no agent turn after a revocation');
  });

  it('ends the run when the grant is revoked during the turn (say refuses)', async () => {
    const turns = { n: 0 };
    const { effects: fx, said } = effects(turns, undefined, { said: false, reason: 'not_granted', message: 'grants revoked' });
    await assert.rejects(fx.runAgentStep(step, discussionContext, meta), /grants revoked/);
    assert.deepEqual(said[0]?.participants, ['hr', 'accounting']);
  });

  it('checks nothing for a workflow that only happens to have participants', async () => {
    const turns = { n: 0 };
    const { effects: fx, said } = effects(turns, 'accounting');
    await fx.runAgentStep(step, { conversationId: 'conv-1', participants: ['hr', 'accounting'] }, meta);
    assert.equal(turns.n, 1);
    assert.equal(said[0]?.participants, undefined);
  });
});
