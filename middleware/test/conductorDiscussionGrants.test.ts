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
import { ConductorDiscussionService } from '../src/conductor/discussionService.js';
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

describe('agent step — a not_granted say ends the run', () => {
  function registry(): OrchestratorRegistry {
    const entry = {
      agent: { slug: 'hr', id: 'id-hr' },
      bindings: [],
      built: { bundle: { agent: { chat: async () => ({ text: 'Beitrag' }) } } },
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

  it('throws so the discussion stops instead of running on silently', async () => {
    let seen: readonly string[] | undefined;
    const effects = new RealStepEffects({
      getRegistry: () => registry(),
      say: {
        say: async (i: { participants?: readonly string[] }) => {
          seen = i.participants;
          return { said: false, reason: 'not_granted', message: 'grants revoked' };
        },
        startTyping: () => () => undefined,
      } as never,
    });
    await assert.rejects(
      effects.runAgentStep(step, { conversationId: 'conv-1', participants: ['hr', 'accounting'] }, meta),
      /grants revoked/,
    );
    assert.deepEqual(seen, ['hr', 'accounting']);
  });
});
