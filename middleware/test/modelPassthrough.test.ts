/**
 * Spec 2042 §5.10 — a system module's model loop goes through the kernel:
 * operator jobs (`operatorJobs@1`) bound it, the passthrough
 * (`modelPassthrough@1`) adds the instance's credentials and admits each
 * call inside the job. The module holds no provider key.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { isModelCallNotCovered } from '@omadia/llm-provider';
import { currentExecutionContext, resetModelGatewayForTests, setModelCallHalts, setModelGatewayMode } from '@omadia/usage-telemetry';

import { ModelPassthroughError, createModelPassthrough, systemModuleOnlyService, withoutCredential } from '../src/platform/modelPassthrough.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { createModelWorkRuns } from '../src/platform/modelWorkRuns.js';

afterEach(() => resetModelGatewayForTests());

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  contextKind: string | undefined;
}

function setup(apiKey: string | null = 'sk-instance') {
  const sent: Sent[] = [];
  const runs = createModelWorkRuns({ operatorDailyCalls: 1_000, maintenanceDailyCalls: 1_000 });
  const services = createModelPassthrough({
    runs,
    anthropic: () => ({ apiKey, baseURL: 'https://api.anthropic.com/' }),
    fetchImpl: (async (url: string, init: { headers: Record<string, string>; body: unknown }) => {
      sent.push({ url, headers: init.headers, body: init.body, contextKind: currentExecutionContext()?.kind });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { sent, runs, jobs: services.operatorJobsFor('@omadia/dev-platform'), passthrough: services.passthroughFor('@omadia/dev-platform'), services };
}

const request = (job: Parameters<ReturnType<typeof setup>['passthrough']['forwardAnthropicMessages']>[0]['job']) => ({
  job,
  query: '?beta=true',
  headers: { 'anthropic-version': '2023-06-01', authorization: 'Bearer djr_job', cookie: 'x', 'content-type': 'application/json' },
  body: '{"model":"claude-sonnet-5","messages":[]}',
});

describe('model passthrough for system modules', () => {
  it('forwards inside the operator job with the instance key, dropping client credentials', async () => {
    setModelGatewayMode('enforce');
    const { sent, jobs, passthrough, runs } = setup();
    const job = await jobs.open({ kind: 'dev_job', startedBy: 'op@example.com', budgetCalls: 5, deadlineMs: 60_000, effects: ['pull_request'] });
    const res = await passthrough.forwardAnthropicMessages(request(job));
    assert.equal(res.status, 200);
    assert.equal(sent[0]?.url, 'https://api.anthropic.com/v1/messages?beta=true');
    assert.equal(sent[0]?.headers['x-api-key'], 'sk-instance');
    assert.equal(sent[0]?.headers['authorization'], undefined);
    assert.equal(sent[0]?.headers['cookie'], undefined);
    assert.equal(sent[0]?.contextKind, 'operator_job');
    await job.end();
    const [row] = await runs.list(1);
    assert.equal(row?.jobKind, '@omadia/dev-platform:dev_job');
    assert.equal(row?.modelCalls, 1);
    assert.equal(row?.status, 'succeeded');
  });

  it('counts the budget across calls and refuses beyond it', async () => {
    const { sent, jobs, passthrough } = setup();
    const job = await jobs.open({ kind: 'dev_job', budgetCalls: 2, deadlineMs: 60_000, effects: [] });
    await passthrough.forwardAnthropicMessages(request(job));
    await passthrough.forwardAnthropicMessages(request(job));
    await assert.rejects(passthrough.forwardAnthropicMessages(request(job)), (err: unknown) => isModelCallNotCovered(err));
    assert.equal(sent.length, 2);
  });

  it('refuses after the job ended, under the kill switch and after a cancel', async () => {
    const { sent, jobs, passthrough, runs } = setup();
    const ended = await jobs.open({ kind: 'dev_job', budgetCalls: 5, deadlineMs: 60_000, effects: [] });
    await ended.end();
    await assert.rejects(passthrough.forwardAnthropicMessages(request(ended)), (err: unknown) => isModelCallNotCovered(err));

    const halted = await jobs.open({ kind: 'dev_job', budgetCalls: 5, deadlineMs: 60_000, effects: [] });
    setModelCallHalts({ instance: 'operator stop' });
    await assert.rejects(passthrough.forwardAnthropicMessages(request(halted)), (err: unknown) => isModelCallNotCovered(err));
    setModelCallHalts({});

    const cancelled = await jobs.open({ kind: 'dev_job', budgetCalls: 5, deadlineMs: 60_000, effects: [] });
    assert.equal(runs.cancel(cancelled.id, 'op'), true);
    assert.equal(cancelled.signal.aborted, true);
    await assert.rejects(passthrough.forwardAnthropicMessages(request(cancelled)), (err: unknown) => isModelCallNotCovered(err));
    assert.equal(sent.length, 0);
  });

  it('accepts only jobs this kernel issued to the same plugin', async () => {
    const { jobs, services } = setup();
    const forged = { id: 'x', signal: new AbortController().signal, end: async () => undefined };
    await assert.rejects(
      services.passthroughFor('@omadia/dev-platform').forwardAnthropicMessages(request(forged)),
      (err: unknown) => err instanceof ModelPassthroughError && err.code === 'model_passthrough.unknown_job',
    );
    const job = await jobs.open({ kind: 'dev_job', budgetCalls: 5, deadlineMs: 60_000, effects: [] });
    await assert.rejects(
      services.passthroughFor('@acme/other-module').forwardAnthropicMessages(request(job)),
      (err: unknown) => err instanceof ModelPassthroughError && err.code === 'model_passthrough.unknown_job',
    );
  });

  it('refuses without instance credentials and rejects an invalid job kind', async () => {
    const { jobs, passthrough } = setup(null);
    const job = await jobs.open({ kind: 'dev_job', budgetCalls: 5, deadlineMs: 60_000, effects: [] });
    await assert.rejects(
      passthrough.forwardAnthropicMessages(request(job)),
      (err: unknown) => err instanceof ModelPassthroughError && err.code === 'model_passthrough.no_credentials',
    );
    await assert.rejects(
      jobs.open({ kind: '../Escape', budgetCalls: 5, deadlineMs: 60_000, effects: [] }),
      (err: unknown) => err instanceof ModelPassthroughError && err.code === 'model_passthrough.invalid_job',
    );
  });

  it('passes only a plain query string', async () => {
    const { sent, jobs, passthrough } = setup();
    const job = await jobs.open({ kind: 'dev_job', budgetCalls: 5, deadlineMs: 60_000, effects: [] });
    await passthrough.forwardAnthropicMessages({ ...request(job), query: '/../../admin?x=1' });
    assert.equal(sent[0]?.url, 'https://api.anthropic.com/v1/messages');
  });

  it('is given only to system modules (extension read as one)', () => {
    const { services } = setup();
    const kinds: Record<string, string> = { '@omadia/dev-platform': 'system-module', '@acme/legacy': 'extension', '@acme/tool': 'tool', '@acme/coach': 'archetype' };
    const registry = new ServiceRegistry();
    registry.provide(
      'operatorJobs',
      systemModuleOnlyService('operatorJobs', (id) => kinds[id] as never, services.operatorJobsFor),
    );
    const caller = (id: string) => ({ agentId: id, pluginId: id });
    assert.ok(registry.get('operatorJobs', caller('@omadia/dev-platform')));
    assert.ok(registry.get('operatorJobs', caller('@acme/legacy')));
    for (const id of ['@acme/tool', '@acme/coach', '@acme/unknown']) {
      assert.throws(
        () => registry.get('operatorJobs', caller(id)),
        (err: unknown) => err instanceof ModelPassthroughError && err.code === 'model_passthrough.not_system_module',
        id,
      );
    }
  });

  it('hands back no credential: auth-like headers dropped, the key scrubbed even across chunks', async () => {
    const key = 'sk-ant-instance-secret-0123456789';
    for (let split = 1; split < key.length; split += 1) {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: {"echo":"${key.slice(0, split)}`));
          c.enqueue(enc.encode(`${key.slice(split)}"} and ${key}\n`));
          c.close();
        },
      });
      const upstream = new Response(body, {
        status: 200,
        headers: { 'x-api-key': key, 'set-cookie': 'a=b', 'content-type': 'text/event-stream', 'x-echo': `k=${key}` },
      });
      const out = withoutCredential(upstream, key);
      const text = await out.text();
      assert.equal(text.includes(key), false, `split at ${String(split)}`);
      assert.equal(text, 'data: {"echo":"[REDACTED]"} and [REDACTED]\n');
      assert.equal(out.headers.get('x-api-key'), null);
      assert.equal(out.headers.get('set-cookie'), null);
      assert.equal(out.headers.get('x-echo'), null);
      assert.equal(out.headers.get('content-type'), 'text/event-stream');
    }
  });
});
