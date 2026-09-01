import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { JsonObject, Step } from '@omadia/conductor-core';
import type { OrchestratorRegistry } from '@omadia/orchestrator';

import { RealStepEffects } from '../src/conductor/realStepEffects.js';

/**
 * WORK STARTED BY A MESSAGE TO A BOT RUNS AS THAT BOT'S AGENT.
 *
 * The failure this pins was live and invisible. A person addressed one bot in a
 * group chat; a workflow subscribed to `teams.message.posted` ran its agent
 * step as the platform FALLBACK agent — which is granted every installed
 * plugin — and answered with data the addressed bot's own agent had no grant
 * for. Nothing in the chat distinguished the two: the reply carried the
 * addressed bot's name and avatar.
 *
 * The rule is deliberately not a warning and not a capability intersection.
 * Both leave the outcome depending on how somebody configured a graph. Here the
 * addressed bot's agent runs, or nothing runs.
 */

const CHAT_BOT_KEY = '28:19ad2729-f7d3-4099-9d2a-7da1230c9533';

function registryWith(
  botKey: string,
  ownerSlug: string,
  ran: { slugs: string[] },
): OrchestratorRegistry {
  const entryFor = (slug: string) => ({
    agent: { slug, id: `id-${slug}` },
    built: {
      bundle: {
        agent: {
          chat: async () => {
            ran.slugs.push(slug);
            return { text: `answered by ${slug}` };
          },
        },
      },
    },
  });
  return {
    identityForChannel: (channelType: string, key: string) =>
      channelType === 'teams' && key === botKey ? entryFor(ownerSlug) : undefined,
    get: (slug: string) => entryFor(slug),
  } as unknown as OrchestratorRegistry;
}

function agentStep(agentId: string): Step {
  return { id: 'agent-4', kind: 'agent', agentId, prompt: 'do it' } as unknown as Step;
}

const TEAMS_EVENT = {
  runId: 'run-1',
  triggerKind: 'event' as const,
  triggerEventId: 'teams.message.posted',
};

describe('conductor — a channel-triggered step runs as the addressed bot', () => {
  it('refuses a step configured for a DIFFERENT agent than the bot addressed', async () => {
    // The production shape: the message went to `messias`, the workflow says
    // `fallback`, and `fallback` holds every plugin in the deployment.
    const ran = { slugs: [] as string[] };
    const effects = new RealStepEffects({
      getRegistry: () => registryWith(CHAT_BOT_KEY, 'messias', ran),
    });

    const context: JsonObject = { botId: CHAT_BOT_KEY, text: 'Urlaub?' };
    await assert.rejects(
      effects.runAgentStep(agentStep('fallback'), context, TEAMS_EVENT),
      /addressed to Agent 'messias'/,
    );
    // The turn must never have started — a refusal after the fact is not a
    // refusal, the tool calls have already happened.
    assert.deepEqual(ran.slugs, []);
  });

  it('runs when the step IS the addressed bot’s agent', async () => {
    // The other half. Without it the guard could refuse everything and the
    // test above would still pass.
    const ran = { slugs: [] as string[] };
    const effects = new RealStepEffects({
      getRegistry: () => registryWith(CHAT_BOT_KEY, 'messias', ran),
    });

    const exec = await effects.runAgentStep(
      agentStep('messias'),
      { botId: CHAT_BOT_KEY },
      TEAMS_EVENT,
    );
    assert.deepEqual(ran.slugs, ['messias']);
    assert.deepEqual(exec.actor, { kind: 'agent', agentSlug: 'messias' });
  });

  it('refuses a channel-triggered run whose payload names no bot', async () => {
    // FAIL-CLOSED, and this is the case that matters most in practice: the
    // plugin builds that omit the bot id are exactly the ones that produced
    // the impersonation. Treating "unknown origin" as "fine" would keep the
    // hole open for precisely the deployments that have it.
    const ran = { slugs: [] as string[] };
    const effects = new RealStepEffects({
      getRegistry: () => registryWith(CHAT_BOT_KEY, 'messias', ran),
    });

    await assert.rejects(
      effects.runAgentStep(agentStep('fallback'), { text: 'hi' }, TEAMS_EVENT),
      /does not identify the bot/,
    );
    assert.deepEqual(ran.slugs, []);
  });

  it('refuses when the addressed bot resolves to no active agent', async () => {
    const ran = { slugs: [] as string[] };
    const effects = new RealStepEffects({
      getRegistry: () => registryWith('28:someone-else', 'messias', ran),
    });

    await assert.rejects(
      effects.runAgentStep(
        agentStep('fallback'),
        { botId: CHAT_BOT_KEY },
        TEAMS_EVENT,
      ),
      /resolves to no active Agent/,
    );
    assert.deepEqual(ran.slugs, []);
  });

  it('leaves manual and scheduled runs exactly as they were', async () => {
    // The rule keys on the TRIGGER, not on the step. A run with no addressed
    // bot has no impersonation risk, and a workflow that legitimately uses a
    // specialist agent must keep working — otherwise this guard would break
    // every non-channel workflow in the deployment.
    const ran = { slugs: [] as string[] };
    const effects = new RealStepEffects({
      getRegistry: () => registryWith(CHAT_BOT_KEY, 'messias', ran),
    });

    await effects.runAgentStep(agentStep('fallback'), {}, { runId: 'run-2' });
    assert.deepEqual(ran.slugs, ['fallback']);
  });

  it('does not police a non-channel event trigger', async () => {
    // An operator emit or an inbound webhook carries no addressed bot either.
    // Only event ids from a channel that DOES name its bot are policed.
    const ran = { slugs: [] as string[] };
    const effects = new RealStepEffects({
      getRegistry: () => registryWith(CHAT_BOT_KEY, 'messias', ran),
    });

    await effects.runAgentStep(agentStep('fallback'), {}, {
      runId: 'run-3',
      triggerKind: 'event',
      triggerEventId: 'crm.deal.won',
    });
    assert.deepEqual(ran.slugs, ['fallback']);
  });
});
