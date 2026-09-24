/**
 * #1100 — boot-time recompose of stored identity prompts.
 *
 * `agent_identities.composed_prompt` is a write-time cache: the registry
 * speaks with what the last save compiled. A compiler change (the Boundaries
 * precedence clause) must reach agents saved before the release without an
 * operator re-saving each one — and an up-to-date row must not be rewritten,
 * or every boot would churn the table and rebuild every Agent.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import type { ModelPolicy } from '@omadia/plugin-api';

import type {
  AgentIdentityComposedPrompt,
  AgentIdentityRecord,
} from '../src/platform/agentIdentityStore.js';
import {
  composeAgentIdentityPrompt,
  recomposeStaleIdentities,
  type IdentityRecomposeStore,
} from '../src/services/agentIdentityPrompt.js';

const QUALITY = {
  sycophancy: 'high' as const,
  boundaries: { presets: ['no-legal-advice'], custom: [] },
};

function record(
  agentId: string,
  composed: AgentIdentityComposedPrompt,
  quality: AgentIdentityRecord['quality'] = QUALITY,
): AgentIdentityRecord {
  return {
    agentId,
    displayName: null,
    shortDescription: null,
    longDescription: null,
    instructions: 'You are the support agent.',
    accentColor: null,
    persona: null,
    quality,
    composed,
    revision: 3,
    avatar: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function currentText(family: 'sonnet' | 'opus'): string {
  const out = composeAgentIdentityPrompt({
    instructions: 'You are the support agent.',
    persona: null,
    quality: QUALITY,
    family,
  });
  return out.text ?? '';
}

/** High-tier rule 5 as this build compiles it, and as it read before #1100. */
const RULE5_NOW =
  'Flag when a question has regulatory, legal, or financial implications, and state that your response is informational only and cannot replace professional advice — unless a Boundary above forbids the topic, in which case follow that Boundary and redirect instead of answering the substance.';
const RULE5_PRE_1100 =
  'Flag when a question has regulatory, legal, or financial implications. State that your response is informational only and cannot replace professional advice.';

/** What a pre-#1100 build stored: the same prompt without the clause and
 *  with rule 5's old wording, so the carve-out has to come from the pass. */
function preClauseText(): string {
  return currentText('sonnet')
    .replace(/^These prohibitions override.*\n/m, '')
    .replace(RULE5_NOW, RULE5_PRE_1100);
}

interface Harness {
  store: IdentityRecomposeStore;
  writes: { agentId: string; composed: AgentIdentityComposedPrompt }[];
  reloads: number;
  logs: string[];
}

function harness(
  rows: readonly AgentIdentityRecord[],
  opts: { failFor?: string } = {},
): Harness {
  const h: Harness = {
    writes: [],
    reloads: 0,
    logs: [],
    store: {
      listAll: async () => rows,
      recompose: async (agentId, composed) => {
        if (agentId === opts.failFor) throw new Error('db down');
        h.writes.push({ agentId, composed });
        return undefined;
      },
    },
  };
  return h;
}

interface FakeAgent {
  readonly id: string;
  readonly modelRouting?: Record<string, unknown> | null;
  readonly modelPolicy?: ModelPolicy;
}

function run(h: Harness, agents: readonly FakeAgent[]) {
  return recomposeStaleIdentities({
    identityStore: h.store,
    agentStore: { listAgents: async () => agents },
    registry: {
      reload: async () => {
        h.reloads += 1;
      },
    },
    log: (m) => h.logs.push(m),
  });
}

describe('recomposeStaleIdentities (#1100)', () => {
  it('recompiles a row stored before the precedence clause and reloads once', async () => {
    const old = preClauseText();
    assert.ok(!old.includes('override every other instruction'), 'fixture predates the clause');
    assert.ok(
      !old.includes('unless a Boundary above forbids') && old.includes(RULE5_PRE_1100),
      'fixture predates the rule-5 carve-out — update RULE5_NOW if the wording moved',
    );
    const h = harness([
      record('agent-1', { text: old, family: 'sonnet', byFamily: { sonnet: old } }),
    ]);

    const result = await run(h, [{ id: 'agent-1' }]);

    assert.deepEqual(result, { refreshed: 1, failed: 0 });
    assert.equal(h.writes.length, 1);
    const written = h.writes[0]!.composed;
    assert.match(written.text ?? '', /override every other instruction/);
    assert.match(written.text ?? '', /unless a Boundary above forbids/);
    assert.equal(written.family, 'sonnet');
    assert.deepEqual(written.byFamily, { sonnet: written.text });
    assert.equal(h.reloads, 1);
  });

  it('leaves an up-to-date row alone (byFamily key order ignored) and does not reload', async () => {
    const sonnet = currentText('sonnet');
    const opus = currentText('opus');
    // jsonb hands keys back in its own order, not insertion order.
    const h = harness([
      record('agent-1', { text: sonnet, family: 'sonnet', byFamily: { opus, sonnet } }),
    ]);
    const agents: FakeAgent[] = [
      {
        id: 'agent-1',
        modelPolicy: {
          primary: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          fallback: { provider: 'anthropic', model: 'claude-opus-4-7' },
        },
      },
    ];

    const result = await run(h, agents);

    assert.deepEqual(result, { refreshed: 0, failed: 0 });
    assert.equal(h.writes.length, 0);
    assert.equal(h.reloads, 0);
  });

  it('logs a boundary preset that left the library when it rewrites the row', async () => {
    const quality = {
      sycophancy: 'high' as const,
      boundaries: { presets: ['no-legal-advice', 'retired-preset'], custom: [] },
    };
    const h = harness([
      record('agent-1', { text: preClauseText(), family: 'sonnet' }, quality),
    ]);

    const result = await run(h, [{ id: 'agent-1' }]);

    assert.deepEqual(result, { refreshed: 1, failed: 0 });
    assert.ok(
      h.logs.some(
        (l) => l.includes('agent-1') && l.includes('no longer in the library: retired-preset'),
      ),
      `expected a dropped-preset log line, got: ${JSON.stringify(h.logs)}`,
    );
  });

  it('does not touch a row with nothing authored', async () => {
    const h = harness([
      {
        ...record('agent-1', { text: null, family: null }, null),
        instructions: null,
      },
    ]);
    const result = await run(h, [{ id: 'agent-1' }]);
    assert.deepEqual(result, { refreshed: 0, failed: 0 });
    assert.equal(h.writes.length, 0);
  });

  it('skips identities of deleted agents and survives a failing row', async () => {
    const old = preClauseText();
    const h = harness(
      [
        record('gone', { text: old, family: 'sonnet' }),
        record('broken', { text: old, family: 'sonnet' }),
        record('agent-1', { text: old, family: 'sonnet' }),
      ],
      { failFor: 'broken' },
    );

    const result = await run(h, [{ id: 'broken' }, { id: 'agent-1' }]);

    assert.deepEqual(result, { refreshed: 1, failed: 1 });
    assert.deepEqual(
      h.writes.map((w) => w.agentId),
      ['agent-1'],
    );
    assert.equal(h.reloads, 1);
    assert.ok(h.logs.some((l) => l.includes('broken') && l.includes('db down')));
  });

  it('is a logged no-op when the orchestrator agent store is not available', async () => {
    const h = harness([record('agent-1', { text: preClauseText(), family: 'sonnet' })]);
    const result = await recomposeStaleIdentities({
      identityStore: h.store,
      agentStore: undefined,
      registry: undefined,
      log: (m) => h.logs.push(m),
    });
    assert.deepEqual(result, { refreshed: 0, failed: 0 });
    assert.equal(h.writes.length, 0);
    assert.ok(h.logs.some((l) => l.includes('skipped')));
  });

  it('never throws when listing fails', async () => {
    const h = harness([]);
    const result = await recomposeStaleIdentities({
      identityStore: {
        ...h.store,
        listAll: async () => {
          throw new Error('relation does not exist');
        },
      },
      agentStore: { listAgents: async () => [] },
      registry: undefined,
      log: (m) => h.logs.push(m),
    });
    assert.deepEqual(result, { refreshed: 0, failed: 0 });
    assert.ok(h.logs.some((l) => l.includes('relation does not exist')));
  });
});

/**
 * The unit tests above call `recomposeStaleIdentities` directly, so they stay
 * green whatever `index.ts` does with it. Deleted, the stored prompts stay
 * stale; moved above the orchestrator's activation, `configStore` is not
 * provided yet and the pass degrades to a 'skipped' log line. Pin the wiring
 * by reading `index.ts` — importing it boots the whole middleware (same style
 * as coreMigrationsBootWiring.test.ts).
 */
describe('#1100 boot wiring — recomposeStaleIdentities in index.ts', () => {
  const indexSource = (): Promise<string> =>
    readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  it('runs after orchestrator activation and before domain-tool hydration and listen', async () => {
    const src = await indexSource();
    const order: readonly [string, string][] = [
      ['await toolPluginRuntime.activateAllInstalled()', 'orchestrator plugin activation'],
      ['await recomposeStaleIdentities(', 'the boot recompose'],
      ['dynamicAgentRuntime.activateAllInstalled()', 'domain-tool hydration'],
      ['app.listen(', 'the HTTP listener'],
    ];
    const at = order.map(([needle, what]) => {
      const idx = src.indexOf(needle);
      assert.notEqual(idx, -1, `index.ts no longer contains ${what} (\`${needle}\`) — update this pin`);
      return idx;
    });
    for (let i = 1; i < at.length; i += 1) {
      assert.ok(
        at[i - 1]! < at[i]!,
        `${order[i - 1]![1]} must come before ${order[i]![1]} in index.ts (#1100)`,
      );
    }
  });

  it('hands the pass the identity store, the orchestrator config store and its registry', async () => {
    const src = await indexSource();
    const call = /await recomposeStaleIdentities\(\{([\s\S]*?)\}\);/.exec(src);
    assert.ok(call, 'index.ts no longer awaits recomposeStaleIdentities({...}) — update this pin');
    const args = call[1]!;
    assert.match(args, /identityStore:\s*agentIdentityStore\b/);
    assert.match(
      args,
      /agentStore:\s*serviceRegistry\.get<MultiOrchestratorConfigStore>\('configStore'\)/,
    );
    assert.match(
      args,
      /registry:\s*serviceRegistry\.get<MultiOrchestratorRegistry>\('orchestratorRegistry'\)/,
    );
    const storeIdx = src.indexOf('new AgentIdentityStore(graphPool)');
    assert.notEqual(storeIdx, -1, 'index.ts no longer constructs AgentIdentityStore(graphPool)');
    assert.ok(storeIdx < call.index, 'the identity store must exist before the boot recompose');
  });
});
