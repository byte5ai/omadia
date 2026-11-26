import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  InMemoryMemoryStore,
  MemoryAlreadyExistsError,
  MemoryToolHandler,
} from '@omadia/memory';
import type { MemoryStore } from '@omadia/plugin-api';
import { OrchestratorMemoryNamespacer } from '../packages/harness-orchestrator/src/orchestratorMemoryNamespacer.js';
import {
  MemoryScopeViolation,
  ScopedMemoryStore,
} from '../packages/harness-orchestrator/src/registry/scopedMemoryStore.js';

/**
 * #1832 — the memory tool's errors and log lines.
 *   - error texts to the model carry only model-facing `/memories/…` paths
 *   - the per-call log line carries no note content
 *   - a refused path logs one line, no stack trace
 */

const SECRET = 'Das Codewort lautet Fischbrötchen';

function tool(store: MemoryStore = new InMemoryMemoryStore()): {
  store: MemoryStore;
  handler: MemoryToolHandler;
} {
  return { store, handler: new MemoryToolHandler(new OrchestratorMemoryNamespacer('fallback', store)) };
}

describe('#1832 · memory tool error hygiene', () => {
  let logs: string[];
  let errors: unknown[][];
  beforeEach(() => {
    logs = [];
    errors = [];
    mock.method(console, 'log', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  });
  afterEach(() => mock.restoreAll());

  it('an existing file is reported at the model-facing path', async () => {
    const { handler } = tool();
    await handler.handle({ command: 'create', path: '/memories/p11/codewort.md', file_text: 'x' });
    const out = await handler.handle({ command: 'create', path: '/memories/p11/codewort.md', file_text: 'y' });
    assert.equal(out, 'Error: File /memories/p11/codewort.md already exists');
    assert.ok(!out.includes('orchestrators'));
  });

  it('a missing file is reported at the model-facing path', async () => {
    const { handler } = tool();
    const out = await handler.handle({ command: 'str_replace', path: '/memories/nope.md', old_str: 'a', new_str: 'b' });
    assert.ok(out.startsWith('Error:'), out);
    assert.ok(out.includes('/memories/nope.md'), out);
    assert.ok(!out.includes('orchestrators/fallback'), out);
  });

  it('the namespacer rethrows the same error class', async () => {
    const nsr = new OrchestratorMemoryNamespacer('fallback', new InMemoryMemoryStore());
    await nsr.createFile('/memories/a.md', 'x');
    await assert.rejects(() => nsr.createFile('/memories/a.md', 'y'), (err: unknown) => {
      assert.ok(err instanceof MemoryAlreadyExistsError);
      assert.ok(!(err as Error).message.includes('orchestrators'));
      return true;
    });
  });

  it('a scope violation names neither the agent nor the physical path', async () => {
    const scoped = new ScopedMemoryStore({ inner: new InMemoryMemoryStore(), agentSlug: 'fallback', scope: ['ro:core'] });
    const handler = new MemoryToolHandler(new OrchestratorMemoryNamespacer('fallback', scoped));
    const out = await handler.handle({ command: 'create', path: '/memories/x.md', file_text: 'x' });
    assert.equal(out, 'Error: The path /memories/x.md is not available to the memory tool.');
    assert.equal(errors.length, 0, 'an expected refusal logs no stack trace');
    assert.ok(new MemoryScopeViolation('a', 'write', '/x') instanceof Error);
  });

  it('a denied path logs one line and no stack trace', async () => {
    const { handler } = tool();
    const out = await handler.handle({ command: 'view', path: '/memories/chat-sessions' });
    assert.ok(out.startsWith('Error: The path /memories/chat-sessions'), out);
    assert.equal(errors.length, 0);
    assert.equal(logs.filter((l) => l.startsWith('[memory]')).length, 1);
  });

  it('the call log carries no note content', async () => {
    const { handler } = tool();
    await handler.handle({ command: 'create', path: '/memories/test/a.md', file_text: SECRET });
    await handler.handle({ command: 'view', path: '/memories/test/a.md' });
    await handler.handle({
      command: 'str_replace',
      path: '/memories/test/a.md',
      old_str: 'Fischbrötchen',
      new_str: 'Krabbenbrötchen',
    });
    const memoryLines = logs.filter((l) => l.startsWith('[memory]'));
    assert.equal(memoryLines.length, 3);
    assert.ok(memoryLines.every((l) => !l.includes('brötchen') && !l.includes('Codewort')), memoryLines.join('\n'));
    assert.match(memoryLines[1]!, /^\[memory\] view \/memories\/test\/a\.md → ok$/);
  });
});
