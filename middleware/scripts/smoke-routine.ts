/**
 * Smoke test for the routines feature. Exercises the full stack against a
 * real Postgres pool (DATABASE_URL must be set) using a stub chat agent
 * and stub sender — no orchestrator, no model calls. Verifies migration
 * idempotency, tool dispatch, and the full create → list → pause →
 * resume → delete lifecycle.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node --import tsx scripts/smoke-routine.ts
 */

import type { ChatAgent, SemanticAnswer } from '@omadia/channel-sdk';
import { Pool } from 'pg';

import { JobScheduler } from '../src/plugins/jobScheduler.js';
import {
  createProactiveSender,
  initRoutines,
  routineTurnContext,
} from '../src/plugins/routines/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    'smoke-routine: DATABASE_URL is required (Neon connection string).',
  );
  process.exit(2);
}

const TENANT = 'smoke-tenant';
const USER = 'smoke-user';
const ROUTINE_NAME = `smoke-${Date.now()}`;
const VALID_CRON = '0 9 * * 1';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const scheduler = new JobScheduler({ log: (m) => console.log(m) });

  const stubAgent: ChatAgent = {
    async chat(): Promise<SemanticAnswer> {
      return { text: 'stub answer (smoke test)' };
    },
    chatStream(): AsyncGenerator<never> {
      throw new Error('chatStream not used by smoke');
    },
  };

  const sentMessages: SemanticAnswer[] = [];
  const teamsLikeSender = createProactiveSender(
    'teams',
    async (_ref, message) => {
      sentMessages.push(message);
    },
  );

  // The kernel's nativeToolRegistry is not in scope for the smoke; stub a
  // registration sink.
  let toolHandlerRef: ((input: unknown) => Promise<string>) | undefined;
  const handle = await initRoutines({
    pool,
    scheduler,
    chatAgent: stubAgent,
    proactiveSenders: [teamsLikeSender],
    registerNativeTool: (_name, handler) => {
      toolHandlerRef = handler;
      return () => {
        toolHandlerRef = undefined;
      };
    },
    log: (m) => console.log(m),
  });

  console.log('[smoke] migrations applied + runner started.');

  if (!toolHandlerRef) {
    throw new Error('manage_routine handler was not registered');
  }
  const tool = toolHandlerRef;

  const ctx = {
    tenant: TENANT,
    userId: USER,
    channel: 'teams',
    conversationRef: { conversation: { id: 'smoke-conv' } },
  };

  await routineTurnContext.run(ctx, async () => {
    const createResp = await tool({
      action: 'create',
      name: ROUTINE_NAME,
      cron: VALID_CRON,
      prompt: 'Hello world',
    });
    console.log('[smoke] create →', createResp);
    const created = JSON.parse(createResp);
    if (created.action !== 'created') {
      throw new Error(`expected created, got: ${createResp}`);
    }
    const id: string = created.routine.id;

    const listResp = await tool({ action: 'list' });
    console.log('[smoke] list →', listResp);
    const list = JSON.parse(listResp);
    if (list.count < 1 || !list.routines.some((r: { id: string }) => r.id === id)) {
      throw new Error(`list did not contain freshly created routine ${id}`);
    }

    const pauseResp = await tool({ action: 'pause', id });
    console.log('[smoke] pause →', pauseResp);
    const paused = JSON.parse(pauseResp);
    if (paused.routine.status !== 'paused') {
      throw new Error(`pause did not flip status: ${pauseResp}`);
    }

    const resumeResp = await tool({ action: 'resume', id });
    console.log('[smoke] resume →', resumeResp);

    const deleteResp = await tool({ action: 'delete', id });
    console.log('[smoke] delete →', deleteResp);
    const deleted = JSON.parse(deleteResp);
    if (deleted.action !== 'deleted') {
      throw new Error(`delete did not return deleted: ${deleteResp}`);
    }
  });

  // Re-run initRoutines to verify migration idempotency. Should be a no-op.
  const handle2 = await initRoutines({
    pool,
    scheduler,
    chatAgent: stubAgent,
    proactiveSenders: [teamsLikeSender],
    registerNativeTool: () => () => {},
  });
  console.log('[smoke] re-init: migrations idempotent.');
  handle2.close();

  handle.close();
  await pool.end();
  console.log('[smoke] OK — routines lifecycle verified end-to-end.');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
