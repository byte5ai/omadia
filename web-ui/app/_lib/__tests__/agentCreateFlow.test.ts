import { describe, expect, it, vi } from 'vitest';

import { NEW_AGENT_AVAILABILITY, reachesAnybody } from '../agentAvailability';
import {
  runAgentCreateFlow,
  slugFromName,
  type AgentCreateDeps,
  type AgentCreatePlan,
} from '../agentCreateFlow';

/**
 * #2049 — the Agent Builder's create flow: draft → identity → availability →
 * the operator's grants → enable. Each step is its own request; a failure is
 * reported by step and the draft stays.
 */

const IDENTITY = {
  display_name: 'Hanna',
  short_description: 'HR colleague',
  long_description: null,
  instructions: 'You are the HR colleague.',
  accent_color: null,
  verbosity: null,
  language: 'de',
  persona: { axes: { warmth: 80 } },
  quality: null,
};

function plan(overrides: Partial<AgentCreatePlan> = {}): AgentCreatePlan {
  return {
    slug: 'hanna',
    agent: {
      name: 'Hanna',
      description: 'HR colleague',
      archetype: 'standard',
    },
    identity: IDENTITY,
    availability: { everyone: false, channels: null, principals: ['role:hr'] },
    pluginIds: ['@acme/odoo'],
    enable: true,
    ...overrides,
  };
}

function deps(
  overrides: Partial<AgentCreateDeps> = {},
): AgentCreateDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    createDraft: vi.fn(async (input: { slug: string }) => ({
      slug: input.slug,
    })),
    saveIdentity: vi.fn(async () => undefined),
    setAvailability: vi.fn(async () => undefined),
    grant: vi.fn(async () => true),
    enable: vi.fn(async () => undefined),
    ...overrides,
  } as AgentCreateDeps & Record<string, ReturnType<typeof vi.fn>>;
}

describe('runAgentCreateFlow', () => {
  it('runs every step in order and grants exactly the chosen plugins', async () => {
    const order: string[] = [];
    const d = deps({
      createDraft: vi.fn(async (input) => {
        order.push(`create:${input.status}`);
        return { slug: input.slug };
      }),
      saveIdentity: vi.fn(async () => order.push('identity')),
      setAvailability: vi.fn(async () => order.push('availability')),
      grant: vi.fn(async (_slug: string, ids: readonly string[]) => {
        order.push(`grant:${ids.join(',')}`);
        return true;
      }),
      enable: vi.fn(async () => order.push('enable')),
    });
    const result = await runAgentCreateFlow(plan(), d);
    expect(result).toEqual({ ok: true, slug: 'hanna', enabled: true });
    expect(order).toEqual([
      'create:draft',
      'identity',
      'availability',
      'grant:@acme/odoo',
      'enable',
    ]);
    expect(d.createDraft).toHaveBeenCalledWith({
      slug: 'hanna',
      name: 'Hanna',
      description: 'HR colleague',
      archetype: 'standard',
      status: 'draft',
    });
    expect(d.saveIdentity).toHaveBeenCalledWith('hanna', IDENTITY);
  });

  it('a blank agent without capabilities skips identity and grants and stays a draft', async () => {
    const d = deps();
    const result = await runAgentCreateFlow(
      plan({ identity: null, pluginIds: [], enable: false }),
      d,
    );
    expect(result).toEqual({ ok: true, slug: 'hanna', enabled: false });
    expect(d.saveIdentity).not.toHaveBeenCalled();
    expect(d.grant).not.toHaveBeenCalled();
    expect(d.enable).not.toHaveBeenCalled();
    expect(d.setAvailability).toHaveBeenCalledTimes(1);
  });

  it('names the failed step and keeps the draft', async () => {
    const d = deps({
      saveIdentity: vi.fn(async () => Promise.reject(new Error('persona refused'))),
    });
    const result = await runAgentCreateFlow(plan(), d);
    expect(result).toEqual({
      ok: false,
      slug: 'hanna',
      failedStep: 'identity',
      error: 'persona refused',
      done: ['create'],
    });
    expect(d.setAvailability).not.toHaveBeenCalled();
    expect(d.enable).not.toHaveBeenCalled();
  });

  it('reports a declined broad-reach confirmation and never enables', async () => {
    const d = deps({ grant: vi.fn(async () => false) });
    const result = await runAgentCreateFlow(plan(), d);
    expect(result).toMatchObject({
      ok: false,
      failedStep: 'grants',
      error: 'declined',
      done: ['create', 'identity', 'availability'],
    });
    expect(d.enable).not.toHaveBeenCalled();
  });

  it('reports a failed create without a draft', async () => {
    const d = deps({
      createDraft: vi.fn(async () => Promise.reject(new Error('slug taken'))),
    });
    const result = await runAgentCreateFlow(plan(), d);
    expect(result).toEqual({
      ok: false,
      slug: null,
      failedStep: 'create',
      error: 'slug taken',
      done: [],
    });
  });
});

describe('slugFromName / availability helpers', () => {
  it('proposes a URL-safe slug', () => {
    expect(slugFromName('SEO-Analyst Müller')).toBe('seo-analyst-muller');
    expect(slugFromName('  --  ')).toBe('');
  });

  it('a new agent reaches nobody', () => {
    expect(reachesAnybody(NEW_AGENT_AVAILABILITY)).toBe(false);
    expect(reachesAnybody({ everyone: true, channels: null, principals: [] })).toBe(true);
    expect(reachesAnybody({ everyone: true, channels: [], principals: [] })).toBe(false);
  });
});
