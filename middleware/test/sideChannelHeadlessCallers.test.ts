/**
 * #2085 — side-channel rows reach people, never a later model: a Conductor
 * agent step keeps the prose in the run context (later steps' prompts read
 * it), while its `say` still publishes the table.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Step } from '@omadia/conductor-core';
import type { OrchestratorRegistry } from '@omadia/orchestrator';

import { RealStepEffects } from '../src/conductor/realStepEffects.js';

const PROSE = 'Hier sind die offenen Rechnungen.';
const TABLE = '| number |\n| --- |\n| RE-2026-0412 |';

function registry(): OrchestratorRegistry {
  const entry = {
    agent: { slug: 'erika', id: 'id-erika' },
    bindings: [],
    built: {
      bundle: {
        agent: {
          chat: async () => ({ text: `${PROSE}\n\n${TABLE}`, textWithoutData: PROSE, data: [] }),
        },
      },
    },
  };
  return {
    get: (slug: string) => (slug === 'erika' ? entry : undefined),
    list: () => [entry],
    resolveByChannel: () => entry,
    identityForChannel: () => undefined,
    identityOwnerFor: () => undefined,
    channelIdentityFor: () => undefined,
  } as unknown as OrchestratorRegistry;
}

describe('#2085 side channel — headless callers', () => {
  it('a Conductor agent step stores the prose, not the rows, in the run context', async () => {
    const effects = new RealStepEffects({ getRegistry: () => registry() });
    const step = { id: 'a1', kind: 'agent', agentId: 'erika', prompt: 'Offene Rechnungen?' } as unknown as Step;
    const out = await effects.runAgentStep(step, {}, {
      runId: 'run-1',
      workflowId: 'wf-1',
      triggerKind: 'manual' as const,
    } as never);
    const text = (out.result as { text?: string }).text ?? '';
    assert.equal(text, PROSE);
    assert.equal(text.includes('RE-2026-0412'), false);
  });
});
