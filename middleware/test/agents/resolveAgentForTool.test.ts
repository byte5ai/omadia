import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentResolver } from '../../src/agents/resolveAgentForTool.js';
function stubRuntime(map: Record<string, string>): (toolName: string) => string | undefined {
  return (toolName) => map[toolName];
}

describe('createAgentResolver', () => {
  it('resolves curated kernel tools from the map', () => {
    const resolve = createAgentResolver({
      toolOwner: stubRuntime({}),
    });

    assert.deepEqual(resolve('book_meeting'), {
      id: 'de.byte5.agent.calendar',
      label: 'Calendar',
      tone: 'cyan',
    });
    // Spec 2042 §5.10 — the retired agent plugins' `query_*` tools are gone.
    assert.equal(resolve('query_odoo_hr'), undefined);
  });

  it('resolves a plugin tool to the plugin that registered it', () => {
    const resolve = createAgentResolver({
      toolOwner: stubRuntime({
        query_wanderlust_concierge: 'de.byte5.agent.wanderlust-concierge',
        query_flight_scout: 'de.byte5.agent.flight-scout',
      }),
    });

    const wanderlust = resolve('query_wanderlust_concierge');
    assert.equal(wanderlust?.id, 'de.byte5.agent.wanderlust-concierge');
    assert.equal(wanderlust?.label, 'Wanderlust Concierge');
    assert.ok(['cyan', 'navy', 'magenta', 'warning'].includes(wanderlust?.tone ?? ''));

    const flight = resolve('query_flight_scout');
    assert.equal(flight?.id, 'de.byte5.agent.flight-scout');
    assert.equal(flight?.label, 'Flight Scout');
  });

  it('produces the same tone for the same agent id (deterministic)', () => {
    const resolve = createAgentResolver({
      toolOwner: stubRuntime({
        query_a: 'de.byte5.agent.foo',
        query_b: 'de.byte5.agent.foo',
      }),
    });

    assert.equal(resolve('query_a')?.tone, resolve('query_b')?.tone);
  });

  it('returns undefined for helper / unknown tools', () => {
    const resolve = createAgentResolver({
      toolOwner: stubRuntime({}),
    });

    assert.equal(resolve('memory'), undefined);
    assert.equal(resolve('ask_user_choice'), undefined);
    assert.equal(resolve('render_diagram'), undefined);
    assert.equal(resolve('definitely_not_a_real_tool'), undefined);
  });

  it('built-in mapping wins over a plugin collision', () => {
    const resolve = createAgentResolver({
      toolOwner: stubRuntime({
        book_meeting: 'de.byte5.agent.rogue-calendar-clone',
      }),
    });

    assert.equal(resolve('book_meeting')?.id, 'de.byte5.agent.calendar');
  });
});
