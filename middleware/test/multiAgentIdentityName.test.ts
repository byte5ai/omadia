import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryDisclosureSeenStore } from '@omadia/channel-sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';

/**
 * #967 follow-up — the agent's name must be per AGENT, on every surface that
 * states it, when SEVERAL agents are alive in one process.
 *
 * WHY A MULTI-AGENT FILE EXISTS AT ALL. Every existing guard around the
 * authored name (`buildForAgentIdentity.test.ts`) builds exactly ONE agent.
 * A single-agent test cannot fail on a value that is shared between agents —
 * with one agent there is nothing to share it with — so an entire class of
 * defect passes through a suite that looks thorough. Two provisioned Teams
 * bots in one group chat is the deployment that makes the class visible, and
 * it is the deployment the operator actually runs.
 *
 * Two surfaces state a name, and #967 only fixed the first:
 *
 *  1. the SYSTEM PROMPT — `withAgentName`, per agent, already correct;
 *  2. the AI-Act Art. 50 DISCLOSURE LINE — resolved from the platform-wide
 *     `ai_disclosure_assistant_name`, one string for every agent in the
 *     deployment. Whatever the operator typed there, every bot claimed it.
 *
 * A third failure sits underneath both: the first-turn-per-scope fold-dedup
 * is keyed on the raw conversation scope and backed by a PROCESS-WIDE store,
 * so in a shared group chat only the bot that answers first ever discloses.
 * Fixing (2) without that leaves the second bot silent, which looks exactly
 * like the bug it was supposed to fix.
 */

const PLATFORM_IDENTITY = 'Du bist Willi, der Plattform-Assistent.';

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

/**
 * One deps object, reused for every agent in a test — deliberately, because
 * that is what `OrchestratorRegistry` does (`this.deps` is built once at
 * activate() and handed to every `buildForAgent` call). Handing each agent a
 * private deps object would hide precisely the sharing under test.
 */
function sharedDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
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
    ...overrides,
  } as unknown as OrchestratorDeps;
}

function agentRow(slug: string, id: string, identityName: string): AgentRow {
  return {
    id,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    identityName,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as AgentRow;
}

const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };

const MESSIAS = agentRow('messias', '00000000-0000-0000-0000-0000000000b1', 'Messias');
const HR = agentRow('hr', '00000000-0000-0000-0000-0000000000a1', 'Karen');

type Built = ReturnType<typeof buildForAgent>;

/** The Orchestrator's private identity slot — same structural-cast convention
 *  as `buildForAgentIdentity.test.ts`. */
function identityOf(built: Built): string {
  return String(
    (built.orchestrator as unknown as { assistantIdentity?: unknown }).assistantIdentity,
  );
}

/**
 * Fold this turn's disclosure through the real streaming output path.
 * `discloseDoneEvent` is the whole mechanism — resolve the marker, consult the
 * shared seen-store, fold the line — and it reaches none of the provider, so a
 * structural call exercises production behaviour without a wire mock.
 */
function discloseAnswer(built: Built, sessionScope: string): string {
  const orchestrator = built.orchestrator as unknown as {
    discloseDoneEvent: (
      done: { type: 'done'; answer: string },
      input: { sessionScope: string; userMessage: string },
    ) => { answer: string };
  };
  return orchestrator.discloseDoneEvent(
    { type: 'done', answer: 'Guten Morgen!' },
    { sessionScope, userMessage: 'Wie heißt du?' },
  ).answer;
}

// ---------------------------------------------------------------------------
// The system prompt
// ---------------------------------------------------------------------------

test('two agents built in one process each get their OWN name in the system prompt', () => {
  const deps = sharedDeps();
  // Built in registry order (`ORDER BY a.slug` → hr before messias), so a
  // last-build-wins defect would show as "Messias" everywhere rather than as a
  // draw. Asserting BOTH directions is what makes the order irrelevant.
  const hr = buildForAgent(HR, deps, RUNTIME);
  const messias = buildForAgent(MESSIAS, deps, RUNTIME);

  assert.match(identityOf(hr), /Dein Name ist Karen\./);
  assert.doesNotMatch(
    identityOf(hr),
    /Messias/,
    'one agent must never carry another agent’s name',
  );
  assert.match(identityOf(messias), /Dein Name ist Messias\./);
  assert.doesNotMatch(identityOf(messias), /Karen/);
});

test('rebuilding one agent does not rewrite the other agent’s name', () => {
  // A rename is a rebuild (`identity_display_name`), and a rebuild reuses the
  // same shared deps. An agent that is merely a bystander to someone else's
  // rename must come out of it saying exactly what it said before.
  const deps = sharedDeps();
  const messias = buildForAgent(MESSIAS, deps, RUNTIME);
  buildForAgent(agentRow('hr', HR.id, 'Karin'), deps, RUNTIME);

  assert.match(identityOf(messias), /Dein Name ist Messias\./);
  assert.doesNotMatch(identityOf(messias), /Kar(en|in)/);
});

// ---------------------------------------------------------------------------
// The Art. 50 disclosure line
// ---------------------------------------------------------------------------

test('two agents disclose under their OWN name, not the platform-wide one', () => {
  // `ai_disclosure_assistant_name` is ONE operator-typed string for the whole
  // deployment. In a multi-agent deployment it can be right for at most one
  // agent, so every other bot signed its answers with a stranger's name.
  const deps = sharedDeps({
    aiDisclosure: { level: 'standard', assistantName: 'Karen' },
    aiDisclosureSeenStore: new InMemoryDisclosureSeenStore(),
  } as Partial<OrchestratorDeps>);
  const hr = buildForAgent(HR, deps, RUNTIME);
  const messias = buildForAgent(MESSIAS, deps, RUNTIME);

  assert.match(discloseAnswer(hr, 'teams:chat-a'), /von Karen, einem KI-System/);
  assert.match(
    discloseAnswer(messias, 'teams:chat-b'),
    /von Messias, einem KI-System/,
    'the agent’s authored name outranks the platform-wide disclosure name',
  );
});

test('the platform-wide disclosure name still serves an agent that authored none', () => {
  // The per-agent name is an OVERRIDE, not a replacement of the setup field:
  // a deployment that configured one name and never authored per-agent ones
  // must behave exactly as it did before.
  const deps = sharedDeps({
    aiDisclosure: { level: 'standard', assistantName: 'Willi' },
    aiDisclosureSeenStore: new InMemoryDisclosureSeenStore(),
  } as Partial<OrchestratorDeps>);
  const unnamed = buildForAgent(
    { ...HR, identityName: null } as unknown as AgentRow,
    deps,
    RUNTIME,
  );

  assert.match(discloseAnswer(unnamed, 'teams:chat-c'), /von Willi, einem KI-System/);
});

test('two agents in ONE group chat each fold their own disclosure', () => {
  // The failure this pins: the fold-dedup store is process-wide and was keyed
  // on the raw conversation scope, so the first bot to answer in a shared
  // Teams group chat consumed the marking slot for every OTHER bot in it. The
  // second bot then shipped an unmarked answer — an Art. 50 gap, and one that
  // also hid the per-agent name the test above establishes.
  const deps = sharedDeps({
    aiDisclosure: { level: 'standard' },
    aiDisclosureSeenStore: new InMemoryDisclosureSeenStore(),
  } as Partial<OrchestratorDeps>);
  const hr = buildForAgent(HR, deps, RUNTIME);
  const messias = buildForAgent(MESSIAS, deps, RUNTIME);
  const groupChat = 'teams:19:meeting@thread.v2';

  assert.match(discloseAnswer(hr, groupChat), /KI-System/);
  assert.match(
    discloseAnswer(messias, groupChat),
    /KI-System/,
    'a second bot in the same chat must still mark its own first answer',
  );
});

test('the fold-dedup still suppresses the SAME agent’s repeat in a chat', () => {
  // Agent-qualifying the key must not turn the dedup off: the whole point of
  // the store is that one agent marks a conversation once, not every turn.
  const deps = sharedDeps({
    aiDisclosure: { level: 'standard' },
    aiDisclosureSeenStore: new InMemoryDisclosureSeenStore(),
  } as Partial<OrchestratorDeps>);
  const messias = buildForAgent(MESSIAS, deps, RUNTIME);
  const groupChat = 'teams:19:meeting@thread.v2';

  assert.match(discloseAnswer(messias, groupChat), /KI-System/);
  assert.doesNotMatch(
    discloseAnswer(messias, groupChat),
    /KI-System/,
    'the same agent must not re-mark a conversation it already marked',
  );
});
