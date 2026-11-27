/**
 * #2312 / ADR-0301 — migration 0124 on a real Postgres: a flow records how it
 * is completed, a `teams-sso` flow keeps its authorize URL for the `/go`
 * redirect, and peeking consumes nothing.
 */
import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { AgentGraphStore } from '../packages/harness-orchestrator/src/registry/agentGraphStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { probePgTest } from './_helpers/pgTestDb.js';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'mcpOAuthFlowCompletion',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `mcp_flow_completion_${String(process.pid)}`;
let pool: Pool | undefined;

before(async () => {
  if (!pgUp) return;
  const bootstrap = new Pool({ connectionString: PG_URL });
  await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
  await bootstrap.end();
  pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA},public` });
  await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
});

after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
  await pool.end();
});

const flow = (state: string, serverId: string) => ({
  state,
  serverId,
  userKey: 'oid-1',
  issuer: 'https://as.example',
  codeVerifier: 'v',
  redirectUri: 'https://host/cb',
  scopes: null,
  tokenEndpoint: 'https://as.example/token',
  authorizationEndpoint: 'https://as.example/authorize',
});

describe('ADR-0301 · MCP OAuth flow completion (real PG)', () => {
  it('records the completion mode and the teams-sso authorize URL', async (t) => {
    if (!pool) return t.skip('no test database');
    const store = new AgentGraphStore(pool);
    const server = await store.createMcpServer({ name: 'Notion', transport: 'http', endpoint: 'https://mcp.example' });
    await store.createMcpOAuthFlow(flow('S1', server.id));
    await store.createMcpOAuthFlow({ ...flow('T1', server.id), completion: 'teams-sso', authorizeUrl: 'https://as.example/authorize?state=T1' });
    assert.equal(await store.mcpOAuthFlowCompletion('S1'), 'session');
    assert.equal(await store.mcpOAuthFlowCompletion('T1'), 'teams-sso');
    assert.equal(await store.mcpOAuthFlowCompletion('nope'), undefined);
    assert.equal(await store.mcpOAuthTeamsAuthorizeUrl('S1'), undefined, 'session flows keep no URL');
    assert.equal(await store.mcpOAuthTeamsAuthorizeUrl('T1'), 'https://as.example/authorize?state=T1');
    assert.equal((await store.takeMcpOAuthFlow('T1'))?.completion, 'teams-sso');
    assert.equal((await store.takeMcpOAuthFlow('S1'))?.completion, 'session');
    assert.equal(await store.mcpOAuthTeamsAuthorizeUrl('T1'), undefined, 'taken flows are gone');
  });
});
