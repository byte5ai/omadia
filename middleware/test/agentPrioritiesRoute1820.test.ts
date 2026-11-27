/**
 * #1820 — the KG-priorities admin route accepts the entry kinds recall
 * applies: `turn:<scope>:<time>` and `session:<scope>` (the graph's Session
 * node id). The old `Session::` form matched no node and is refused.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { AgentPrioritiesStore, AgentPriorityUpsert } from '@omadia/plugin-api';

async function post(entryId: string): Promise<{ status: number; upserts: AgentPriorityUpsert[] }> {
  const { default: express } = await import('express');
  const { createAgentPrioritiesRouter } = await import('../src/routes/agentPriorities.js');
  const upserts: AgentPriorityUpsert[] = [];
  const store: AgentPrioritiesStore = {
    async listForAgent() {
      return [];
    },
    async upsert(record) {
      upserts.push(record);
    },
    async remove() {},
  };
  const app = express();
  app.use(express.json());
  app.use('/kg', createAgentPrioritiesRouter({ store }));
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/kg/fallback/${encodeURIComponent(entryId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'block' }),
    });
    return { status: res.status, upserts };
  } finally {
    server.close();
  }
}

describe('POST /admin/kg-priorities/:agentId/:entryId (#1820)', () => {
  it('accepts a turn id and a session id as the graph writes them', async () => {
    for (const entry of ['turn:fallback::web-1:2026-11-03T10:30:21.965Z', 'session:fallback::web-1']) {
      const { status, upserts } = await post(entry);
      assert.equal(status, 200, entry);
      assert.equal(upserts[0]?.entryExternalId, entry);
      assert.equal(upserts[0]?.agentId, 'fallback');
    }
  });

  it('refuses the Session:: form and other kinds', async () => {
    for (const entry of ['Session::fallback::web-1', 'session:', 'mk:123']) {
      const { status, upserts } = await post(entry);
      assert.equal(status, 400, entry);
      assert.equal(upserts.length, 0);
    }
  });
});
