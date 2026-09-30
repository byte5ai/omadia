/**
 * A task-store failure inside a long-running tool's `_start` / `_status` /
 * `_list` handler reaches the model as the withheld tool-error notice — class
 * name, sanitised code, log ref — never as the store's exception text. A
 * driver message can echo the task input it failed to write.
 *
 * All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  InMemoryTaskStore,
  defineLongRunningTool,
  longRunningToolNames,
  type LongRunningToolHandle,
} from '@omadia/orchestrator';

const EMAIL = 'erika.mustermann@example.com';

function storeError(): Error {
  return Object.assign(
    new Error(`insert into tasks failed: input {"question":"${EMAIL}"} too large`),
    { code: '54000' },
  );
}

/** Every store call the handlers make rejects with {@link storeError}. */
class FailingTaskStore extends InMemoryTaskStore {
  override create(): ReturnType<InMemoryTaskStore['create']> {
    return Promise.reject(storeError());
  }
  override get(): ReturnType<InMemoryTaskStore['get']> {
    return Promise.reject(storeError());
  }
  override list(): ReturnType<InMemoryTaskStore['list']> {
    return Promise.reject(storeError());
  }
}

function handler(handle: LongRunningToolHandle, suffix: 'start' | 'status' | 'list') {
  const name = longRunningToolNames('slow_thing')[suffix];
  const found = handle.registrations.find((r) => r.name === name);
  assert.ok(found, `missing registration ${name}`);
  return { name, handler: found.handler };
}

let errorLines: string[] = [];
beforeEach(() => {
  errorLines = [];
  mock.method(console, 'error', (...args: unknown[]) => {
    errorLines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  });
});
afterEach(() => {
  mock.restoreAll();
});

describe('tasks/defineLongRunningTool — a failing task store', () => {
  const handle = defineLongRunningTool({
    toolName: 'slow_thing',
    longRunning: true,
    kind: 'slow',
    cardLabel: 'Slow Thing',
    startDescription: 'Start the slow thing.',
    inputProperties: { question: { type: 'string' } },
    requiredInput: ['question'],
    store: new FailingTaskStore(),
    execute: async () => 'never runs',
    onRunnerError: () => undefined,
  });

  for (const [suffix, input] of [
    ['start', { question: EMAIL }],
    ['status', { taskId: 'task-1' }],
    ['list', {}],
  ] as const) {
    it(`_${suffix} withholds the store's text and logs it under the notice's ref`, async () => {
      const { name, handler: run } = handler(handle, suffix);
      const out = await run(input);
      assert.equal(out.includes(EMAIL), false, `the store's text reached the model: ${out}`);
      const pattern = new RegExp(
        `^Error: tool \`${name}\` failed with Error \\(code 54000\\) \\[ref (err_[0-9a-f]{12})\\]`,
      );
      const ref = pattern.exec(out)?.[1];
      assert.ok(ref, `not the withheld notice: ${out}`);
      assert.ok(
        errorLines.some((line) => line.includes(`ref=${ref}`) && line.includes(EMAIL)),
        'the full error is in the server log under the same ref',
      );
    });
  }
});
