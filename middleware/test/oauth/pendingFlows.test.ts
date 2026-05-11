import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PendingFlowStore } from '../../src/plugins/oauth/pendingFlows.js';

const sampleInit = {
  jobId: 'job-1',
  fieldKey: 'ms365',
  providerId: 'microsoft365',
  codeVerifier: 'verifier-xyz',
  scopes: ['Calendars.Read', 'offline_access'],
};

test('create stores a flow and returns it with a server-generated id', () => {
  const store = new PendingFlowStore();
  try {
    const flow = store.create(sampleInit);
    assert.ok(flow.flowId.length > 0);
    assert.equal(flow.jobId, 'job-1');
    assert.deepEqual(flow.scopes, ['Calendars.Read', 'offline_access']);
    assert.equal(store.size(), 1);
  } finally {
    store.clear();
  }
});

test('get returns the flow without consuming it', () => {
  const store = new PendingFlowStore();
  try {
    const flow = store.create(sampleInit);
    assert.equal(store.get(flow.flowId)?.codeVerifier, 'verifier-xyz');
    assert.equal(store.size(), 1);
  } finally {
    store.clear();
  }
});

test('take returns the flow and removes it', () => {
  const store = new PendingFlowStore();
  try {
    const flow = store.create(sampleInit);
    const taken = store.take(flow.flowId);
    assert.equal(taken?.flowId, flow.flowId);
    assert.equal(store.size(), 0);
    assert.equal(store.take(flow.flowId), undefined);
  } finally {
    store.clear();
  }
});

test('TTL drops the flow after the configured window', async () => {
  const store = new PendingFlowStore({ ttlMs: 50 });
  try {
    const flow = store.create(sampleInit);
    assert.equal(store.size(), 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(store.get(flow.flowId), undefined);
    assert.equal(store.size(), 0);
  } finally {
    store.clear();
  }
});

test('two flows have distinct ids', () => {
  const store = new PendingFlowStore();
  try {
    const a = store.create(sampleInit);
    const b = store.create(sampleInit);
    assert.notEqual(a.flowId, b.flowId);
    assert.equal(store.size(), 2);
  } finally {
    store.clear();
  }
});

test('scopes are defensively copied (caller mutation does not leak)', () => {
  const store = new PendingFlowStore();
  try {
    const init = { ...sampleInit, scopes: ['Calendars.Read'] };
    const flow = store.create(init);
    init.scopes.push('Mail.Read');
    assert.deepEqual(flow.scopes, ['Calendars.Read']);
  } finally {
    store.clear();
  }
});

test('clear cancels pending timers + drops entries', () => {
  const store = new PendingFlowStore();
  store.create(sampleInit);
  store.create(sampleInit);
  assert.equal(store.size(), 2);
  store.clear();
  assert.equal(store.size(), 0);
});

test('createdAt uses the injected now() source', () => {
  const fixed = 1_700_000_000_000;
  const store = new PendingFlowStore({ now: () => fixed });
  try {
    const flow = store.create(sampleInit);
    assert.equal(flow.createdAt, fixed);
  } finally {
    store.clear();
  }
});
