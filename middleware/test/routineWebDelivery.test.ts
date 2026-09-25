/**
 * #1071 — a routine created from the browser chat is accepted, and its runs
 * are delivered into the chat it was created in.
 *
 * Before the fix nothing registered a sender under `'web'`, so
 * `RoutineRunner.createRoutine` threw `UnknownChannelError` ("no proactive
 * sender registered for channel 'web'") for every web chat request. This runs
 * a real `RoutineRunner` against the real web sender and a real
 * `ChatSessionStore`; only Postgres, the scheduler and the agent are faked.
 */
import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import type { ChatTurnResult } from '@omadia/channel-sdk';
import type { JobHandler, JobSpec } from '@omadia/plugin-api';
import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore } from '@omadia/orchestrator';

import { InMemoryProactiveSenderRegistry } from '../src/plugins/routines/proactiveSender.js';
import type {
  InsertRoutineRunInput,
  RoutineRunsStore,
} from '../src/plugins/routines/routineRunsStore.js';
import {
  RoutineRunner,
  type JobSchedulerLike,
  type OrchestratorLike,
  type RoutineActorScope,
} from '../src/plugins/routines/routineRunner.js';
import type {
  CreateRoutineInput,
  RecordRunInput,
  Routine,
  RoutineStore,
} from '../src/plugins/routines/routineStore.js';
import {
  createWebChatProactiveSender,
  webChatConversationRef,
} from '../src/plugins/routines/webChatProactiveSender.js';

const TENANT = 'default';
const USER = 'user-web';
const SESSION_ID = 's1';
const OWNER: RoutineActorScope = { kind: 'channel-user', tenant: TENANT, userId: USER };

class NoopScheduler implements JobSchedulerLike {
  register(_agentId: string, _spec: JobSpec, _handler: JobHandler): () => void {
    return () => {};
  }
  stopForPlugin(): void {}
}

/** The slice of `RoutineStore` the create + manual-run paths touch. */
class FakeRoutineStore {
  readonly rows = new Map<string, Routine>();
  readonly runs: RecordRunInput[] = [];

  async create(input: CreateRoutineInput): Promise<Routine> {
    const now = new Date();
    const row: Routine = {
      id: `routine-${String(this.rows.size + 1)}`,
      tenant: input.tenant,
      userId: input.userId,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      channel: input.channel,
      conversationRef: input.conversationRef ?? {},
      status: 'active',
      timeoutMs: input.timeoutMs ?? 600_000,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      outputTemplate: null,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async get(id: string): Promise<Routine | null> {
    return this.rows.get(id) ?? null;
  }
  async getByName(): Promise<Routine | null> {
    return null;
  }
  async countActiveForUser(): Promise<number> {
    return 0;
  }
  async recordRun(input: RecordRunInput): Promise<void> {
    this.runs.push(input);
  }
}

class FakeRunsStore {
  readonly inserts: InsertRoutineRunInput[] = [];
  async insert(input: InsertRoutineRunInput): Promise<null> {
    this.inserts.push(input);
    return null;
  }
}

let nextAnswer = 'report';
const orchestrator: OrchestratorLike = {
  async runTurn(): Promise<ChatTurnResult> {
    return { answer: nextAnswer, toolCalls: 0, iterations: 1 };
  },
};

function createInput(conversationRef: unknown): CreateRoutineInput {
  return {
    tenant: TENANT,
    userId: USER,
    name: 'Daily report',
    cron: '0 8 * * *',
    prompt: 'Fasse den Tag zusammen',
    channel: 'web',
    conversationRef,
  };
}

describe('#1071 — routines created from the web chat', () => {
  let chats: ChatSessionStore;
  let store: FakeRoutineStore;
  let runner: RoutineRunner;

  beforeEach(async () => {
    nextAnswer = 'report';
    chats = new ChatSessionStore(new InMemoryMemoryStore());
    await chats.save({
      id: SESSION_ID,
      title: 'Routinen',
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: 'u1', role: 'user', content: 'jeden Morgen', startedAt: 1 }],
    });
    store = new FakeRoutineStore();
    const senderRegistry = new InMemoryProactiveSenderRegistry();
    senderRegistry.register(createWebChatProactiveSender({ getStore: () => chats, log: () => {} }));
    runner = new RoutineRunner({
      store: store as unknown as RoutineStore,
      runsStore: new FakeRunsStore() as unknown as RoutineRunsStore,
      scheduler: new NoopScheduler(),
      getOrchestrator: () => orchestrator,
      senderRegistry,
      log: () => {},
    });
  });

  it('accepts create for channel web and delivers a manual run into the originating chat', async () => {
    const routine = await runner.createRoutine(
      createInput(webChatConversationRef(SESSION_ID, SESSION_ID)),
    );
    assert.equal(routine.channel, 'web');

    await runner.triggerRoutineNow(routine.id, OWNER);

    assert.deepEqual(store.runs.at(-1), { id: routine.id, status: 'ok', error: null });
    const delivered = (await chats.get(SESSION_ID))?.messages.at(-1);
    assert.ok(delivered);
    assert.equal(delivered.role, 'assistant');
    assert.equal(delivered.content, 'report');
    assert.equal(delivered.proactive?.routineId, routine.id);
    assert.equal(delivered.proactive?.routineName, 'Daily report');
  });

  it('records an error run and does not recreate a chat the user deleted', async () => {
    const routine = await runner.createRoutine(
      createInput(webChatConversationRef(SESSION_ID, SESSION_ID)),
    );
    await chats.delete(SESSION_ID);

    await runner.triggerRoutineNow(routine.id, OWNER);

    const run = store.runs.at(-1);
    assert.equal(run?.status, 'error');
    assert.match(run?.error ?? '', /no longer exists/);
    assert.equal(await chats.get(SESSION_ID), null);
  });

  it('records an empty answer as an error run, not as ok with nothing delivered', async () => {
    const routine = await runner.createRoutine(
      createInput(webChatConversationRef(SESSION_ID, SESSION_ID)),
    );
    nextAnswer = '';

    await runner.triggerRoutineNow(routine.id, OWNER);

    const run = store.runs.at(-1);
    assert.equal(run?.status, 'error');
    assert.match(run?.error ?? '', /empty answer; nothing was delivered/);
    assert.equal((await chats.get(SESSION_ID))?.messages.length, 1);
  });

  it('a quiet run answering NO_REPLY is recorded ok and leaves the chat untouched', async () => {
    const routine = await runner.createRoutine(
      createInput(webChatConversationRef(SESSION_ID, SESSION_ID)),
    );
    nextAnswer = 'NO_REPLY';

    await runner.triggerRoutineNow(routine.id, OWNER);

    assert.deepEqual(store.runs.at(-1), { id: routine.id, status: 'ok', error: null });
    const session = await chats.get(SESSION_ID);
    assert.equal(session?.messages.length, 1);
    assert.equal(session?.updatedAt, 1, 'no write reached the chat');
  });

  it('refuses at create time a web routine with no chat to deliver into', async () => {
    await assert.rejects(
      runner.createRoutine(createInput(webChatConversationRef('http-default'))),
      /outside a saved web chat/,
    );
    assert.equal(store.rows.size, 0);
  });
});
