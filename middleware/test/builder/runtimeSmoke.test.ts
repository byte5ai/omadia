import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import { z } from 'zod';

import type {
  PreviewActivateOptions,
  PreviewHandle,
  PreviewRouteCapture,
  PreviewRuntime,
  PreviewToolDescriptor,
} from '../../src/plugins/builder/previewRuntime.js';
import {
  invokeToolsOnHandle,
  runRuntimeSmoke,
} from '../../src/plugins/builder/runtimeSmoke.js';

function makeTool(
  id: string,
  run: (input: unknown) => Promise<unknown>,
): PreviewToolDescriptor {
  return {
    id,
    description: `tool-${id}`,
    input: z.unknown(),
    run,
  };
}

function makeHandle(
  tools: ReadonlyArray<PreviewToolDescriptor>,
  closeSpy?: { closed: boolean },
  routeCaptures: ReadonlyArray<PreviewRouteCapture> = [],
): PreviewHandle {
  return {
    draftId: 'd-1',
    agentId: 'de.byte5.agent.test',
    rev: 1,
    toolkit: { tools },
    previewDir: '/tmp/preview-stub',
    routeCaptures,
    close: async () => {
      if (closeSpy) closeSpy.closed = true;
    },
  };
}

function makeRouteCapture(
  prefix: string,
  build: (router: ReturnType<typeof express.Router>) => void,
): PreviewRouteCapture {
  const router = express.Router();
  build(router);
  return { prefix, router, disposed: false };
}

const dummyRuntime: PreviewRuntime = {} as PreviewRuntime;

const validSpec = {
  template: 'agent-integration',
  id: 'de.byte5.agent.test',
  name: 'Test',
  version: '0.1.0',
  description: 'fixture',
  category: 'analysis',
  depends_on: [],
  tools: [
    {
      id: 'get_thing',
      description: 'a',
      input: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
    },
  ],
  skill: { role: 'tester' },
  setup_fields: [],
  playbook: { when_to_use: 'tests', not_for: [], example_prompts: [] },
  network: { outbound: [] },
  slots: {},
};

describe('runRuntimeSmoke — happy path', () => {
  it('returns ok=true with per-tool results when all tools succeed', async () => {
    const calls: unknown[] = [];
    const handle = makeHandle([
      makeTool('get_thing', async (input) => {
        calls.push(input);
        return { result: 'ok' };
      }),
    ]);

    const result = await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: validSpec as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      activate: async () => handle,
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.toolId, 'get_thing');
    assert.equal(result.results[0]?.status, 'ok');
    // Synthetic input was generated from the JSON-schema in spec.tools[0].input
    assert.deepEqual(calls[0], { x: 'test' });
  });

  it('returns ok=true reason=no_tools when toolkit is empty', async () => {
    const handle = makeHandle([]);
    const result = await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: validSpec as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      activate: async () => handle,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'no_tools');
    assert.equal(result.results.length, 0);
  });

  it('always closes the handle (success path)', async () => {
    const closeSpy = { closed: false };
    const handle = makeHandle(
      [makeTool('get_thing', async () => 'ok')],
      closeSpy,
    );
    await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: validSpec as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      activate: async () => handle,
    });
    assert.equal(closeSpy.closed, true);
  });
});

describe('runRuntimeSmoke — failure modes', () => {
  it('returns ok=false reason=activate_failed when activate throws', async () => {
    const result = await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: validSpec as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      activate: async () => {
        throw new Error('boot failed: missing entry');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'activate_failed');
    assert.match(result.activateError ?? '', /boot failed/);
  });

  it('marks a thrown tool as status=threw with errorMessage', async () => {
    const handle = makeHandle([
      makeTool('bad_tool', async () => {
        throw new Error('upstream API exploded');
      }),
    ]);
    const result = await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: validSpec as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      activate: async () => handle,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'tool_failures');
    assert.equal(result.results[0]?.status, 'threw');
    assert.match(result.results[0]?.errorMessage ?? '', /upstream API/);
  });

  it('marks a Zod-validation throw as status=validation_failed (controlled exit)', async () => {
    const handle = makeHandle([
      makeTool('zod_picky', async () => {
        const err = new Error('expected number, got string');
        err.name = 'ZodError';
        throw err;
      }),
    ]);
    const result = await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: validSpec as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      activate: async () => handle,
    });
    // ZodError still counts as pass — controlled exit, not a smoke fail.
    assert.equal(result.ok, true);
    assert.equal(result.results[0]?.status, 'validation_failed');
  });

  it('marks a hanging tool as status=timeout', async () => {
    const handle = makeHandle([
      makeTool('hangs', () => new Promise(() => undefined)), // never resolves
    ]);
    const result = await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: validSpec as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      toolTimeoutMs: 50,
      activate: async () => handle,
    });
    assert.equal(result.ok, false);
    assert.equal(result.results[0]?.status, 'timeout');
    assert.match(result.results[0]?.errorMessage ?? '', /50ms/);
  });

  it('mixed status (one ok + one timeout) → ok=false reason=tool_failures', async () => {
    const handle = makeHandle([
      makeTool('fast', async () => 'done'),
      makeTool('slow', () => new Promise(() => undefined)),
    ]);
    const specTwoTools = {
      ...validSpec,
      tools: [
        { id: 'fast', description: 'a', input: {} },
        { id: 'slow', description: 'b', input: {} },
      ],
    };
    const result = await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: specTwoTools as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      toolTimeoutMs: 30,
      activate: async () => handle,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'tool_failures');
    const statuses = result.results.map((r) => r.status);
    assert.deepEqual(statuses, ['ok', 'timeout']);
  });

  it('closes the handle even when invocation paths throw synchronously', async () => {
    const closeSpy = { closed: false };
    const handle = makeHandle(
      [
        makeTool('boom', () => {
          throw new Error('sync throw');
        }),
      ],
      closeSpy,
    );
    await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: validSpec as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      activate: async () => handle,
    });
    assert.equal(closeSpy.closed, true);
  });
});

describe('runRuntimeSmoke — setup_fields stubbing', () => {
  it('passes stub strings for secret + oauth keys via secretValues, others via configValues', async () => {
    let captured: PreviewActivateOptions | null = null;
    const handle = makeHandle([makeTool('noop', async () => 'ok')]);
    await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: {
        ...validSpec,
        setup_fields: [
          { key: 'api_key', type: 'secret' },
          { key: 'oauth_token', type: 'oauth' },
          { key: 'region', type: 'string' },
        ],
      } as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      activate: async (opts) => {
        captured = opts;
        return handle;
      },
    });
    assert.ok(captured);
    const opts = captured as PreviewActivateOptions;
    assert.equal(opts.secretValues['api_key'], 'smoke-test');
    assert.equal(opts.secretValues['oauth_token'], 'smoke-test');
    assert.equal(opts.configValues['region'], 'smoke-test');
  });

  it('passes smokeMode=true through PreviewActivateOptions', async () => {
    let captured: PreviewActivateOptions | null = null;
    const handle = makeHandle([makeTool('noop', async () => 'ok')]);
    await runRuntimeSmoke({
      zipBuffer: Buffer.from('x'),
      spec: validSpec as never,
      draftId: 'd-1',
      rev: 1,
      previewRuntime: dummyRuntime,
      activate: async (opts) => {
        captured = opts;
        return handle;
      },
    });
    const opts = captured as PreviewActivateOptions | null;
    assert.ok(opts);
    assert.equal(opts.smokeMode, true);
  });
});

describe('invokeToolsOnHandle — admin-routes smoke', () => {
  it('passes when admin GET returns {ok: true, items: [...]}', async () => {
    const route = makeRouteCapture('/api/test/admin', (r) => {
      r.get('/api/devices', (_req, res) => {
        res.json({ ok: true, items: [{ id: 1 }] });
      });
    });
    const handle = makeHandle(
      [makeTool('noop', async () => 'ok')],
      undefined,
      [route],
    );
    const result = await invokeToolsOnHandle({
      handle,
      spec: validSpec as never,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.adminRouteResults?.length, 1);
    assert.equal(result.adminRouteResults?.[0]?.status, 'ok');
    assert.equal(
      result.adminRouteResults?.[0]?.endpoint,
      '/api/test/admin/api/devices',
    );
  });

  it('fails when admin GET returns body without `ok` field (silent-wrong scenario)', async () => {
    const route = makeRouteCapture('/api/test/admin', (r) => {
      r.get('/api/devices', (_req, res) => {
        // The exact shape that broke UniFi-Tracker v0.4.0 in production.
        res.json({ devices: [{ id: 1 }] });
      });
    });
    const handle = makeHandle(
      [makeTool('noop', async () => 'ok')],
      undefined,
      [route],
    );
    const result = await invokeToolsOnHandle({
      handle,
      spec: validSpec as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'admin_route_schema_violation');
    assert.equal(result.adminRouteResults?.[0]?.status, 'schema_violation');
    assert.match(
      result.adminRouteResults?.[0]?.reason ?? '',
      /missing required 'ok: boolean'/,
    );
  });

  it('fails on 5xx response', async () => {
    const route = makeRouteCapture('/api/test/admin', (r) => {
      r.get('/api/boom', (_req, res) => {
        res.status(500).json({ ok: false, error: 'kaboom' });
      });
    });
    const handle = makeHandle(
      [makeTool('noop', async () => 'ok')],
      undefined,
      [route],
    );
    const result = await invokeToolsOnHandle({
      handle,
      spec: validSpec as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.adminRouteResults?.[0]?.status, 'http_error');
    assert.equal(result.adminRouteResults?.[0]?.httpStatus, 500);
  });

  it('marks an unresponsive route as timeout', async () => {
    const route = makeRouteCapture('/api/test/admin', (r) => {
      r.get('/api/slow', (_req, _res) => {
        // never responds
      });
    });
    const handle = makeHandle(
      [makeTool('noop', async () => 'ok')],
      undefined,
      [route],
    );
    const result = await invokeToolsOnHandle({
      handle,
      spec: validSpec as never,
      adminRouteTimeoutMs: 80,
    });
    assert.equal(result.ok, false);
    assert.equal(result.adminRouteResults?.[0]?.status, 'timeout');
  });

  it('warns (does not fail) on empty array for declared external_read', async () => {
    const route = makeRouteCapture('/api/test/admin', (r) => {
      r.get('/api/employees', (_req, res) => {
        res.json({ ok: true, employees: [] });
      });
    });
    const specWithRead = {
      ...validSpec,
      external_reads: [
        {
          id: 'list_employees',
          description: 'Mitarbeiterliste',
          service: 'odoo.client',
          method: 'execute',
          args: [],
          kwargs: {},
        },
      ],
    };
    const handle = makeHandle(
      [makeTool('noop', async () => 'ok')],
      undefined,
      [route],
    );
    const result = await invokeToolsOnHandle({
      handle,
      spec: specWithRead as never,
    });
    // Empty array = warning, not failure → overall smoke stays ok.
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.adminRouteResults?.[0]?.status, 'empty_warning');
  });

  it('plugin sees ctx.smokeMode === true during smoke calls (probe sets x-smoke-mode header)', async () => {
    let observedHeader: string | undefined;
    const route = makeRouteCapture('/api/test/admin', (r) => {
      r.get('/api/devices', (req, res) => {
        observedHeader = req.headers['x-smoke-mode'] as string | undefined;
        res.json({ ok: true, items: [] });
      });
    });
    const handle = makeHandle(
      [makeTool('noop', async () => 'ok')],
      undefined,
      [route],
    );
    await invokeToolsOnHandle({ handle, spec: validSpec as never });
    assert.equal(observedHeader, '1');
  });

  it('returns no adminRouteResults when no routes were registered', async () => {
    const handle = makeHandle([makeTool('noop', async () => 'ok')]);
    const result = await invokeToolsOnHandle({
      handle,
      spec: validSpec as never,
    });
    assert.equal(result.adminRouteResults, undefined);
    assert.equal(result.ok, true);
  });
});
