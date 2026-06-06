import { describe, it, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BuilderTriageLog } from '../../src/plugins/builder/builderTriageLog.js';
import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import {
  GithubIssueCache,
  type CacheFetch,
} from '../../src/plugins/builder/githubIssueCache.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import { UserChoiceCoordinator } from '../../src/plugins/builder/userChoiceCoordinator.js';
import { reportPlatformIssueTool } from '../../src/plugins/builder/tools/reportPlatformIssue.js';
import type { BuilderToolContext } from '../../src/plugins/builder/tools/types.js';

function mockResponse(opts: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    json: () => Promise.resolve(opts.body ?? {}),
  };
}

function buildContextStub(opts: {
  draftStore: DraftStore;
  userEmail: string;
  draftId: string;
  triageLog: BuilderTriageLog;
  githubIssueCache: GithubIssueCache;
}): BuilderToolContext {
  return {
    userEmail: opts.userEmail,
    draftId: opts.draftId,
    draftStore: opts.draftStore,
    bus: new SpecEventBus(),
    rebuildScheduler: { schedule: () => undefined },
    catalogToolNames: () => [],
    knownPluginIds: () => [],
    slotTypechecker: {
      async run() {
        return {
          ok: true,
          errors: [],
          reason: 'ok',
          summary: '',
          durationMs: 0,
        };
      },
    },
    slotRetryTracker: { recordFail: () => 0, reset: () => undefined },
    buildFailureBudget: {
      recordFail: () => 0,
      reset: () => undefined,
      limit: 1000,
    },
    templateRoot: '/tmp/nonexistent',
    referenceCatalog: {},
    triageLog: opts.triageLog,
    githubIssueCache: opts.githubIssueCache,
    upstreamIssueConfig: {
      owner: 'byte5ai',
      repo: 'omadia',
      labels: ['from-builder-bot', 'needs-triage'],
    },
  };
}

describe('reportPlatformIssueTool', () => {
  let tmp: string;
  let dbPath: string;
  let store: DraftStore;
  let triageLog: BuilderTriageLog;
  let cache: GithubIssueCache;
  let userEmail: string;
  let draftId: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'report-tool-test-'));
    userEmail = 'tester@example.com';
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (cache) await cache.close();
    if (triageLog) await triageLog.close();
    if (store) await store.close();
  });

  async function freshSetup(fetch: CacheFetch) {
    dbPath = join(tmp, `report-${String(Date.now())}-${String(Math.random())}.db`);
    store = new DraftStore({ dbPath });
    await store.open();
    const draft = await store.create(userEmail, 'Report Tool Test');
    draftId = draft.id;
    triageLog = new BuilderTriageLog({ dbPath });
    await triageLog.open();
    cache = new GithubIssueCache({ dbPath, fetch });
    await cache.open();
  }

  it('returns mode=reused when an existing issue matches the fingerprint', async () => {
    const fetch: CacheFetch = () =>
      Promise.resolve(
        mockResponse({
          status: 200,
          body: {
            items: [
              {
                number: 42,
                state: 'open',
                html_url: 'https://github.com/byte5ai/omadia/issues/42',
              },
            ],
          },
        }),
      );
    await freshSetup(fetch);
    const ctx = buildContextStub({ draftStore: store, userEmail, draftId, triageLog, githubIssueCache: cache });
    const result = await reportPlatformIssueTool.run(
      {
        title: 'Codegen produces invalid TS for nested unions',
        body: 'Detailed repro here.',
        fingerprint: 'deadbeef1234',
        summary: 'Codegen-produced TS does not compile',
        severity: 'bug',
      },
      ctx,
    );
    assert.equal(result.mode, 'reused');
    assert.equal(result.reusedIssue?.number, 42);
  });

  it('returns mode=browser-submit with sanitized body when no existing match', async () => {
    const fetch: CacheFetch = () =>
      Promise.resolve(
        mockResponse({ status: 200, body: { items: [] } }),
      );
    await freshSetup(fetch);
    const ctx = buildContextStub({ draftStore: store, userEmail, draftId, triageLog, githubIssueCache: cache });
    const result = await reportPlatformIssueTool.run(
      {
        title: 'Forbidden-import gate rejects valid local import',
        body: 'Repro contains alice@byte5.de and http://app.staging.internal/x',
        fingerprint: 'feedface1234',
        summary: 'gate false positive',
        severity: 'bug',
      },
      ctx,
    );
    assert.equal(result.mode, 'browser-submit');
    assert.ok(result.browserSubmit);
    assert.match(result.browserSubmit?.githubNewUrl ?? '', /github\.com\/byte5ai\/omadia\/issues\/new\?/);
    assert.match(result.browserSubmit?.fingerprintMarker ?? '', /omadia-fingerprint/);
    assert.match(result.sanitizedBody ?? '', /\[REDACTED:email\]/);
    assert.match(result.sanitizedBody ?? '', /\[REDACTED:internal-url\]/);
  });

  it('input schema accepts a summary longer than the old 280-char cap (regression)', () => {
    // The agent realistically generates a full-sentence summary. The
    // previous max(280) rejected anything longer with a Zod too_big,
    // which crashed the report tool (see omadia_report_core_bug).
    const longSummary = 'Builder-Surface: '.padEnd(300, 'x');
    assert.ok(longSummary.length > 280 && longSummary.length <= 500);
    const input = {
      title: 'Builder surface lacks codegen observability',
      body: 'Repro details.',
      fingerprint: 'observ1234',
      summary: longSummary,
      severity: 'gap' as const,
    };
    // Parses cleanly now; would have thrown a too_big ZodError before.
    const parsed = reportPlatformIssueTool.input.parse(input);
    assert.equal(parsed.summary, longSummary);
    // Still enforces an upper bound — 501 chars is rejected.
    assert.throws(() =>
      reportPlatformIssueTool.input.parse({ ...input, summary: 'x'.repeat(501) }),
    );
  });

  it('returns mode=created-pending (sanitized, no GitHub URL) and emits issue_report_pending', async () => {
    const fetch: CacheFetch = () =>
      Promise.resolve(mockResponse({ status: 200, body: { items: [] } }));
    await freshSetup(fetch);
    const bus = new SpecEventBus();
    const events: Array<{ type: string; mode?: string; sanitizedBody?: string }> = [];
    bus.subscribe(draftId, (ev) => {
      events.push(ev as { type: string; mode?: string; sanitizedBody?: string });
    });
    const ctx: BuilderToolContext = {
      ...buildContextStub({ draftStore: store, userEmail, draftId, triageLog, githubIssueCache: cache }),
      bus,
      directIssueCreateAvailable: true,
    };
    const result = await reportPlatformIssueTool.run(
      {
        title: 'Codegen rejects valid local import',
        body: 'Repro contains alice@byte5.de and http://app.staging.internal/x',
        fingerprint: 'beadfeed1234',
        summary: 'gate false positive',
        severity: 'bug',
      },
      ctx,
    );
    assert.equal(result.mode, 'created-pending');
    assert.ok(result.directSubmit);
    assert.match(result.directSubmit?.fingerprintMarker ?? '', /omadia-fingerprint/);
    // No GitHub tab is opened on the direct path.
    assert.equal(result.browserSubmit, undefined);
    // The operator still confirms a *sanitized* body.
    assert.match(result.sanitizedBody ?? '', /\[REDACTED:email\]/);
    assert.match(result.sanitizedBody ?? '', /\[REDACTED:internal-url\]/);
    // The UI is driven by a cross-tab spec event carrying the sanitized body.
    const pending = events.find((e) => e.type === 'issue_report_pending');
    assert.ok(pending, 'issue_report_pending must be emitted');
    assert.equal(pending?.mode, 'created-pending');
    assert.match(pending?.sanitizedBody ?? '', /\[REDACTED:email\]/);
  });

  it('returns mode=rate_limited after 3 platform submissions in the window', async () => {
    const fetch: CacheFetch = () =>
      Promise.resolve(
        mockResponse({ status: 200, body: { items: [] } }),
      );
    await freshSetup(fetch);
    // Prime three prior platform entries.
    for (let i = 0; i < 3; i += 1) {
      triageLog.record({
        draftId,
        userEmail,
        fingerprint: `prior-${String(i)}`,
        classification: 'platform',
        confidence: 0.9,
        reason: 'gate match',
      });
    }
    const ctx = buildContextStub({ draftStore: store, userEmail, draftId, triageLog, githubIssueCache: cache });
    const result = await reportPlatformIssueTool.run(
      {
        title: 'Another platform bug',
        body: 'body',
        fingerprint: 'fourth-1234',
        summary: 'fourth',
        severity: 'bug',
      },
      ctx,
    );
    assert.equal(result.mode, 'rate_limited');
    assert.equal(result.rateLimit?.cap, 3);
    assert.equal(result.rateLimit?.used, 3);
  });

  it('rate-limit is per operator, not per instance', async () => {
    const fetch: CacheFetch = () =>
      Promise.resolve(
        mockResponse({ status: 200, body: { items: [] } }),
      );
    await freshSetup(fetch);
    for (let i = 0; i < 3; i += 1) {
      triageLog.record({
        draftId,
        userEmail,
        fingerprint: `op-a-${String(i)}`,
        classification: 'platform',
        confidence: 0.9,
        reason: '',
      });
    }
    // Different operator → own quota.
    const ctxB = buildContextStub({
      draftStore: store,
      userEmail: 'other@example.com',
      draftId,
      triageLog,
      githubIssueCache: cache,
    });
    const result = await reportPlatformIssueTool.run(
      {
        title: 'Operator B submission',
        body: 'body',
        fingerprint: 'op-b-1234',
        summary: 'b',
        severity: 'bug',
      },
      ctxB,
    );
    assert.equal(result.mode, 'browser-submit');
  });

  it('returns mode=unavailable when deps are not wired', async () => {
    const fetch: CacheFetch = () =>
      Promise.resolve(mockResponse({ status: 200, body: { items: [] } }));
    await freshSetup(fetch);
    const ctx = buildContextStub({
      draftStore: store,
      userEmail,
      draftId,
      triageLog,
      githubIssueCache: cache,
    });
    const noDeps: BuilderToolContext = {
      ...ctx,
      triageLog: undefined as unknown as BuilderTriageLog,
      githubIssueCache: undefined as unknown as GithubIssueCache,
      upstreamIssueConfig: undefined,
    };
    const result = await reportPlatformIssueTool.run(
      {
        title: 'No deps',
        body: 'body',
        fingerprint: 'aa11bb22',
        summary: 's',
        severity: 'bug',
      },
      noDeps,
    );
    assert.equal(result.mode, 'unavailable');
  });
});

describe('askUserChoiceTool', () => {
  it('returns unavailable when the coordinator is not wired', async () => {
    const { askUserChoiceTool } = await import(
      '../../src/plugins/builder/tools/askUserChoice.js'
    );
    const tmp = mkdtempSync(join(tmpdir(), 'ask-tool-test-'));
    const dbPath = join(tmp, 'd.db');
    const store = new DraftStore({ dbPath });
    await store.open();
    const draft = await store.create('alice@example.com', 'X');
    const bus = new SpecEventBus();
    const ctx: BuilderToolContext = {
      userEmail: 'alice@example.com',
      draftId: draft.id,
      draftStore: store,
      bus,
      rebuildScheduler: { schedule: () => undefined },
      catalogToolNames: () => [],
      knownPluginIds: () => [],
      slotTypechecker: {
        async run() {
          return {
            ok: true,
            errors: [],
            reason: 'ok',
            summary: '',
            durationMs: 0,
          };
        },
      },
      slotRetryTracker: { recordFail: () => 0, reset: () => undefined },
      buildFailureBudget: { recordFail: () => 0, reset: () => undefined, limit: 1000 },
      templateRoot: '/tmp/x',
      referenceCatalog: {},
    };
    const result = await askUserChoiceTool.run(
      {
        question: 'Workaround?',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
      ctx,
    );
    assert.deepEqual(result, { ok: false, reason: 'unavailable' });
    await store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves with the operator-picked value', async () => {
    const { askUserChoiceTool } = await import(
      '../../src/plugins/builder/tools/askUserChoice.js'
    );
    const tmp = mkdtempSync(join(tmpdir(), 'ask-tool-test-'));
    const dbPath = join(tmp, 'd.db');
    const store = new DraftStore({ dbPath });
    await store.open();
    const draft = await store.create('alice@example.com', 'X');
    const bus = new SpecEventBus();
    const coord = new UserChoiceCoordinator({
      bus,
      timeoutMs: 5000,
      generateId: () => 'cid-1',
    });
    const ctx: BuilderToolContext = {
      userEmail: 'alice@example.com',
      draftId: draft.id,
      draftStore: store,
      bus,
      rebuildScheduler: { schedule: () => undefined },
      catalogToolNames: () => [],
      knownPluginIds: () => [],
      slotTypechecker: {
        async run() {
          return {
            ok: true,
            errors: [],
            reason: 'ok',
            summary: '',
            durationMs: 0,
          };
        },
      },
      slotRetryTracker: { recordFail: () => 0, reset: () => undefined },
      buildFailureBudget: { recordFail: () => 0, reset: () => undefined, limit: 1000 },
      templateRoot: '/tmp/x',
      referenceCatalog: {},
      userChoice: coord,
    };
    const pending = askUserChoiceTool.run(
      {
        question: 'Workaround or pause?',
        options: [
          { value: 'workaround', label: 'Workaround' },
          { value: 'pause', label: 'Pause' },
        ],
      },
      ctx,
    );
    // Resolve the choice via the coordinator (simulating route POST).
    coord.resolve({ draftId: draft.id, choiceId: 'cid-1', value: 'pause' });
    const result = await pending;
    assert.deepEqual(result, { ok: true, value: 'pause' });
    await store.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
