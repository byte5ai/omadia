import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';

import { BuilderAgent } from '../../src/plugins/builder/builderAgent.js';
import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';
import type { BuilderEvent } from '../../src/plugins/builder/builderAgent.js';

async function collect(stream: AsyncIterable<BuilderEvent>): Promise<BuilderEvent[]> {
  const events: BuilderEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

describe('BuilderAgent — pause-on-issue guard', () => {
  let tmp: string;
  let store: DraftStore;
  let bus: SpecEventBus;
  let userEmail: string;
  let draftId: string;
  let busEvents: SpecBusEvent[];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pause-on-issue-'));
    const dbPath = join(tmp, 'drafts.db');
    store = new DraftStore({ dbPath });
    await store.open();
    userEmail = 'tester@example.com';
    const d = await store.create(userEmail, 'Paused Draft');
    draftId = d.id;
    bus = new SpecEventBus();
    busEvents = [];
    bus.subscribe(draftId, (e) => busEvents.push(e));
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits paused_on_issue + error and skips the LLM when draft is paused', async () => {
    const pauseRef = {
      owner: 'byte5ai',
      repo: 'omadia',
      number: 77,
      url: 'https://github.com/byte5ai/omadia/issues/77',
    };
    const draft = await store.load(userEmail, draftId);
    if (!draft) throw new Error('seed missing');
    await store.update(userEmail, draftId, {
      spec: {
        ...draft.spec,
        builder_settings: {
          auto_fix_enabled: false,
          paused_on_issue: {
            issueRef: pauseRef,
            fingerprint: 'aabbccdd',
            pausedAt: Date.now(),
          },
        },
      },
    });

    let subAgentBuilt = 0;
    const agent = new BuilderAgent({
      anthropic: () => ({}) as Anthropic,
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
      referenceCatalog: {},
      systemPromptSeed: async () => 'TEST-SEED',
      buildSubAgent: () => {
        subAgentBuilt += 1;
        return {
          async ask() {
            return 'should not be called';
          },
        };
      },
      tools: [],
      templateRoot: tmp,
    });

    const events = await collect(
      agent.runTurn({
        draftId,
        userEmail,
        userMessage: 'try to advance',
        modelChoice: 'claude-sonnet-4-6',
      }),
    );

    assert.equal(
      subAgentBuilt,
      0,
      'buildSubAgent must not be invoked for a paused draft',
    );
    const errorEvent = events.find((e) => e.type === 'error');
    assert.ok(errorEvent);
    if (errorEvent.type === 'error') {
      assert.equal(errorEvent.code, 'builder.paused_on_issue');
    }

    const busPause = busEvents.find((e) => e.type === 'paused_on_issue');
    assert.ok(busPause);
    if (busPause.type === 'paused_on_issue') {
      assert.equal(busPause.issueRef.number, 77);
    }
  });

  it('runs normally when paused_on_issue is unset', async () => {
    let subAgentBuilt = 0;
    const agent = new BuilderAgent({
      anthropic: () => ({}) as Anthropic,
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
      referenceCatalog: {},
      systemPromptSeed: async () => 'TEST-SEED',
      buildSubAgent: () => {
        subAgentBuilt += 1;
        return {
          async ask() {
            return 'assistant says ok';
          },
        };
      },
      tools: [],
      templateRoot: tmp,
    });

    await collect(
      agent.runTurn({
        draftId,
        userEmail,
        userMessage: 'hello',
        modelChoice: 'claude-sonnet-4-6',
      }),
    );
    assert.equal(subAgentBuilt, 1);
    const pauseEvent = busEvents.find((e) => e.type === 'paused_on_issue');
    assert.equal(pauseEvent, undefined);
  });
});
