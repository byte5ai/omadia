import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  EditProcessInput,
  EditProcessResult,
  ProcessMemoryService,
  ProcessQueryHit,
  ProcessRecord,
  QueryProcessesInput,
  WriteProcessInput,
  WriteProcessResult,
} from '@omadia/plugin-api';

import {
  EDIT_PROCESS_TOOL_NAME,
  PROCESS_MEMORY_SYSTEM_PROMPT_DOC,
  QUERY_PROCESSES_TOOL_NAME,
  RUN_STORED_PROCESS_TOOL_NAME,
  WRITE_PROCESS_TOOL_NAME,
  createEditProcessHandler,
  createQueryProcessesHandler,
  createRunStoredProcessHandler,
  createWriteProcessHandler,
  editProcessToolSpec,
  queryProcessesToolSpec,
  runStoredProcessToolSpec,
  writeProcessToolSpec,
} from '@omadia/orchestrator/dist/tools/processMemoryTool.js';

// ---------------------------------------------------------------------------
// FakeProcessMemoryService — programmable stub. Each method records its
// inputs and replays a scripted result.
// ---------------------------------------------------------------------------

interface FakeService extends ProcessMemoryService {
  calls: {
    write: WriteProcessInput[];
    edit: EditProcessInput[];
    query: QueryProcessesInput[];
    get: string[];
    history: string[];
  };
}

function makeFake(opts: {
  writeResult?: WriteProcessResult;
  editResult?: EditProcessResult;
  queryResult?: readonly ProcessQueryHit[];
  getResult?: ProcessRecord | null;
}): FakeService {
  const calls = {
    write: [] as WriteProcessInput[],
    edit: [] as EditProcessInput[],
    query: [] as QueryProcessesInput[],
    get: [] as string[],
    history: [] as string[],
  };
  return {
    calls,
    async write(input) {
      calls.write.push(input);
      return (
        opts.writeResult ?? {
          ok: true,
          record: makeRecord('process:s:default', 'Default: Title', 1, ['a']),
        }
      );
    },
    async edit(input) {
      calls.edit.push(input);
      return (
        opts.editResult ?? {
          ok: true,
          record: makeRecord('process:s:default', 'Default: Title', 2, ['a']),
        }
      );
    },
    async query(input) {
      calls.query.push(input);
      return opts.queryResult ?? [];
    },
    async get(id) {
      calls.get.push(id);
      return opts.getResult ?? null;
    },
    async history() {
      return [];
    },
  };
}

function makeRecord(
  id: string,
  title: string,
  version: number,
  steps: readonly string[],
): ProcessRecord {
  return {
    id,
    scope: 's',
    title,
    steps,
    visibility: 'team',
    version,
    createdAt: '2026-05-08T12:00:00.000Z',
    updatedAt: '2026-05-08T12:00:00.000Z',
  };
}

describe('ProcessMemory tool specs', () => {
  it('expose the canonical tool names + required input fields', () => {
    assert.equal(writeProcessToolSpec.name, WRITE_PROCESS_TOOL_NAME);
    assert.equal(writeProcessToolSpec.name, 'write_process');
    assert.deepEqual(writeProcessToolSpec.input_schema['required'], [
      'title',
      'steps',
      'scope',
    ]);

    assert.equal(editProcessToolSpec.name, EDIT_PROCESS_TOOL_NAME);
    assert.deepEqual(editProcessToolSpec.input_schema['required'], ['id']);

    assert.equal(queryProcessesToolSpec.name, QUERY_PROCESSES_TOOL_NAME);
    assert.deepEqual(queryProcessesToolSpec.input_schema['required'], [
      'query',
    ]);

    assert.equal(runStoredProcessToolSpec.name, RUN_STORED_PROCESS_TOOL_NAME);
    assert.deepEqual(runStoredProcessToolSpec.input_schema['required'], ['id']);
  });

  it('system-prompt-doc instructs query-first workflow + naming convention', () => {
    assert.match(PROCESS_MEMORY_SYSTEM_PROMPT_DOC, /query_processes/);
    assert.match(PROCESS_MEMORY_SYSTEM_PROMPT_DOC, /run_stored_process/);
    assert.match(PROCESS_MEMORY_SYSTEM_PROMPT_DOC, /write_process/);
    assert.match(PROCESS_MEMORY_SYSTEM_PROMPT_DOC, /Domain.*What it does/);
  });
});

describe('write_process handler', () => {
  it('rejects non-conforming title before hitting the service', async () => {
    const service = makeFake({});
    const handler = createWriteProcessHandler(service);
    const result = await handler({
      title: 'lowercase: invalid first char',
      steps: ['a'],
      scope: 's',
    });
    assert.match(result, /Error: invalid write_process input/);
    assert.equal(service.calls.write.length, 0);
  });

  it('forwards a valid input and returns process_written JSON', async () => {
    const service = makeFake({
      writeResult: {
        ok: true,
        record: makeRecord(
          'process:s:backend-deploy-to-staging',
          'Backend: Deploy to staging',
          1,
          ['Build', 'Deploy'],
        ),
      },
    });
    const handler = createWriteProcessHandler(service);
    const result = await handler({
      title: 'Backend: Deploy to staging',
      steps: ['Build', 'Deploy'],
      scope: 's',
    });
    const parsed = JSON.parse(result) as { status: string; record: { id: string; version: number } };
    assert.equal(parsed.status, 'process_written');
    assert.equal(parsed.record.id, 'process:s:backend-deploy-to-staging');
    assert.equal(parsed.record.version, 1);
    assert.equal(service.calls.write.length, 1);
  });

  it('translates duplicate-block into a structured tool result with conflictingId', async () => {
    const service = makeFake({
      writeResult: {
        ok: false,
        reason: 'duplicate',
        conflictingId: 'process:s:backend-deploy-to-staging',
        conflictingTitle: 'Backend: Deploy to staging',
        similarity: 0.93,
      },
    });
    const handler = createWriteProcessHandler(service);
    const result = await handler({
      title: 'Backend: Push to staging',
      steps: ['fly deploy'],
      scope: 's',
    });
    const parsed = JSON.parse(result) as {
      status: string;
      conflictingId: string;
      similarity: number;
    };
    assert.equal(parsed.status, 'duplicate_blocked');
    assert.equal(parsed.conflictingId, 'process:s:backend-deploy-to-staging');
    assert.ok(Math.abs(parsed.similarity - 0.93) < 1e-6);
  });
});

describe('query_processes handler', () => {
  it('returns hybrid hits with score + 3-step preview', async () => {
    const service = makeFake({
      queryResult: [
        {
          record: makeRecord('process:s:x', 'Xyz: do thing', 2, [
            'one',
            'two',
            'three',
            'four',
          ]),
          score: 0.812,
        },
      ],
    });
    const handler = createQueryProcessesHandler(service);
    const result = await handler({ query: 'do thing' });
    const parsed = JSON.parse(result) as {
      mode: string;
      hits: Array<{ id: string; score: number; stepsPreview: string[] }>;
    };
    assert.equal(parsed.mode, 'hybrid');
    assert.equal(parsed.hits.length, 1);
    assert.equal(parsed.hits[0]!.id, 'process:s:x');
    assert.ok(Math.abs(parsed.hits[0]!.score - 0.812) < 1e-6);
    assert.deepEqual(parsed.hits[0]!.stepsPreview, ['one', 'two', 'three']);
  });
});

describe('run_stored_process handler', () => {
  it('returns 404-style error string when service.get returns null', async () => {
    const service = makeFake({ getResult: null });
    const handler = createRunStoredProcessHandler(service);
    const result = await handler({ id: 'process:s:missing' });
    assert.match(result, /Error: run_stored_process/);
    assert.match(result, /process:s:missing/);
  });

  it('returns process_loaded JSON with full step list', async () => {
    const service = makeFake({
      getResult: makeRecord('process:s:x', 'Xyz: do thing', 2, ['a', 'b', 'c']),
    });
    const handler = createRunStoredProcessHandler(service);
    const result = await handler({ id: 'process:s:x' });
    const parsed = JSON.parse(result) as {
      status: string;
      title: string;
      steps: string[];
    };
    assert.equal(parsed.status, 'process_loaded');
    assert.equal(parsed.title, 'Xyz: do thing');
    assert.deepEqual(parsed.steps, ['a', 'b', 'c']);
  });
});

describe('edit_process handler', () => {
  it('rejects when no field is provided to change', async () => {
    const service = makeFake({});
    const handler = createEditProcessHandler(service);
    const result = await handler({ id: 'process:s:x' });
    assert.match(result, /Error: invalid edit_process input/);
    assert.equal(service.calls.edit.length, 0);
  });

  it('returns process_updated JSON on success with new version', async () => {
    const service = makeFake({
      editResult: {
        ok: true,
        record: makeRecord('process:s:x', 'Xyz: do better', 5, ['a']),
      },
    });
    const handler = createEditProcessHandler(service);
    const result = await handler({
      id: 'process:s:x',
      title: 'Xyz: do better',
    });
    const parsed = JSON.parse(result) as {
      status: string;
      record: { version: number };
    };
    assert.equal(parsed.status, 'process_updated');
    assert.equal(parsed.record.version, 5);
  });
});
