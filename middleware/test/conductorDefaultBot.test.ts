import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { OrchestratorRegistry } from '@omadia/orchestrator';
import type { Step } from '@omadia/conductor-core';

import {
  channelBotKey,
  resolveAddressedBot,
  speakingIdentityFor,
} from '../src/conductor/channelBotOwnership.js';
import { RealStepEffects } from '../src/conductor/realStepEffects.js';
import { ConductorSayService } from '../src/conductor/sayService.js';
import type { EphemeralAttachment } from '../src/conductor/ephemeralAttachmentsStore.js';

/**
 * The deployment's configured default Teams bot in the Conductor.
 *
 * Production (v0.170.0, 2026-10-07): three runs of the workflow `test-teams`
 * failed at their entry step `agent-4` with "addressed bot
 * '28:737c6ddd-…' resolves to no active Agent". That bot is the configured
 * default bot; normal chat routed it to the active agent `fallback`, but the
 * Conductor looked only at provisioned identities (`agent_teams_identities`),
 * where the default bot has no row — and its `say` step could not have spoken
 * back either (`channelIdentityFor` → none).
 */

const DEFAULT_BOT = '28:737c6ddd-6d4e-4599-8dc3-260281ea906e';
const HR_BOT = '28:aaaaaaaa-1111-2222-3333-444444444444';
const ORPHAN_BOT = '28:cccccccc-9999-8888-7777-666666666666';
const UNKNOWN_BOT = '28:dddddddd-0000-0000-0000-000000000000';

interface FakeWorld {
  /** active agent slugs */
  active: string[];
  /** provisioned identities: bot key → owning agent slug (may be inactive) */
  identities: Record<string, string>;
  /** channel_bindings: key → agent slug */
  bindings?: Record<string, string>;
  /** platform fallback agent slug */
  fallback?: string;
  ran?: string[];
}

/** A registry with the real lookup semantics of `OrchestratorRegistry`. */
function registry(world: FakeWorld): OrchestratorRegistry {
  const entry = (slug: string) => ({
    agent: { slug, id: `id-${slug}` },
    bindings: Object.entries(world.bindings ?? {})
      .filter(([, owner]) => owner === slug)
      .map(([channelKey]) => ({ channelType: 'teams', channelKey, agentId: `id-${slug}` })),
    built: {
      bundle: {
        agent: {
          chat: async () => {
            world.ran?.push(slug);
            return { text: `answered by ${slug}` };
          },
        },
      },
    },
  });
  const isActive = (slug: string | undefined): slug is string =>
    slug !== undefined && world.active.includes(slug);
  const identityForChannel = (type: string, key: string) => {
    const slug = type === 'teams' ? world.identities[key] : undefined;
    return isActive(slug) ? entry(slug) : undefined;
  };
  return {
    identityForChannel,
    identityOwnerFor: (type: string, key: string) => {
      const slug = type === 'teams' ? world.identities[key] : undefined;
      return slug ? `id-${slug}` : undefined;
    },
    resolveByChannel: (type: string, key: string) => {
      const owned = identityForChannel(type, key);
      if (owned) return owned;
      const bound = world.bindings?.[key];
      if (isActive(bound)) return entry(bound);
      return isActive(world.fallback) ? entry(world.fallback) : undefined;
    },
    channelIdentityFor: (slug: string, type: string) => {
      if (type !== 'teams' || !isActive(slug)) return undefined;
      const key = Object.keys(world.identities).find((k) => world.identities[k] === slug);
      return key ? { channelType: 'teams', channelKey: key } : undefined;
    },
    get: (slug: string) => (isActive(slug) ? entry(slug) : undefined),
    list: () => world.active.map(entry),
  } as unknown as OrchestratorRegistry;
}

const defaultBotKey = (type: string): string | undefined =>
  type === 'teams' ? DEFAULT_BOT : undefined;

const PRODUCTION: FakeWorld = {
  active: ['fallback', 'hr'],
  identities: { [HR_BOT]: 'hr', [ORPHAN_BOT]: 'deleted-agent' },
  fallback: 'fallback',
};

describe('channelBotOwnership — inbound: which agent is the addressed bot', () => {
  it('routes the configured default bot to the active fallback agent, as chat does', () => {
    assert.deepEqual(resolveAddressedBot(registry(PRODUCTION), 'teams', DEFAULT_BOT, defaultBotKey), {
      kind: 'agent',
      agentSlug: 'fallback',
      via: 'default-bot',
    });
  });

  it('routes the default bot through its channel binding before the fallback', () => {
    const world = { ...PRODUCTION, bindings: { [DEFAULT_BOT]: 'hr' } };
    const r = resolveAddressedBot(registry(world), 'teams', DEFAULT_BOT, defaultBotKey);
    assert.equal(r.kind === 'agent' && r.agentSlug, 'hr');
  });

  it('routes the default bot to the agent its CONVERSATION is bound to, as chat does', () => {
    // Chat in a conversation bound to `hr` answers as `hr` through the default
    // bot; a workflow started there must not get the fallback's permissions.
    const world = { ...PRODUCTION, bindings: { 'conv-hr': 'hr' } };
    const r = resolveAddressedBot(registry(world), 'teams', DEFAULT_BOT, defaultBotKey, 'conv-hr');
    assert.equal(r.kind === 'agent' && r.agentSlug, 'hr');
    const other = resolveAddressedBot(registry(world), 'teams', DEFAULT_BOT, defaultBotKey, 'conv-other');
    assert.equal(other.kind === 'agent' && other.agentSlug, 'fallback');
  });

  it('never lets a conversation binding override a provisioned bot', () => {
    const world = { ...PRODUCTION, active: [...PRODUCTION.active, 'sales'], bindings: { 'conv-1': 'sales' } };
    const r = resolveAddressedBot(registry(world), 'teams', HR_BOT, defaultBotKey, 'conv-1');
    assert.deepEqual(r, { kind: 'agent', agentSlug: 'hr', via: 'identity' });
  });

  it('keeps a provisioned owner first — even when it is also the configured default', () => {
    const r = resolveAddressedBot(registry(PRODUCTION), 'teams', HR_BOT, () => HR_BOT);
    assert.deepEqual(r, { kind: 'agent', agentSlug: 'hr', via: 'identity' });
  });

  it('refuses a provisioned bot whose agent is not active — never the fallback', () => {
    const r = resolveAddressedBot(registry(PRODUCTION), 'teams', ORPHAN_BOT, defaultBotKey);
    assert.equal(r.kind, 'refused');
    assert.equal(r.kind === 'refused' && r.reason, 'identity-unavailable');
  });

  it('refuses an orphaned provisioned bot even if it is configured as the default', () => {
    const r = resolveAddressedBot(registry(PRODUCTION), 'teams', ORPHAN_BOT, () => ORPHAN_BOT);
    assert.equal(r.kind === 'refused' && r.reason, 'identity-unavailable');
  });

  it('refuses an unknown bot although a fallback agent exists', () => {
    const r = resolveAddressedBot(registry(PRODUCTION), 'teams', UNKNOWN_BOT, defaultBotKey);
    assert.equal(r.kind === 'refused' && r.reason, 'unknown-bot');
  });

  it('refuses the default bot when no default is configured', () => {
    const r = resolveAddressedBot(registry(PRODUCTION), 'teams', DEFAULT_BOT, undefined);
    assert.equal(r.kind === 'refused' && r.reason, 'unknown-bot');
  });

  it('refuses the default bot when neither a binding nor a fallback agent is active', () => {
    const world = { ...PRODUCTION, fallback: undefined };
    const r = resolveAddressedBot(registry(world), 'teams', DEFAULT_BOT, defaultBotKey);
    assert.equal(r.kind === 'refused' && r.reason, 'no-agent');
  });

  it('matches the key case-insensitively, as the Teams plugin stores it', () => {
    assert.equal(channelBotKey(' 28:ABC-Def '), '28:abc-def');
    const r = resolveAddressedBot(registry(PRODUCTION), 'teams', DEFAULT_BOT.toUpperCase(), defaultBotKey);
    assert.equal(r.kind === 'agent' && r.agentSlug, 'fallback');
  });
});

describe('channelBotOwnership — outbound: which bot an agent speaks as', () => {
  it('lets the fallback agent speak through the default bot it answers for', () => {
    assert.deepEqual(speakingIdentityFor(registry(PRODUCTION), 'fallback', 'teams', defaultBotKey), {
      channelType: 'teams',
      channelKey: DEFAULT_BOT,
    });
  });

  it('keeps a provisioned agent on its own bot', () => {
    assert.deepEqual(speakingIdentityFor(registry(PRODUCTION), 'hr', 'teams', defaultBotKey), {
      channelType: 'teams',
      channelKey: HR_BOT,
    });
  });

  it('never lends the default bot to an agent it does not route to', () => {
    const world = { ...PRODUCTION, active: [...PRODUCTION.active, 'sales'] };
    assert.equal(speakingIdentityFor(registry(world), 'sales', 'teams', defaultBotKey), undefined);
    assert.equal(speakingIdentityFor(registry(PRODUCTION), 'fallback', 'teams', undefined), undefined);
  });
});

// --- end to end: default bot → Conductor → active agent → Teams delivery ---

const TEAMS_EVENT = {
  runId: 'run-1',
  workflowId: 'wf-test-teams',
  triggerKind: 'event' as const,
  triggerEventId: 'teams.message.posted',
};

const attachment: EphemeralAttachment = {
  id: 'att-1',
  workflowId: 'wf-test-teams',
  agentSlug: 'fallback',
  channelType: 'teams',
  channelKey: 'conv-1',
  roleKey: null,
  state: 'attached',
  expiresAt: new Date(Date.now() + 60_000),
};

function conductor(world: FakeWorld, withDefault = true) {
  const reg = registry(world);
  const sent: Array<{ conversationId: string; text: string; asChannelKey?: string }> = [];
  const say = new ConductorSayService({
    attachments: { getByConversation: async () => attachment },
    providers: {
      get: () => ({
        channelType: 'teams',
        async sendToConversation(
          conversationId: string,
          message: { text: string },
          opts?: { asChannelKey?: string },
        ) {
          sent.push({ conversationId, text: message.text, ...(opts?.asChannelKey ? { asChannelKey: opts.asChannelKey } : {}) });
          return { outcome: 'delivered' as const };
        },
      }),
    },
    identityFor: (slug, channelType, conversationId) =>
      speakingIdentityFor(reg, slug, channelType, withDefault ? defaultBotKey : undefined, conversationId),
  });
  const effects = new RealStepEffects({
    getRegistry: () => reg,
    ...(withDefault ? { defaultChannelBotKey: defaultBotKey } : {}),
    say,
  });
  return { effects, sent };
}

const sayingStep = (agentId: string): Step =>
  ({ id: 'agent-4', kind: 'agent', agentId, prompt: 'do it', say: { channel: 'teams' } }) as unknown as Step;

describe('Conductor — a run started through the default bot', () => {
  it('runs the fallback agent and delivers its answer through the default bot', async () => {
    const world: FakeWorld = { ...PRODUCTION, ran: [] };
    const { effects, sent } = conductor(world);
    const out = await effects.runAgentStep(
      sayingStep('fallback'),
      { botId: DEFAULT_BOT, conversationId: 'conv-1' },
      TEAMS_EVENT,
    );
    assert.deepEqual(world.ran, ['fallback']);
    assert.equal((out.result as { said?: boolean }).said, true);
    assert.deepEqual(sent, [
      { conversationId: 'conv-1', text: 'answered by fallback', asChannelKey: DEFAULT_BOT },
    ]);
  });

  it('in a bound conversation runs the bound agent, speaks as it, and refuses the fallback', async () => {
    const world: FakeWorld = { ...PRODUCTION, bindings: { 'conv-1': 'hr' }, ran: [] };
    const { effects, sent } = conductor(world);
    await assert.rejects(
      effects.runAgentStep(sayingStep('fallback'), { botId: DEFAULT_BOT, conversationId: 'conv-1' }, TEAMS_EVENT),
      /addressed to Agent 'hr'/,
    );
    assert.deepEqual(world.ran, []);
    await effects.runAgentStep(sayingStep('hr'), { botId: DEFAULT_BOT, conversationId: 'conv-1' }, TEAMS_EVENT);
    assert.deepEqual(world.ran, ['hr']);
    // `hr` has its own provisioned bot and speaks through it.
    assert.equal(sent[0]?.asChannelKey, HR_BOT);
  });

  it('refuses a step configured for another agent than the default bot routes to', async () => {
    const world: FakeWorld = { ...PRODUCTION, ran: [] };
    const { effects, sent } = conductor(world);
    await assert.rejects(
      effects.runAgentStep(sayingStep('hr'), { botId: DEFAULT_BOT, conversationId: 'conv-1' }, TEAMS_EVENT),
      /addressed to Agent 'fallback'/,
    );
    assert.deepEqual(world.ran, []);
    assert.deepEqual(sent, []);
  });

  it('refuses an unknown bot and an orphaned provisioned bot — nothing runs, nothing is said', async () => {
    for (const botId of [UNKNOWN_BOT, ORPHAN_BOT]) {
      const world: FakeWorld = { ...PRODUCTION, ran: [] };
      const { effects, sent } = conductor(world);
      await assert.rejects(
        effects.runAgentStep(sayingStep('fallback'), { botId, conversationId: 'conv-1' }, TEAMS_EVENT),
        /resolves to no active Agent/,
        botId,
      );
      assert.deepEqual(world.ran, [], botId);
      assert.deepEqual(sent, [], botId);
    }
  });

  it('without a configured default bot it stays refused, as before', async () => {
    const world: FakeWorld = { ...PRODUCTION, ran: [] };
    const { effects } = conductor(world, false);
    await assert.rejects(
      effects.runAgentStep(sayingStep('fallback'), { botId: DEFAULT_BOT, conversationId: 'conv-1' }, TEAMS_EVENT),
      /resolves to no active Agent/,
    );
    assert.deepEqual(world.ran, []);
  });
});
