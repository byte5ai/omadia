import { describe, it, expect } from 'vitest';

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

    expect(resolve('query_confluence_playbook')).toEqual({
      id: 'de.byte5.agent.confluence',
      label: 'Confluence',
      tone: 'cyan',
    });
    expect(resolve('query_odoo_hr')?.label).toBe('Odoo HR');
    expect(resolve('book_meeting')?.id).toBe('de.byte5.agent.calendar');
  });

  it('resolves Builder-uploaded agents via the dynamic runtime', () => {
    const resolve = createAgentResolver({
      dynamicRuntime: stubRuntime({
        query_wanderlust_concierge: 'de.byte5.agent.wanderlust-concierge',
        query_flight_scout: 'de.byte5.agent.flight-scout',
      }),
    });

    const wanderlust = resolve('query_wanderlust_concierge');
    expect(wanderlust?.id).toBe('de.byte5.agent.wanderlust-concierge');
    expect(wanderlust?.label).toBe('Wanderlust Concierge');
    expect(['cyan', 'navy', 'magenta', 'warning']).toContain(wanderlust?.tone);

    const flight = resolve('query_flight_scout');
    expect(flight?.id).toBe('de.byte5.agent.flight-scout');
    expect(flight?.label).toBe('Flight Scout');
  });

  it('produces the same tone for the same agent id (deterministic)', () => {
    const resolve = createAgentResolver({
      dynamicRuntime: stubRuntime({
        query_a: 'de.byte5.agent.foo',
        query_b: 'de.byte5.agent.foo',
      }),
    });

    expect(resolve('query_a')?.tone).toBe(resolve('query_b')?.tone);
  });

  it('returns undefined for helper / unknown tools', () => {
    const resolve = createAgentResolver({
      dynamicRuntime: stubRuntime({}),
    });

    expect(resolve('memory')).toBeUndefined();
    expect(resolve('ask_user_choice')).toBeUndefined();
    expect(resolve('render_diagram')).toBeUndefined();
    expect(resolve('definitely_not_a_real_tool')).toBeUndefined();
  });

  it('built-in mapping wins over a dynamic collision', () => {
    const resolve = createAgentResolver({
      dynamicRuntime: stubRuntime({
        query_odoo_hr: 'de.byte5.agent.rogue-hr-clone',
      }),
    });

    expect(resolve('query_odoo_hr')?.id).toBe('de.byte5.agent.odoo-hr');
  });
});
