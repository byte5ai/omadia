import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import { createAgentBuilderRouter } from '../src/routes/agentBuilder.js';
import { CURRENT_VERIFIER_VERSION } from '../src/services/skillVerdict.js';

// `POST /skills/:id/verdict/ack` persists the ack, but `GET /skills/:id` never
// read it back, so "acknowledged by X" vanished on reload.

const SKILL_ID = '00000000-0000-4000-8000-000000000002';
const CONTENT_HASH = 'hash-acked';
const ACKED_AT = new Date('2026-11-01T08:00:00.000Z');

interface AckQuery {
  contentHash: string;
  verifierVersion: string;
}

function makeGraph(opts: {
  contentHash: string | null;
  ack: { ackedBy: string; ackedAt: Date } | undefined;
  ackQueries: AckQuery[];
}): unknown {
  return {
    getSkill: () =>
      Promise.resolve({
        id: SKILL_ID,
        slug: 'acked-skill',
        name: 'Acked Skill',
        description: 'a skill',
        body: 'Summarise the provided notes.',
        frontmatter: { name: 'Acked Skill' },
        source: 'import',
        sourcePath: null,
        contentHash: opts.contentHash,
        forkedFrom: null,
      }),
    getSkillVerdict: () =>
      Promise.resolve({
        contentHash: CONTENT_HASH,
        verifierVersion: CURRENT_VERIFIER_VERSION,
        severity: 'high_risk',
        riskCodes: [],
        computedAt: ACKED_AT,
      }),
    getSkillVerdictAck: (contentHash: string, verifierVersion: string) => {
      opts.ackQueries.push({ contentHash, verifierVersion });
      return Promise.resolve(opts.ack);
    },
    listSubAgentsBySkillId: () => Promise.resolve([]),
    listAgentsByPersonaSkillId: () => Promise.resolve([]),
  };
}

describe('GET /skills/:id — persisted verdict ack', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
    server = undefined;
  });

  async function getSkillVerdict(graph: unknown): Promise<Record<string, unknown>> {
    const app: Express = express();
    app.use(
      '/api/v1/operator',
      createAgentBuilderRouter({
        getConfigStore: () =>
          ({
            listAgents: () => Promise.resolve([]),
            getAgentBySlug: () => Promise.resolve(undefined),
          }) as never,
        getGraphStore: () => graph as never,
        getRegistry: () => undefined,
      }),
    );
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server!.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/v1/operator/skills/${SKILL_ID}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: Record<string, unknown> };
    return body.verdict;
  }

  it('returns who acknowledged the verdict and when, keyed like the POST', async () => {
    const ackQueries: AckQuery[] = [];
    const verdict = await getSkillVerdict(
      makeGraph({
        contentHash: CONTENT_HASH,
        ack: { ackedBy: 'operator@example.test', ackedAt: ACKED_AT },
        ackQueries,
      }),
    );
    assert.equal(verdict['ackedBy'], 'operator@example.test');
    assert.equal(verdict['ackedAt'], ACKED_AT.toISOString());
    assert.equal(verdict['severity'], 'high_risk');
    assert.deepEqual(ackQueries, [
      { contentHash: CONTENT_HASH, verifierVersion: CURRENT_VERIFIER_VERSION },
    ]);
  });

  it('omits the ack fields when the verdict is not acknowledged', async () => {
    const verdict = await getSkillVerdict(
      makeGraph({ contentHash: CONTENT_HASH, ack: undefined, ackQueries: [] }),
    );
    assert.ok(!('ackedBy' in verdict));
    assert.ok(!('ackedAt' in verdict));
  });

  it('does not look up an ack for a skill that was never hashed', async () => {
    const ackQueries: AckQuery[] = [];
    const verdict = await getSkillVerdict(
      makeGraph({ contentHash: null, ack: undefined, ackQueries }),
    );
    assert.deepEqual(ackQueries, []);
    assert.equal(verdict['notYetScanned'], true);
  });
});
