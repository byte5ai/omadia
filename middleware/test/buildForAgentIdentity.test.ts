import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type {
  AgentRow,
  ConfigSnapshot,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import {
  buildForAgent,
  diffSnapshots,
} from '../packages/harness-orchestrator/src/registry/applyDiff.js';

/**
 * #914 — the agent's authored behaviour text reaching the running Agent.
 *
 * Twin of `buildForAgentPersonaSkills.test.ts`, and for the same reason: this
 * value travels through a hand-written field list in the factory, and the one
 * failure mode that matters is silent. An identity the operator saved, the API
 * confirmed and the UI rendered, but that never reached the system prompt,
 * looks exactly like a working feature until someone talks to the bot.
 *
 * Two halves, both required:
 *  - `buildForAgent` puts the text in the Orchestrator's identity slot,
 *    overriding the platform-wide one, and leaves it alone when unauthored;
 *  - `diffSnapshots` calls a changed text a REBUILD, because the registry
 *    keeps serving the old Orchestrator otherwise.
 */

const PLATFORM_IDENTITY = 'You are the platform assistant.';

function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
  } as unknown as NativeToolRegistry;
}

function deps(): OrchestratorDeps {
  return {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    assistantIdentity: PLATFORM_IDENTITY,
  } as unknown as OrchestratorDeps;
}

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'sales',
    name: 'Sales Agent',
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** The Orchestrator's private identity slot — same structural-cast
 *  convention as the persona-skills and routing guards. */
function identityOf(built: ReturnType<typeof buildForAgent>): unknown {
  return (built.orchestrator as unknown as { assistantIdentity?: unknown })
    .assistantIdentity;
}

const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };

test('an authored identity replaces the platform assistant identity', () => {
  const built = buildForAgent(
    agentRow({ instructions: 'You are the sales agent. Be brief.' }),
    deps(),
    RUNTIME,
  );

  assert.equal(identityOf(built), 'You are the sales agent. Be brief.');
});

test('an unauthored agent keeps the platform assistant identity', () => {
  assert.equal(
    identityOf(buildForAgent(agentRow(), deps(), RUNTIME)),
    PLATFORM_IDENTITY,
  );
});

test('a blank authored identity is not an identity', () => {
  // Whitespace must not silence the opening section of the system prompt.
  assert.equal(
    identityOf(buildForAgent(agentRow({ instructions: '   ' }), deps(), RUNTIME)),
    PLATFORM_IDENTITY,
  );
});

function snapshot(agent: AgentRow): ConfigSnapshot {
  return {
    agents: [agent],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  } as unknown as ConfigSnapshot;
}

test('changing the authored identity rebuilds the agent', () => {
  const plan = diffSnapshots(
    snapshot(agentRow({ instructions: 'Old text.' })),
    snapshot(agentRow({ instructions: 'New text.' })),
  );

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0];
  assert.equal(action?.kind, 'rebuild');
  assert.match(
    (action as { reason: string }).reason,
    /identity_instructions/,
    'the rebuild reason names the identity, so an operator can see why sessions rolled',
  );
});

test('an unchanged identity does not rebuild anything', () => {
  const plan = diffSnapshots(
    snapshot(agentRow({ instructions: 'Same text.' })),
    snapshot(agentRow({ instructions: 'Same text.' })),
  );

  assert.deepEqual(plan.actions, []);
});

// ---------------------------------------------------------------------------
// #967 — the agent's own NAME reaching the prompt
// ---------------------------------------------------------------------------

/**
 * The other half of #967. Writing the provisioned name into
 * `agent_identities.display_name` fixes nothing on its own: before this, the
 * column reached the Teams manifest and stopped there, so a bot the operator
 * named `Messias` went on introducing itself with the PLATFORM assistant's
 * name. These cases pin the path from the column to the system prompt, and —
 * just as important — pin that nothing else about the prompt moved.
 */

test('an authored name is layered onto the platform identity, not swapped for it', () => {
  const identity = String(
    identityOf(buildForAgent(agentRow({ identityName: 'Messias' }), deps(), RUNTIME)),
  );

  // Both halves matter. Losing the platform text would silently strip every
  // behaviour a deployment configured, just because somebody typed a name
  // into the provisioning form.
  assert.match(identity, /You are the platform assistant\./);
  assert.match(identity, /Dein Name ist Messias\./);
});

test('an authored name is layered onto an authored identity too', () => {
  const identity = String(
    identityOf(
      buildForAgent(
        agentRow({
          instructions: 'You are the sales agent. Be brief.',
          identityName: 'Messias',
        }),
        deps(),
        RUNTIME,
      ),
    ),
  );

  assert.match(identity, /You are the sales agent\. Be brief\./);
  // Last word wins: the name must outrank any name the prose above mentions,
  // and appending is the only safe way to override a name inside free prose.
  assert.ok(
    identity.indexOf('Dein Name ist Messias') >
      identity.indexOf('You are the sales agent'),
    'the name line must come after the identity text it overrides',
  );
});

test('the name is the ONLY thing added — no invented persona', () => {
  const identity = String(
    identityOf(buildForAgent(agentRow({ identityName: 'Messias' }), deps(), RUNTIME)),
  );
  const added = identity.replace(PLATFORM_IDENTITY, '').trim();

  // One sentence, about the name. Nothing that describes what the agent IS:
  // a self-description belongs to the operator's identity form, and inventing
  // one here would put words in an agent's mouth that nobody authored.
  assert.match(added, /^Dein Name ist Messias\./);
  assert.doesNotMatch(added, /Assistent|assistant|hilfsbereit|helpful/i);
});

test('an agent without an authored name keeps the platform identity byte-for-byte', () => {
  // The no-change guarantee: every agent that predates #967 must compile to
  // the exact same prompt, down to the prompt-cache key.
  assert.equal(
    identityOf(buildForAgent(agentRow(), deps(), RUNTIME)),
    PLATFORM_IDENTITY,
  );
  assert.equal(
    identityOf(buildForAgent(agentRow({ identityName: '   ' }), deps(), RUNTIME)),
    PLATFORM_IDENTITY,
    'whitespace is not a name',
  );
});

test('renaming an agent rebuilds it', () => {
  // Without this the operator renames the bot, sees it saved, and keeps
  // hearing the old name in chat until some unrelated edit rebuilds the
  // Agent — the same silent no-op `identity_instructions` guards against.
  const plan = diffSnapshots(
    snapshot(agentRow({ identityName: 'Willi' })),
    snapshot(agentRow({ identityName: 'Messias' })),
  );

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0];
  assert.equal(action?.kind, 'rebuild');
  assert.match((action as { reason: string }).reason, /identity_display_name/);
});

test('an unchanged name does not rebuild anything', () => {
  const plan = diffSnapshots(
    snapshot(agentRow({ identityName: 'Messias' })),
    snapshot(agentRow({ identityName: 'Messias' })),
  );

  assert.deepEqual(plan.actions, []);
});

// ---------------------------------------------------------------------------
// #967 follow-up — the authored SELF-DESCRIPTION (Steckbrief) reaching the prompt
// ---------------------------------------------------------------------------

/**
 * `short_description` / `long_description` are what an operator writes to say
 * what the agent IS. They reached the Teams app package, the store listing and
 * the operator UI — and no prompt. An operator who filled in "HR-Assistentin
 * für Urlaub und Zeiterfassung" got a catalog entry that said so and a bot that
 * could not answer the question.
 *
 * These cases pin the LAYERING, which is the part that is easy to get wrong: a
 * description must never be able to delete configured behaviour, and the name
 * must still get the last word over it.
 */

test('an authored short description is layered onto the identity', () => {
  const identity = String(
    identityOf(
      buildForAgent(
        agentRow({ identityShortDescription: 'HR-Assistentin für byte5.' }),
        deps(),
        RUNTIME,
      ),
    ),
  );

  assert.match(identity, /You are the platform assistant\./);
  assert.match(identity, /Kurzbeschreibung deiner Rolle: HR-Assistentin für byte5\./);
});

test('an authored long description is layered on too, and both can coexist', () => {
  const identity = String(
    identityOf(
      buildForAgent(
        agentRow({
          identityShortDescription: 'HR-Assistentin.',
          identityLongDescription: 'Beantwortet Fragen zu Urlaub und Zeiterfassung.',
        }),
        deps(),
        RUNTIME,
      ),
    ),
  );

  // Neither is dropped in favour of the other: the Teams manifest caps them at
  // 80 and 4000 characters precisely because they answer different questions.
  assert.match(identity, /Kurzbeschreibung deiner Rolle: HR-Assistentin\./);
  assert.match(
    identity,
    /Ausführliche Beschreibung deiner Rolle: Beantwortet Fragen zu Urlaub und Zeiterfassung\./,
  );
  assert.ok(
    identity.indexOf('Kurzbeschreibung') < identity.indexOf('Ausführliche Beschreibung'),
    'short before long — the summary reads first',
  );
});

test('a description NEVER replaces the authored behaviour text', () => {
  // The failure this guards: folding the Steckbrief into the same slot as
  // `instructions` would let a one-line description silently delete a whole
  // deployment's configured behaviour.
  const identity = String(
    identityOf(
      buildForAgent(
        agentRow({
          instructions: 'You are the sales agent. Be brief.',
          identityShortDescription: 'Vertriebsassistent.',
        }),
        deps(),
        RUNTIME,
      ),
    ),
  );

  assert.match(identity, /You are the sales agent\. Be brief\./);
  assert.match(identity, /Kurzbeschreibung deiner Rolle: Vertriebsassistent\./);
});

test('the name still gets the LAST word, after the descriptions', () => {
  // A long description may well name a predecessor bot. The name the agent
  // actually wears has to outrank it, and appending last is the only safe way
  // to override a name buried in operator prose.
  const identity = String(
    identityOf(
      buildForAgent(
        agentRow({
          identityName: 'Messias',
          identityLongDescription: 'Löst Karen als HR-Assistenz ab.',
        }),
        deps(),
        RUNTIME,
      ),
    ),
  );

  assert.ok(
    identity.indexOf('Dein Name ist Messias') >
      identity.indexOf('Ausführliche Beschreibung deiner Rolle'),
    'the name line must come after the descriptions it overrides',
  );
});

test('blank descriptions add nothing — the prompt stays byte-for-byte', () => {
  // The no-change guarantee: every agent that predates the Steckbrief reaching
  // the prompt must compile to the exact same text, down to the cache key.
  assert.equal(
    identityOf(
      buildForAgent(
        agentRow({ identityShortDescription: '   ', identityLongDescription: null }),
        deps(),
        RUNTIME,
      ),
    ),
    PLATFORM_IDENTITY,
    'whitespace is not a description',
  );
});

test('editing a description rebuilds the agent', () => {
  // Without this the operator edits the Steckbrief, sees it saved, and the bot
  // keeps describing itself the old way until some unrelated change rebuilds
  // it — the same silent no-op `identity_instructions` guards against.
  const plan = diffSnapshots(
    snapshot(agentRow({ identityShortDescription: 'Alt.' })),
    snapshot(agentRow({ identityShortDescription: 'Neu.' })),
  );

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0];
  assert.equal(action?.kind, 'rebuild');
  assert.match((action as { reason: string }).reason, /identity_short_description/);
});

test('editing the long description rebuilds the agent', () => {
  const plan = diffSnapshots(
    snapshot(agentRow({ identityLongDescription: 'Alt.' })),
    snapshot(agentRow({ identityLongDescription: 'Neu.' })),
  );

  assert.equal(plan.actions.length, 1);
  assert.match(
    (plan.actions[0] as { reason: string }).reason,
    /identity_long_description/,
  );
});

test('unchanged descriptions do not rebuild anything', () => {
  const plan = diffSnapshots(
    snapshot(agentRow({ identityShortDescription: 'Gleich.' })),
    snapshot(agentRow({ identityShortDescription: 'Gleich.' })),
  );

  assert.deepEqual(plan.actions, []);
});
