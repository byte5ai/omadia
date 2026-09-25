import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import {
  BuilderAgent,
  type BuilderEvent,
} from '../../src/plugins/builder/builderAgent.js';
import {
  PreviewChatService,
  type PreviewChatEvent,
} from '../../src/plugins/builder/previewChatService.js';
import type { PreviewHandle } from '../../src/plugins/builder/previewRuntime.js';
import {
  patchSpecTool,
  fillSlotTool,
  type BuilderTool,
} from '../../src/plugins/builder/tools/index.js';
import { noopSlotTypechecker } from './fixtures/noopSlotTypechecker.js';
import { installFakeClaudeCli, type FakeClaudeCli } from '../_helpers/fakeClaudeCli.js';

/**
 * #1072 (and #1077 rows `builderAgent.ts` defaultBuildSubAgent /
 * `previewChatService.ts` defaultBuildSubAgent) — the REAL default factories
 * on the subscription path. No `buildSubAgent` override: `resolveProvider`
 * returns a `cliModel`, so the builder goes through `createCliSubAgent` →
 * `CliChatAgent` → a spawned `claude`. A fake `claude` on the PATH replays
 * scripted stream-json, and the tests assert the live-view events reach the
 * builder stream and the `fill_slot` obligation re-prompts once.
 */

const OMADIA_PREFIX = 'mcp__omadia__';
const skipOnWindows = process.platform === 'win32';

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('BuilderAgent default factory on the subscription CLI (#1072)', { skip: skipOnWindows }, () => {
  let tmpRoot: string;
  let draftStore: DraftStore;
  let draftId: string;
  let fake: FakeClaudeCli | undefined;
  const userEmail = 'tester@example.com';

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'builder-cli-factory-'));
    mkdirSync(path.join(tmpRoot, 'reference'), { recursive: true });
    draftStore = new DraftStore({ dbPath: path.join(tmpRoot, 'drafts.db') });
    await draftStore.open();
    draftId = (await draftStore.create(userEmail, 'CLI Draft')).id;
  });

  afterEach(async () => {
    fake?.dispose();
    fake = undefined;
    await draftStore.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeAgent(): BuilderAgent {
    return new BuilderAgent({
      resolveProvider: async () => ({ cliModel: 'sonnet', modelId: 'claude-sonnet-cli' }),
      draftStore,
      bus: new SpecEventBus(),
      rebuildScheduler: { schedule() {} },
      catalogToolNames: () => [],
      knownPluginIds: () => [],
      slotTypechecker: noopSlotTypechecker,
      referenceCatalog: {
        'seo-analyst': { root: path.join(tmpRoot, 'reference'), description: 'test' },
      },
      systemPromptSeed: async () => 'TEST-SEED',
      templateRoot: tmpRoot,
      tools: [
        patchSpecTool as unknown as BuilderTool<unknown, unknown>,
        fillSlotTool as unknown as BuilderTool<unknown, unknown>,
      ],
    });
  }

  it('streams tool, token, usage and iteration events from the CLI into the builder turn', async () => {
    fake = installFakeClaudeCli({
      toolName: `${OMADIA_PREFIX}fill_slot`,
      toolInput: { slotKey: 'toolkit' },
      answer: 'Slot gefüllt.',
    });

    const events: BuilderEvent[] = await collect(
      makeAgent().runTurn({
        draftId,
        userEmail,
        userMessage: 'Wie sieht die Spec aus?',
        modelChoice: 'sonnet-cli',
      }),
    );

    const toolUse = events.find((e) => e.type === 'tool_use');
    assert.ok(toolUse && toolUse.type === 'tool_use', `no tool_use in ${JSON.stringify(events.map((e) => e.type))}`);
    assert.equal(toolUse.toolId, 'fill_slot');
    assert.deepEqual(toolUse.input, { slotKey: 'toolkit' });
    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.ok(toolResult && toolResult.type === 'tool_result');
    assert.equal(toolResult.toolId, 'fill_slot');
    assert.equal(toolResult.isError, false);
    assert.ok(events.some((e) => e.type === 'stream_token_chunk'), 'stream_token_chunk');
    assert.ok(events.some((e) => e.type === 'iteration_usage'), 'iteration_usage');
    assert.ok(events.some((e) => e.type === 'iteration_finished'), 'iteration_finished');
    const assistant = events.find((e) => e.type === 'chat_message' && e.role === 'assistant');
    assert.ok(assistant && assistant.type === 'chat_message');
    assert.equal(assistant.text, 'Slot gefüllt.');
    assert.equal(fake.spawnCount(), 1);
  });

  it('re-prompts once when a build turn ends without fill_slot', async () => {
    fake = installFakeClaudeCli({
      toolName: `${OMADIA_PREFIX}fill_slot`,
      // The original prompt never names the prefixed tool; the re-prompt does.
      toolOnlyWhenStdinIncludes: `${OMADIA_PREFIX}fill_slot`,
      answer: 'Ich baue jetzt alle Slots.',
    });

    const events: BuilderEvent[] = await collect(
      makeAgent().runTurn({
        draftId,
        userEmail,
        userMessage: 'Baue jetzt alle Slots durch.',
        modelChoice: 'sonnet-cli',
      }),
    );

    assert.equal(fake.spawnCount(), 2);
    const second = fake.prompts()[1] ?? '';
    assert.ok(second.includes('Baue jetzt alle Slots durch.'), 're-prompt carries the question');
    assert.ok(
      events.some((e) => e.type === 'tool_use' && e.toolId === 'fill_slot'),
      `no fill_slot tool_use in ${JSON.stringify(events.map((e) => e.type))}`,
    );
    assert.ok(events.some((e) => e.type === 'turn_done'));
  });
});

describe('PreviewChatService default factory on the subscription CLI (#1072)', { skip: skipOnWindows }, () => {
  let tmpRoot: string;
  let draftStore: DraftStore;
  let fake: FakeClaudeCli | undefined;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'preview-cli-factory-'));
    draftStore = new DraftStore({ dbPath: path.join(tmpRoot, 'drafts.db') });
    await draftStore.open();
  });

  afterEach(async () => {
    fake?.dispose();
    fake = undefined;
    await draftStore.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('streams preview tool_use/tool_result events from the CLI', async () => {
    fake = installFakeClaudeCli({
      toolName: `${OMADIA_PREFIX}echo`,
      toolInput: { q: 'hi' },
      answer: 'Echo ausgeführt.',
    });
    const draft = await draftStore.create('alice@example.com', 'Echo Bot');
    const handle: PreviewHandle = {
      draftId: draft.id,
      agentId: `agent-${draft.id}`,
      rev: 1,
      previewDir: path.join(tmpRoot, 'preview'),
      toolkit: {
        tools: [
          {
            id: 'echo',
            description: 'echo tool',
            input: z.object({ q: z.string() }),
            run: async (input: unknown) => ({ echo: input }),
          },
        ],
      },
      routeCaptures: [],
      jobCaptures: [],
      statusReports: [],
      close: async () => {},
    };
    const svc = new PreviewChatService({
      resolveProvider: async () => ({ cliModel: 'sonnet', modelId: 'claude-sonnet-cli' }),
      draftStore,
      systemPromptFor: async () => 'preview-system-prompt',
      logger: () => {},
    });

    const events: PreviewChatEvent[] = await collect(
      svc.runTurn({
        handle,
        userEmail: 'alice@example.com',
        userMessage: 'please call echo',
        modelChoice: 'sonnet-cli',
      }),
    );

    const toolUse = events.find((e) => e.type === 'tool_use');
    assert.ok(toolUse && toolUse.type === 'tool_use', `no tool_use in ${JSON.stringify(events.map((e) => e.type))}`);
    assert.equal(toolUse.toolId, 'echo');
    assert.deepEqual(toolUse.input, { q: 'hi' });
    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.ok(toolResult && toolResult.type === 'tool_result');
    assert.equal(toolResult.toolId, 'echo');
    assert.equal(toolResult.isError, false);
    assert.equal(fake.spawnCount(), 1);
  });
});
