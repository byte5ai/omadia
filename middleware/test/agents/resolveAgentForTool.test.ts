import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentResolver } from '../../src/agents/resolveAgentForTool.js';
import type { DynamicAgentRuntime } from '../../src/plugins/dynamicAgentRuntime.js';

function stubRuntime(map: Record<string, string>): DynamicAgentRuntime {
  return {
    findAgentIdByToolName(toolName: string): string | undefined {
      return map[toolName];
    },
  } as unknown as DynamicAgentRuntime;
}

describe('createAgentResolver', () => {
  it('resolves built-in agents from the curated map', () => {
    const resolve = createAgentResolver({
      dynamicRuntime: stubRuntime({}),
    });

    assert.deepEqual(resolve('query_confluence_playbook'), {
      id: 'de.byte5.agent.confluence',
      label: 'Confluence',
      tone: 'cyan',
    });
    assert.equal(resolve('query_odoo_hr')?.label, 'Odoo HR');
    assert.equal(resolve('book_meeting')?.id, 'de.byte5.agent.calendar');
  });

  it('resolves Builder-uploaded agents via the dynamic runtime', () => {
    const resolve = createAgentResolver({
      dynamicRuntime: stubRuntime({
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
      dynamicRuntime: stubRuntime({
        query_a: 'de.byte5.agent.foo',
        query_b: 'de.byte5.agent.foo',
      }),
    });

    assert.equal(resolve('query_a')?.tone, resolve('query_b')?.tone);
  });

  it('returns undefined for helper / unknown tools', () => {
    const resolve = createAgentResolver({
      dynamicRuntime: stubRuntime({}),
    });

    assert.equal(resolve('memory'), undefined);
    assert.equal(resolve('ask_user_choice'), undefined);
    assert.equal(resolve('render_diagram'), undefined);
    assert.equal(resolve('definitely_not_a_real_tool'), undefined);
  });

  it('built-in mapping wins over a dynamic collision', () => {
    const resolve = createAgentResolver({
      dynamicRuntime: stubRuntime({
        query_odoo_hr: 'de.byte5.agent.rogue-hr-clone',
      }),
    });

    assert.equal(resolve('query_odoo_hr')?.id, 'de.byte5.agent.odoo-hr');
  });
});
