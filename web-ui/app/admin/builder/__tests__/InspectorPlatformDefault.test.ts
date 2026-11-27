import { describe, expect, it } from 'vitest';

import type { AgentNode } from '../../../_lib/agentBuilder';
import { platformDefaultModelOf } from '../panels/InspectorPanel';

/**
 * #1901 — the "Main model" placeholder said "(platform default: opus)": the
 * Plugin Builder's code-generation model from `/v1/builder/models`. An empty
 * field means the model the registry resolves for the agent (the "Active"
 * line), so that is the one named.
 */
function agent(over: Partial<AgentNode>): AgentNode {
  return {
    id: 'a',
    slug: 'sales',
    name: 'Sales',
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    modelRouting: null,
    effectiveModel: 'claude-sonnet-5-5',
    position: null,
    ...over,
  } as AgentNode;
}

describe('platformDefaultModelOf', () => {
  it('names the resolved model when the agent sets none of its own', () => {
    expect(platformDefaultModelOf(agent({}))).toBe('claude-sonnet-5-5');
    expect(platformDefaultModelOf(agent({ modelPolicy: { primary: 'auto', fallback: 'none' } }))).toBe(
      'claude-sonnet-5-5',
    );
  });

  it('names nothing when the agent has its own main model or policy primary', () => {
    expect(platformDefaultModelOf(agent({ modelRouting: { mode: 'single', main: 'haiku' } }))).toBeNull();
    expect(
      platformDefaultModelOf(
        agent({ modelPolicy: { primary: { provider: 'openai', model: 'gpt-5' }, fallback: 'none' } }),
      ),
    ).toBeNull();
  });

  it('names nothing before the registry built the agent', () => {
    expect(platformDefaultModelOf(agent({ effectiveModel: null }))).toBeNull();
  });
});
