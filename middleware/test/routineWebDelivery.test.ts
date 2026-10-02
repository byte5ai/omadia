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
  RoutineNotActiveError,
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
  readonly disposed: string[] = [];
  register(_agentId: string, spec: JobSpec, _handler: JobHandler): () => void {
    return () => {
      this.disposed.push(spec.name);
    };
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
  async setStatus(id: string, status: Routine['status']): Promise<Routine | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const updated = { ...row, status };
    this.rows.set(id, updated);
    return updated;
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
let turns = 0;
const orchestrator: OrchestratorLike = {
  async runTurn(): Promise<ChatTurnResult> {
    turns += 1;
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
  let scheduler: NoopScheduler;

  beforeEach(async () => {
    nextAnswer = 'report';
    turns = 0;
    chats = new ChatSessionStore(new InMemoryMemoryStore());
    await chats.save({
      id: SESSION_ID,
      title: 'Routinen',
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: 'u1', role: 'user', content: 'jeden Morgen', startedAt: 1 }],
    });
    store = new FakeRoutineStore();
    scheduler = new NoopScheduler();
    const senderRegistry = new InMemoryProactiveSenderRegistry();
    senderRegistry.register(createWebChatProactiveSender({ getStore: () => chats, warn: () => {} }));
    runner = new RoutineRunner({
      store: store as unknown as RoutineStore,
      runsStore: new FakeRunsStore() as unknown as RoutineRunsStore,
      scheduler,
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

  // An orphaned routine used to run a full agent turn on every cron fire and
  // only then fail at delivery — forever, since the routine stayed active.
  it('fails a routine whose chat was deleted BEFORE the agent turn, pauses it, and does not recreate the chat', async () => {
    const routine = await runner.createRoutine(
      createInput(webChatConversationRef(SESSION_ID, SESSION_ID)),
    );
    await chats.delete(SESSION_ID);

    await runner.triggerRoutineNow(routine.id, OWNER);

    assert.equal(turns, 0, 'no agent turn was spent on a chat nobody can open');
    const run = store.runs.at(-1);
    assert.equal(run?.status, 'error');
    assert.match(run?.error ?? '', /no longer exists; the routine was paused/);
    // Both ways out: the chat may still live in a browser (reopen + resume),
    // or it is gone for good (recreate).
    assert.match(run?.error ?? '', /still exists in your browser, open it and resume the routine; otherwise delete the routine and create it again/);
    assert.equal(store.rows.get(routine.id)?.status, 'paused');
    assert.deepEqual(scheduler.disposed, [routine.id], 'its cron no longer fires');
    assert.equal(await chats.get(SESSION_ID), null);
  });

  // "Now" on the auto-paused routine used to record an `ok` run (the early
  // return sat inside the recording try/finally), which overwrote the
  // last_run_error explaining the pause.
  it('refuses a manual trigger of the auto-paused routine and keeps the pause explanation', async () => {
    const routine = await runner.createRoutine(
      createInput(webChatConversationRef(SESSION_ID, SESSION_ID)),
    );
    await chats.delete(SESSION_ID);
    await runner.triggerRoutineNow(routine.id, OWNER);
    const recorded = store.runs.length;

    await assert.rejects(runner.triggerRoutineNow(routine.id, OWNER), RoutineNotActiveError);

    assert.equal(store.runs.length, recorded, 'no run recorded');
    assert.match(store.runs.at(-1)?.error ?? '', /the routine was paused/);
  });

  it('pauses the routine when the chat vanishes while the turn runs', async () => {
    const routine = await runner.createRoutine(
      createInput(webChatConversationRef(SESSION_ID, SESSION_ID)),
    );
    const deleting: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        await chats.delete(SESSION_ID);
        return { answer: 'report', toolCalls: 0, iterations: 1 };
      },
    };
    const senderRegistry = new InMemoryProactiveSenderRegistry();
    senderRegistry.register(createWebChatProactiveSender({ getStore: () => chats, warn: () => {} }));
    const racing = new RoutineRunner({
      store: store as unknown as RoutineStore,
      runsStore: new FakeRunsStore() as unknown as RoutineRunsStore,
      scheduler: new NoopScheduler(),
      getOrchestrator: () => deleting,
      senderRegistry,
      log: () => {},
    });

    await racing.triggerRoutineNow(routine.id, OWNER);

    assert.match(store.runs.at(-1)?.error ?? '', /no longer exists; the routine was paused/);
    assert.equal(store.rows.get(routine.id)?.status, 'paused');
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
