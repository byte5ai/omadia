import { beforeEach, describe, expect, it, vi } from 'vitest';

import enMessages from '../../../../../messages/en.json';

/**
 * #1398 — `/operator/agents/nope` showed the 404 body under the tab title
 * "Orchestrator: nope · omadia". The title now names the agent only when it
 * exists.
 */

const listOperatorAgents = vi.fn();

vi.mock('../../../../_lib/agents', () => ({
  FALLBACK_AGENT_SLUG: 'fallback',
  listOperatorAgents: () => listOperatorAgents(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => {
    const catalog = (enMessages as unknown as Record<string, Record<string, string>>)[namespace];
    return (key: string, values?: Record<string, string>): string => {
      const raw = catalog?.[key];
      if (typeof raw !== 'string') throw new Error(`missing message ${namespace}.${key}`);
      return raw.replace(/\{(\w+)\}/g, (_m, name: string) => values?.[name] ?? '');
    };
  },
}));

import { generateMetadata } from '../page';

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe('operator agent detail — tab title (#1398)', () => {
  beforeEach(() => {
    listOperatorAgents.mockReset();
  });

  it('names an existing agent', async () => {
    listOperatorAgents.mockResolvedValue({ agents: [{ slug: 'odoo' }] });
    expect((await generateMetadata(params('odoo'))).title).toBe('Orchestrator: odoo · omadia');
  });

  it('uses a generic title for an unknown slug', async () => {
    listOperatorAgents.mockResolvedValue({ agents: [{ slug: 'odoo' }] });
    expect((await generateMetadata(params('nope'))).title).toBe(
      'Orchestrator not found · omadia',
    );
  });

  it('keeps the slug title when the list cannot be loaded', async () => {
    listOperatorAgents.mockRejectedValue(new Error('down'));
    expect((await generateMetadata(params('odoo'))).title).toBe('Orchestrator: odoo · omadia');
  });
});
