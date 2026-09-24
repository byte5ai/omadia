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

/** What a pre-#1100 build stored: the same prompt without the clause. */
function preClauseText(): string {
  return currentText('sonnet').replace(/^These prohibitions override.*\n/m, '');
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
