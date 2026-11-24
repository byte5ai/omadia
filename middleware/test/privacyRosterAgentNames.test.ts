/**
 * Spec 2042 follow-ups #2191 / #2192 — agent names are not personal data.
 *
 *  - #2191: a background job's stored-text scope (significance scorer, canvas
 *    skeleton) masked the agent's name in the agent's own turns; the surrogate
 *    could flow back into the agent's context.
 *  - #2192: in a consultation, A's turn masked colleague B's name and B's turn
 *    masked A's; the model saw a person-shaped surrogate for a colleague.
 *
 * The guard now reads the roster's agent names (`agentNames@1`) per call and
 * exempts them under the #2190 own-name rules: exact equality only, the
 * operator deny-list wins, a name a human bears stays masked (the kernel drops
 * it before publishing, `rosterAgentNames`). Values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { LlmProvider } from '@omadia/llm-provider';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
  PrivacyGuardService,
  PromptPiiDetector,
  PromptPiiSpan,
} from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

import { rosterAgentNames, type OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow, ConfigSnapshot, ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';
import { activate as activatePrivacyGuard } from '../packages/harness-plugin-privacy-guard/src/plugin.js';
import { createAgentNamesProvider } from '../src/platform/agentNamesService.js';

const CLIPPY = 'Dark Clippy';
const KAREN = 'Karen';
const MINERVA = 'Minerva';
const HUMAN = 'Lukas Becker';

/** A C1 stand-in that finds the given names, as the GLiNER sidecar would. */
function namesC1(...names: readonly string[]): PromptPiiDetector {
  return {
    id: 'c1-test',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      const spans: PromptPiiSpan[] = [];
      for (const name of names) {
        for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
          spans.push({ start: at, end: at + name.length, type: 'person', confidence: 0.99 });
        }
      }
      return spans;
    },
  };
}

function guardWith(
  agentNames: (() => readonly string[] | null) | undefined,
  config: Readonly<Record<string, string>> = {},
): PrivacyGuardService {
  const settings: Readonly<Record<string, string>> = { mask_user_prompt: 'on', ...config };
  return createPrivacyGuardService({
    c1Detector: namesC1(CLIPPY, KAREN, MINERVA, HUMAN),
    readConfig: (key: string) => settings[key],
    ...(agentNames ? { agentNames } : {}),
  });
}

async function maskStored(svc: PrivacyGuardService, text: string, job = 'significance-scorer') {
  const scope = svc.openStoredTextScope!({ job });
  const result = await scope.maskStoredText(text);
  assert.equal(result.outcome, 'masked');
  if (result.outcome !== 'masked') throw new Error('unreachable');
  return { ...result, restore: (t: string) => scope.restoreStoredText(t) };
}

describe('#2191 — stored-text jobs leave agent names clear', () => {
  it('a job over an agent\'s turn books no span for the agent\'s name, a human stays masked', async () => {
    const svc = guardWith(() => [CLIPPY, MINERVA]);
    const text = `Ich bin ${CLIPPY}. Frag ${HUMAN}.`;
    for (const job of ['significance-scorer', 'canvas-skeleton']) {
      const result = await maskStored(svc, text, job);
      assert.ok(result.maskedText.startsWith(`Ich bin ${CLIPPY}. Frag `), result.maskedText);
      assert.ok(!result.maskedText.includes(HUMAN), result.maskedText);
      assert.equal(result.spans.length, 1, 'only the human is booked');
      assert.equal(result.restore(result.maskedText), text);
    }
  });

  it('masks the agent name without the roster (the behaviour before the fix)', async () => {
    for (const agentNames of [undefined, () => null, () => { throw new Error('down'); }]) {
      const result = await maskStored(guardWith(agentNames), `Ich bin ${CLIPPY}.`);
      assert.ok(!result.maskedText.includes(CLIPPY), result.maskedText);
      assert.equal(result.spans.length, 1);
    }
  });

  it('the operator deny-list still wins in a stored-text scope', async () => {
    const result = await maskStored(guardWith(() => [CLIPPY], { custom_terms: CLIPPY }), `Ich bin ${CLIPPY}.`);
    assert.ok(!result.maskedText.includes(CLIPPY), result.maskedText);
  });

  it('a roster name only exempts an exact match: a longer name stays masked', async () => {
    const svc = createPrivacyGuardService({
      c1Detector: namesC1('Minerva Schulz'),
      agentNames: () => [MINERVA],
    });
    const result = await maskStored(svc, 'Das sagte Minerva Schulz.');
    assert.ok(!result.maskedText.includes('Minerva Schulz'), result.maskedText);
  });
});

describe('#2192 — a colleague agent\'s name stays clear in a consultation', () => {
  const roster = () => [MINERVA, KAREN];

  it('A\'s turn keeps B\'s name, B\'s turn keeps A\'s name; a human is masked on both sides', async () => {
    const svc = guardWith(roster);
    // A = Minerva asks B = Karen; Karen's contribution comes back into A's turn.
    const inA = await svc.maskReplayedAnswer!({
      sessionId: 's-a',
      turnId: 't-a',
      text: `${KAREN} schreibt: ${HUMAN} hat 12 Tage Resturlaub.`,
      ownNames: [MINERVA],
    });
    assert.equal(inA.outcome, 'masked');
    if (inA.outcome !== 'masked') return;
    assert.ok(inA.maskedText.startsWith(`${KAREN} schreibt: `), inA.maskedText);
    assert.ok(!inA.maskedText.includes(HUMAN), inA.maskedText);

    // B's run reads A's request.
    const inB = await svc.maskUserPrompt!({
      sessionId: 's-b',
      turnId: 't-b',
      text: `${MINERVA} fragt: Wie viel Resturlaub hat ${HUMAN}?`,
      ownNames: [KAREN],
    });
    assert.equal(inB.outcome, 'masked');
    if (inB.outcome !== 'masked') return;
    assert.ok(inB.maskedText.startsWith(`${MINERVA} fragt: `), inB.maskedText);
    assert.ok(!inB.maskedText.includes(HUMAN), inB.maskedText);
  });

  it('a missing, unknown or failing roster exempts only the turn\'s own names', async () => {
    for (const agentNames of [undefined, () => null, () => { throw new Error('down'); }]) {
      const result = await guardWith(agentNames).maskReplayedAnswer!({
        sessionId: 's-f',
        turnId: `t-f-${String(Math.random())}`,
        text: `${KAREN} schreibt an ${MINERVA}.`,
        ownNames: [MINERVA],
      });
      assert.equal(result.outcome, 'masked');
      if (result.outcome !== 'masked') return;
      assert.ok(!result.maskedText.includes(KAREN), result.maskedText);
      assert.ok(result.maskedText.includes(MINERVA), 'the own name still applies');
    }
  });

  it('the operator deny-list still wins over a roster name in a turn', async () => {
    const result = await guardWith(roster, { custom_terms: KAREN }).maskReplayedAnswer!({
      sessionId: 's-d',
      turnId: 't-d',
      text: `${KAREN} schreibt.`,
      ownNames: [MINERVA],
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.ok(!result.maskedText.includes(KAREN), result.maskedText);
  });

  it('a turn reads the roster once: a change mid-turn does not unmask what the turn masked', async () => {
    let names: readonly string[] = [];
    const svc = guardWith(() => names);
    const turn = { sessionId: 's-m', turnId: 't-m' };
    const first = await svc.maskReplayedAnswer!({ ...turn, text: `${KAREN} schreibt.` });
    assert.equal(first.outcome, 'masked');
    if (first.outcome !== 'masked') return;
    assert.ok(!first.maskedText.includes(KAREN));
    names = [KAREN];
    const second = await svc.maskReplayedAnswer!({ ...turn, text: `Nochmal ${KAREN}.` });
    assert.equal(second.outcome, 'masked');
    if (second.outcome !== 'masked') return;
    assert.ok(!second.maskedText.includes(KAREN), second.maskedText);
    await svc.finalizeTurn(turn.turnId);
    const next = await svc.maskReplayedAnswer!({ sessionId: 's-m', turnId: 't-m2', text: `${KAREN} schreibt.` });
    assert.equal(next.outcome, 'masked');
    if (next.outcome !== 'masked') return;
    assert.ok(next.maskedText.includes(KAREN), 'the next turn reads the new roster');
  });

  it('without the roster the colleague is masked (the behaviour before the fix)', async () => {
    const inA = await guardWith(undefined).maskReplayedAnswer!({
      sessionId: 's-a2',
      turnId: 't-a2',
      text: `${KAREN} schreibt: alles erledigt.`,
      ownNames: [MINERVA],
    });
    assert.equal(inA.outcome, 'masked');
    if (inA.outcome !== 'masked') return;
    assert.ok(!inA.maskedText.includes(KAREN), inA.maskedText);
  });
});

describe('rosterAgentNames — what the kernel publishes as agentNames@1', () => {
  it('drops every name a human bears, keeps the rest, deduplicated', () => {
    assert.deepEqual(
      rosterAgentNames({
        names: ['karen', KAREN, MINERVA, 'strategy', ' Minerva ', '', null, undefined],
        humanNames: ['Karen Müller', 'Karen', 'Müller'],
      }),
      [MINERVA, 'strategy'],
    );
  });

  it('compares like the guard: quotes and punctuation do not get a name past the human veto', () => {
    assert.deepEqual(
      rosterAgentNames({ names: ['„Karen“', 'Karen.', MINERVA], humanNames: ['Karen Müller', 'Karen', 'Müller'] }),
      [MINERVA],
    );
  });

  it('is null while the human names are not known: no agent name is exempt', () => {
    assert.equal(rosterAgentNames({ names: [MINERVA], humanNames: null }), null);
  });

  it('a namesake human keeps the agent name masked through the guard', async () => {
    const published = rosterAgentNames({ names: [KAREN, MINERVA], humanNames: ['Karen Müller', 'Karen', 'Müller'] });
    const result = await maskStored(guardWith(() => published), `${KAREN} und ${MINERVA}.`);
    assert.ok(!result.maskedText.includes(KAREN), result.maskedText);
    assert.ok(result.maskedText.includes(MINERVA), result.maskedText);
  });
});

describe('OrchestratorRegistry.agentNames — the roster behind agentNames@1', () => {
  function agent(slug: string, id: string, overrides: Partial<AgentRow> = {}): AgentRow {
    return {
      id,
      slug,
      name: slug,
      description: null,
      privacyProfile: 'default',
      status: 'enabled',
      availableToEveryone: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...overrides,
    };
  }

  it('lists the slugs, names and identity names of every existing agent, enabled or not; not deleted ones', async () => {
    const snap: ConfigSnapshot = {
      agents: [
        agent('strategy', '00000000-0000-0000-0000-0000000000b1', { name: 'Strategie', identityName: MINERVA }),
        agent('hr', '00000000-0000-0000-0000-0000000000b2', { name: KAREN, status: 'disabled' }),
      ],
      tombstones: [
        {
          id: '00000000-0000-0000-0000-0000000000b3',
          slug: 'clippy',
          name: CLIPPY,
          archetype: 'standard',
          deletedAt: '2026-11-23T00:00:00.000Z',
          deletedBy: null,
        },
      ],
      agentPlugins: [],
      channelBindings: [],
    } as unknown as ConfigSnapshot;
    const deps = {
      provider: {} as unknown as LlmProvider,
      knowledgeGraph: {} as KnowledgeGraph,
      memoryStore: {} as MemoryStore,
      entityRefBus: {} as EntityRefBus,
      nativeToolRegistry: { has: () => false, register: () => () => true } as unknown as NativeToolRegistry,
      nudgeRegistry: new InMemoryNudgeRegistry(),
      responseGuard: () => undefined,
      privacyGuard: () => undefined,
    } as OrchestratorDeps;
    const registry = new OrchestratorRegistry(
      { loadSnapshot: () => Promise.resolve(snap) } as unknown as ConfigStore,
      deps,
      { defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 } },
    );
    assert.deepEqual(registry.agentNames(), [], 'nothing before the first snapshot');
    await registry.start();
    const names = registry.agentNames();
    for (const n of ['strategy', 'Strategie', MINERVA, 'hr', KAREN]) {
      assert.ok(names.includes(n), `${n} in ${names.join(', ')}`);
    }
    assert.ok(!names.includes(CLIPPY) && !names.includes('clippy'), 'a deleted agent\'s name is masked again');
    // The absent identity name of `hr` is a blank the published list drops.
    assert.deepEqual(rosterAgentNames({ names, humanNames: [] }), ['strategy', 'Strategie', MINERVA, 'hr', KAREN]);
  });
});

describe('agentNames@1 wiring', () => {
  it('the kernel provider is null without a registry or human names, else the filtered roster', () => {
    let registry: { agentNames(): readonly string[] } | undefined;
    let humans: readonly string[] | null = null;
    const provider = createAgentNamesProvider({ registry: () => registry, humanNames: () => humans });
    assert.equal(provider(), null, 'no registry yet');
    registry = { agentNames: () => [KAREN, MINERVA] };
    assert.equal(provider(), null, 'human names not loaded');
    humans = ['Karen'];
    assert.deepEqual(provider(), [MINERVA]);
  });

  it('the privacy guard declares agentNames@1 and reads it when a scope opens', async () => {
    const manifest = readFileSync(
      new URL('../packages/harness-plugin-privacy-guard/manifest.yaml', import.meta.url),
      'utf8',
    );
    assert.match(manifest, /optional_requires:\n(?:\s+#.*\n)*\s+- "agentNames@1"/);

    const asked: string[] = [];
    const provided = new Map<string, unknown>();
    const handle = await activatePrivacyGuard({
      log: () => undefined,
      config: { get: () => undefined },
      services: {
        provide: (name: string, svc: unknown) => {
          provided.set(name, svc);
          return () => undefined;
        },
        getOptional: (name: string) => {
          asked.push(name);
          return name === 'agentNames' ? () => [CLIPPY] : undefined;
        },
      },
    } as never);
    const svc = provided.get('privacyRedact') as PrivacyGuardService;
    svc.openStoredTextScope!({ job: 'significance-scorer' });
    assert.ok(asked.includes('agentNames'), asked.join(', '));
    await handle.close();
  });
});
