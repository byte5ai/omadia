import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import type Anthropic from '@anthropic-ai/sdk';
import type { AskObserver } from '@omadia/orchestrator';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import {
  PreviewChatService,
  loadPreviewSystemPrompt,
  type PreviewChatEvent,
  type SubAgentBuildOptions,
} from '../../src/plugins/builder/previewChatService.js';
import type {
  PreviewHandle,
  PreviewToolDescriptor,
  PreviewToolkit,
} from '../../src/plugins/builder/previewRuntime.js';
import type { AgentSpecSkeleton } from '../../src/plugins/builder/types.js';
import { emptyAgentSpec } from '../../src/plugins/builder/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeFakeTool(opts: {
  id: string;
  description?: string;
  schema?: z.ZodType<unknown>;
  run?: (input: unknown) => Promise<unknown>;
}): PreviewToolDescriptor {
  return {
    id: opts.id,
    description: opts.description ?? `tool ${opts.id}`,
    input: opts.schema ?? z.object({ q: z.string() }),
    run:
      opts.run ??
      (async (input: unknown) => ({ echo: input })),
  };
}

function makeHandle(opts: {
  draftId: string;
  agentId?: string;
  rev?: number;
  previewDir?: string;
  tools?: PreviewToolDescriptor[];
}): PreviewHandle {
  const toolkit: PreviewToolkit = {
    tools: opts.tools ?? [],
  };
  return {
    draftId: opts.draftId,
    agentId: opts.agentId ?? `agent-${opts.draftId}`,
    rev: opts.rev ?? 1,
    previewDir: opts.previewDir ?? `/tmp/${opts.draftId}-preview`,
    toolkit,
    routeCaptures: [],
    close: async () => {},
  };
}

interface SubAgentScript {
  /** Each entry mocks a tool-use round-trip seen by the observer. */
  toolCalls?: Array<{
    id: string;
    name: string;
    input: unknown;
    output: string;
    isError?: boolean;
    durationMs?: number;
  }>;
  /** Final assistant text returned by ask(). */
  finalText: string;
  /** Optional throw — simulates Anthropic / sub-agent failure. */
  throws?: Error;
}

interface FakeSubAgentRecord {
  options: SubAgentBuildOptions;
  questions: string[];
}

function fakeSubAgentBuilder(script: SubAgentScript): {
  build: (opts: SubAgentBuildOptions) => {
    ask: (q: string, observer?: AskObserver) => Promise<string>;
  };
  records: FakeSubAgentRecord[];
} {
  const records: FakeSubAgentRecord[] = [];
  const build = (opts: SubAgentBuildOptions) => {
    const record: FakeSubAgentRecord = { options: opts, questions: [] };
    records.push(record);
    return {
      ask: async (question: string, observer?: AskObserver): Promise<string> => {
        record.questions.push(question);
        for (const call of script.toolCalls ?? []) {
          observer?.onSubToolUse?.({
            id: call.id,
            name: call.name,
            input: call.input,
          });
          observer?.onSubToolResult?.({
            id: call.id,
            output: call.output,
            durationMs: call.durationMs ?? 1,
            isError: call.isError ?? false,
          });
        }
        if (script.throws) throw script.throws;
        return script.finalText;
      },
    };
  };
  return { build, records };
}

const fakeAnthropic = {} as unknown as Anthropic;

async function collectEvents(
  iter: AsyncIterable<PreviewChatEvent>,
): Promise<PreviewChatEvent[]> {
  const out: PreviewChatEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PreviewChatService', () => {
  let tmp: string;
  let store: DraftStore;
  let dbPath: string;

  before(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'preview-chat-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (store) await store.close();
    dbPath = path.join(
      tmp,
      `drafts-${String(Date.now())}-${String(Math.random())}.db`,
    );
    store = new DraftStore({ dbPath });
    await store.open();
  });

  describe('runTurn', () => {
    it('streams user-echo, tool_use+tool_result, assistant final, turn_done in order', async () => {
      const draft = await store.create('alice@example.com', 'Echo Bot');
      const tool = makeFakeTool({ id: 'echo' });
      const handle = makeHandle({
        draftId: draft.id,
        tools: [tool],
      });
      const fake = fakeSubAgentBuilder({
        toolCalls: [
          {
            id: 'use_001',
            name: 'echo',
            input: { q: 'hi' },
            output: '{"echo":{"q":"hi"}}',
          },
        ],
        finalText: 'I called the echo tool.',
      });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'system-prompt-stub',
        buildSubAgent: fake.build,
        logger: () => {},
      });

      const events = await collectEvents(
        svc.runTurn({
          handle,
          userEmail: 'alice@example.com',
          userMessage: 'please call echo',
          modelChoice: 'claude-haiku-4-5-20251001',
        }),
      );

      assert.equal(events.length, 5);
      assert.deepEqual(events[0], {
        type: 'chat_message',
        role: 'user',
        text: 'please call echo',
      });
      assert.equal(events[1]?.type, 'tool_use');
      if (events[1]?.type !== 'tool_use') throw new Error('unexpected');
      assert.equal(events[1].toolId, 'echo');
      assert.equal(events[1].useId, 'use_001');
      assert.deepEqual(events[1].input, { q: 'hi' });

      assert.equal(events[2]?.type, 'tool_result');
      if (events[2]?.type !== 'tool_result') throw new Error('unexpected');
      assert.equal(events[2].toolId, 'echo');
      assert.equal(events[2].useId, 'use_001');
      assert.equal(events[2].output, '{"echo":{"q":"hi"}}');
      assert.equal(events[2].isError, false);

      assert.deepEqual(events[3], {
        type: 'chat_message',
        role: 'assistant',
        text: 'I called the echo tool.',
      });
      assert.equal(events[4]?.type, 'turn_done');
    });

    it('persists user + assistant turns into preview_transcript', async () => {
      const draft = await store.create('alice@example.com', 'Echo Bot');
      const handle = makeHandle({ draftId: draft.id });
      const fake = fakeSubAgentBuilder({ finalText: 'OK' });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        buildSubAgent: fake.build,
        logger: () => {},
      });

      // Drain the iterator.
      await collectEvents(
        svc.runTurn({
          handle,
          userEmail: 'alice@example.com',
          userMessage: 'first turn',
          modelChoice: 'claude-haiku-4-5-20251001',
        }),
      );

      const reloaded = await store.load('alice@example.com', draft.id);
      assert.ok(reloaded);
      assert.equal(reloaded.previewTranscript.length, 2);
      assert.equal(reloaded.previewTranscript[0]?.role, 'user');
      assert.equal(reloaded.previewTranscript[0]?.content, 'first turn');
      assert.equal(reloaded.previewTranscript[1]?.role, 'assistant');
      assert.equal(reloaded.previewTranscript[1]?.content, 'OK');
    });

    it('injects prior previewTranscript as a context block into ask()', async () => {
      const draft = await store.create('alice@example.com', 'Echo Bot');
      // Seed previewTranscript with a previous round so the next turn has
      // something to remember.
      await store.update('alice@example.com', draft.id, {
        previewTranscript: [
          { role: 'user', content: 'gib mir Wetter Berlin', timestamp: 1 },
          {
            role: 'assistant',
            content: '12 °C, leicht bewölkt',
            timestamp: 2,
          },
        ],
      });
      const handle = makeHandle({ draftId: draft.id });
      const fake = fakeSubAgentBuilder({ finalText: 'noted' });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        buildSubAgent: fake.build,
        logger: () => {},
      });

      await collectEvents(
        svc.runTurn({
          handle,
          userEmail: 'alice@example.com',
          userMessage: 'und morgen?',
          modelChoice: 'claude-haiku-4-5-20251001',
        }),
      );

      const q = fake.records[0]?.questions[0] ?? '';
      assert.ok(q.includes('<conversation-history>'));
      assert.ok(q.includes('gib mir Wetter Berlin'));
      assert.ok(q.includes('12 °C, leicht bewölkt'));
      assert.ok(q.includes('<current-user-message>'));
      assert.ok(q.includes('und morgen?'));
    });

    it('passes the bare user message through when previewTranscript is empty', async () => {
      const draft = await store.create('alice@example.com', 'Echo Bot');
      const handle = makeHandle({ draftId: draft.id });
      const fake = fakeSubAgentBuilder({ finalText: 'ack' });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        buildSubAgent: fake.build,
        logger: () => {},
      });

      await collectEvents(
        svc.runTurn({
          handle,
          userEmail: 'alice@example.com',
          userMessage: 'erste Frage',
          modelChoice: 'claude-haiku-4-5-20251001',
        }),
      );
      assert.equal(fake.records[0]?.questions[0], 'erste Frage');
    });

    it('passes Anthropic model + system prompt + bridged tools to the sub-agent', async () => {
      const draft = await store.create('alice@example.com', 'Echo Bot');
      const tool = makeFakeTool({ id: 'echo' });
      const handle = makeHandle({ draftId: draft.id, tools: [tool] });
      const fake = fakeSubAgentBuilder({ finalText: 'OK' });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'CUSTOM-PROMPT',
        buildSubAgent: fake.build,
        subAgentMaxTokens: 2048,
        subAgentMaxIterations: 4,
        logger: () => {},
      });

      await collectEvents(
        svc.runTurn({
          handle,
          userEmail: 'alice@example.com',
          userMessage: 'go',
          modelChoice: 'claude-haiku-4-5-20251001',
        }),
      );

      assert.equal(fake.records.length, 1);
      const built = fake.records[0];
      if (!built) throw new Error('expected one built sub-agent');
      assert.equal(built.options.model, 'claude-haiku-4-5-20251001');
      assert.equal(built.options.maxTokens, 2048);
      assert.equal(built.options.maxIterations, 4);
      assert.equal(built.options.systemPrompt, 'CUSTOM-PROMPT');
      assert.equal(built.options.tools.length, 1);
      assert.equal(built.options.tools[0]?.spec.name, 'echo');
      assert.equal(built.options.tools[0]?.spec.input_schema.type, 'object');
      assert.deepEqual(built.questions, ['go']);
    });

    it('propagates sub-agent errors through the AsyncIterable', async () => {
      const draft = await store.create('alice@example.com', 'Echo Bot');
      const handle = makeHandle({ draftId: draft.id });
      const fake = fakeSubAgentBuilder({
        finalText: '',
        throws: new Error('anthropic-rate-limit'),
      });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        buildSubAgent: fake.build,
        logger: () => {},
      });

      await assert.rejects(
        async () =>
          collectEvents(
            svc.runTurn({
              handle,
              userEmail: 'alice@example.com',
              userMessage: 'go',
              modelChoice: 'claude-haiku-4-5-20251001',
            }),
          ),
        /anthropic-rate-limit/,
      );
    });

    it('throws if the draft does not belong to the requesting user', async () => {
      const draft = await store.create('alice@example.com', 'Echo Bot');
      const handle = makeHandle({ draftId: draft.id });
      const fake = fakeSubAgentBuilder({ finalText: 'unused' });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        buildSubAgent: fake.build,
        logger: () => {},
      });

      await assert.rejects(
        async () =>
          collectEvents(
            svc.runTurn({
              handle,
              userEmail: 'mallory@example.com',
              userMessage: 'go',
              modelChoice: 'claude-haiku-4-5-20251001',
            }),
          ),
        /draft not found/,
      );
    });

    it('appends to existing transcript without overwriting earlier turns', async () => {
      const draft = await store.create('alice@example.com', 'Echo Bot');
      await store.update('alice@example.com', draft.id, {
        previewTranscript: [
          { role: 'user', content: 'older user', timestamp: 1 },
          { role: 'assistant', content: 'older assistant', timestamp: 2 },
        ],
      });

      const handle = makeHandle({ draftId: draft.id });
      const fake = fakeSubAgentBuilder({ finalText: 'new reply' });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        buildSubAgent: fake.build,
        logger: () => {},
      });

      await collectEvents(
        svc.runTurn({
          handle,
          userEmail: 'alice@example.com',
          userMessage: 'new user',
          modelChoice: 'claude-haiku-4-5-20251001',
        }),
      );

      const reloaded = await store.load('alice@example.com', draft.id);
      assert.ok(reloaded);
      assert.equal(reloaded.previewTranscript.length, 4);
      assert.equal(reloaded.previewTranscript[0]?.content, 'older user');
      assert.equal(reloaded.previewTranscript[2]?.content, 'new user');
      assert.equal(reloaded.previewTranscript[3]?.content, 'new reply');
    });

    it('correlates tool_result back to its tool_use via useId map', async () => {
      const draft = await store.create('alice@example.com', 'Echo Bot');
      const handle = makeHandle({
        draftId: draft.id,
        tools: [makeFakeTool({ id: 'a' }), makeFakeTool({ id: 'b' })],
      });
      const fake = fakeSubAgentBuilder({
        toolCalls: [
          { id: 'use_a', name: 'a', input: {}, output: 'A' },
          { id: 'use_b', name: 'b', input: {}, output: 'B' },
        ],
        finalText: 'done',
      });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        buildSubAgent: fake.build,
        logger: () => {},
      });

      const events = await collectEvents(
        svc.runTurn({
          handle,
          userEmail: 'alice@example.com',
          userMessage: 'do both',
          modelChoice: 'claude-haiku-4-5-20251001',
        }),
      );

      const results = events.filter(
        (e): e is Extract<PreviewChatEvent, { type: 'tool_result' }> =>
          e.type === 'tool_result',
      );
      assert.equal(results.length, 2);
      assert.equal(results[0]?.toolId, 'a');
      assert.equal(results[0]?.useId, 'use_a');
      assert.equal(results[1]?.toolId, 'b');
      assert.equal(results[1]?.useId, 'use_b');
    });
  });

  describe('runDirectTool', () => {
    it('invokes the tool with Zod-validated input and returns the result', async () => {
      const tool = makeFakeTool({
        id: 'sum',
        schema: z.object({ a: z.number(), b: z.number() }),
        run: async (input) => {
          const v = input as { a: number; b: number };
          return { sum: v.a + v.b };
        },
      });
      const handle = makeHandle({ draftId: 'd1', tools: [tool] });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        logger: () => {},
      });

      const out = await svc.runDirectTool({
        handle,
        toolId: 'sum',
        input: { a: 2, b: 3 },
      });
      assert.equal(out.isError, false);
      assert.deepEqual(out.result, { sum: 5 });
    });

    it('returns isError=true on unknown toolId', async () => {
      const handle = makeHandle({ draftId: 'd1' });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        logger: () => {},
      });
      const out = await svc.runDirectTool({
        handle,
        toolId: 'does-not-exist',
        input: {},
      });
      assert.equal(out.isError, true);
      assert.match((out.result as { error: string }).error, /unknown tool/);
    });

    it('returns isError=true when the tool throws', async () => {
      const tool = makeFakeTool({
        id: 'broken',
        run: async () => {
          throw new Error('boom');
        },
      });
      const handle = makeHandle({ draftId: 'd1', tools: [tool] });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        logger: () => {},
      });
      const out = await svc.runDirectTool({
        handle,
        toolId: 'broken',
        input: { q: 'x' },
      });
      assert.equal(out.isError, true);
      assert.match((out.result as { error: string }).error, /boom/);
    });

    it('returns isError=true on Zod-validation failure', async () => {
      const tool = makeFakeTool({
        id: 'strict',
        schema: z.object({ q: z.string() }),
      });
      const handle = makeHandle({ draftId: 'd1', tools: [tool] });
      const svc = new PreviewChatService({
        anthropic: fakeAnthropic,
        draftStore: store,
        systemPromptFor: async () => 'sp',
        logger: () => {},
      });
      const out = await svc.runDirectTool({
        handle,
        toolId: 'strict',
        input: { q: 42 },
      });
      assert.equal(out.isError, true);
    });
  });

  describe('loadPreviewSystemPrompt', () => {
    let promptDir: string;

    beforeEach(() => {
      promptDir = mkdtempSync(path.join(tmp, 'prompt-'));
    });

    function makeSpec(over: Partial<AgentSpecSkeleton> = {}): AgentSpecSkeleton {
      const base = emptyAgentSpec();
      return {
        ...base,
        ...over,
        playbook: {
          ...base.playbook,
          ...(over.playbook ?? {}),
        },
      };
    }

    it('returns header-only prompt when skills/ is missing', async () => {
      const handle = makeHandle({
        draftId: 'd1',
        previewDir: promptDir,
      });
      const spec = makeSpec({
        id: 'foo.bar',
        name: 'Foo Bar',
        version: '1.0.0',
        description: 'A test agent.',
        playbook: {
          when_to_use: 'whenever',
          not_for: [],
          example_prompts: [],
        },
      });
      const out = await loadPreviewSystemPrompt(handle, spec);
      assert.match(out, /^# Foo Bar \(foo\.bar v1\.0\.0\) — preview/);
      assert.match(out, /A test agent\./);
      assert.match(out, /## Wann nutzen\n\nwhenever/);
    });

    it('reads + concatenates skills/*.md, stripping frontmatter', async () => {
      const skillsDir = path.join(promptDir, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        path.join(skillsDir, 'a-first.md'),
        '---\nname: first\n---\nFIRST BODY',
      );
      writeFileSync(
        path.join(skillsDir, 'b-second.md'),
        'NO-FRONTMATTER-BODY',
      );
      writeFileSync(path.join(skillsDir, 'ignore.txt'), 'ignored');

      const handle = makeHandle({
        draftId: 'd1',
        previewDir: promptDir,
      });
      const spec = makeSpec({ id: 'p.x', name: 'Px', version: '0.1.0' });
      const out = await loadPreviewSystemPrompt(handle, spec);
      assert.match(out, /FIRST BODY/);
      assert.match(out, /NO-FRONTMATTER-BODY/);
      assert.equal(out.includes('ignored'), false);
      // Order: a-first before b-second (sorted).
      assert.ok(out.indexOf('FIRST BODY') < out.indexOf('NO-FRONTMATTER-BODY'));
    });
  });
});
