import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createHaikuSessionSummaryGenerator,
  SESSION_SUMMARY_MARKER,
} from '@omadia/orchestrator-extras/dist/sessionSummaryGenerator.js';

// Minimal Anthropic-stub. Captures the `messages.create` payload + returns
// a scripted reply. Exercises the JSON-prompt + truncate paths without
// hitting the real API.
interface CapturedCall {
  model: string;
  maxTokens: number;
  system: string;
  userContent: string;
}

function makeFakeAnthropic(opts: {
  reply?: string;
  throwOnCall?: boolean;
}): {
  client: { messages: { create: (req: unknown) => Promise<unknown> } };
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const client = {
    messages: {
      async create(req: unknown): Promise<unknown> {
        if (opts.throwOnCall) throw new Error('haiku-down');
        const r = req as {
          model: string;
          max_tokens: number;
          system: string;
          messages: ReadonlyArray<{ role: string; content: string }>;
        };
        calls.push({
          model: r.model,
          maxTokens: r.max_tokens,
          system: r.system,
          userContent: r.messages[0]?.content ?? '',
        });
        return {
          content: [{ type: 'text', text: opts.reply ?? '' }],
        };
      },
    },
  };
  return { client, calls };
}

describe('createHaikuSessionSummaryGenerator', () => {
  it('skips the LLM call when there are no turns', async () => {
    const { client, calls } = makeFakeAnthropic({ reply: 'should-not-show' });
    const gen = createHaikuSessionSummaryGenerator({
      anthropic: client as never,
      log: () => {},
    });
    const out = await gen.generate({ scope: 'chat-1', turns: [] });
    assert.equal(out, '');
    assert.equal(calls.length, 0);
  });

  it('skips the LLM call when all turns carry the session-summary marker', async () => {
    const { client, calls } = makeFakeAnthropic({ reply: 'should-not-show' });
    const gen = createHaikuSessionSummaryGenerator({
      anthropic: client as never,
      log: () => {},
    });
    const out = await gen.generate({
      scope: 'chat-1',
      turns: [
        {
          time: '2026-05-08T10:00:00Z',
          userMessage: SESSION_SUMMARY_MARKER,
          assistantAnswer: 'old summary',
        },
      ],
    });
    assert.equal(out, '');
    assert.equal(calls.length, 0);
  });

  it('passes turns to Haiku and returns the trimmed bullet text', async () => {
    const reply = `- Entscheidung: Migration 0008 deployt
- Output: REST-Endpoint live
- Offen: Doku ergänzen`;
    const { client, calls } = makeFakeAnthropic({ reply: `\n${reply}\n` });
    const gen = createHaikuSessionSummaryGenerator({
      anthropic: client as never,
      log: () => {},
    });
    const out = await gen.generate({
      scope: 'builder-3',
      turns: [
        {
          time: '2026-05-08T10:00:00Z',
          userMessage: 'Wir sollten Migration 0008 deployen',
          assistantAnswer: 'Geht klar — REST-Endpoint geht dann live.',
        },
        {
          time: '2026-05-08T10:05:00Z',
          userMessage: 'Was ist mit der Doku?',
          assistantAnswer: 'Die ergänze ich später.',
        },
      ],
    });
    assert.equal(out, reply);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call !== undefined);
    assert.ok(/scope="builder-3"/.test(call.userContent));
    assert.ok(/Migration 0008/.test(call.userContent));
    assert.ok(/Doku/.test(call.userContent));
    // System prompt covers the key sections
    assert.ok(/Entscheidungen/.test(call.system));
    assert.ok(/Outputs/.test(call.system));
    assert.ok(/Offene Tasks/.test(call.system));
  });

  it('returns empty string + does not throw when Haiku errors', async () => {
    const { client } = makeFakeAnthropic({ throwOnCall: true });
    const logs: string[] = [];
    const gen = createHaikuSessionSummaryGenerator({
      anthropic: client as never,
      log: (msg: string) => { logs.push(msg); },
    });
    const out = await gen.generate({
      scope: 'chat-1',
      turns: [
        {
          time: '2026-05-08T10:00:00Z',
          userMessage: 'q',
          assistantAnswer: 'a',
        },
      ],
    });
    assert.equal(out, '');
    assert.ok(logs.some((l) => /haiku-down/.test(l)));
  });

  it('truncates very long turn bodies before sending to Haiku', async () => {
    const { client, calls } = makeFakeAnthropic({ reply: '- ok' });
    const gen = createHaikuSessionSummaryGenerator({
      anthropic: client as never,
      log: () => {},
    });
    await gen.generate({
      scope: 'chat-1',
      turns: [
        {
          time: '2026-05-08T10:00:00Z',
          userMessage: 'A'.repeat(2000),
          assistantAnswer: 'B'.repeat(5000),
        },
      ],
    });
    const sent = calls[0]?.userContent ?? '';
    // Both legs should be truncated (truncate adds an ellipsis).
    assert.ok(sent.includes('…'));
    // And the total payload stays well below the original 7000-char input.
    assert.ok(sent.length < 3000);
  });

  it('drops empty turns from the prompt input', async () => {
    const { client, calls } = makeFakeAnthropic({ reply: '- ok' });
    const gen = createHaikuSessionSummaryGenerator({
      anthropic: client as never,
      log: () => {},
    });
    await gen.generate({
      scope: 'chat-1',
      turns: [
        {
          time: '2026-05-08T10:00:00Z',
          userMessage: '',
          assistantAnswer: '   ',
        },
        {
          time: '2026-05-08T10:05:00Z',
          userMessage: 'real',
          assistantAnswer: 'answer',
        },
      ],
    });
    const sent = calls[0]?.userContent ?? '';
    // Only the real turn made it in.
    assert.equal((sent.match(/User: /g) ?? []).length, 1);
    assert.ok(/User: real/.test(sent));
  });
});
