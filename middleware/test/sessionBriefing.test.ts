import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { KnowledgeGraph } from '@omadia/plugin-api';

import {
  createSessionBriefingService,
  type SessionSummaryGenerator,
} from '@omadia/orchestrator-extras/dist/index.js';
import { SESSION_SUMMARY_MARKER } from '@omadia/orchestrator-extras/dist/sessionSummaryGenerator.js';

// ---------------------------------------------------------------------------
// MockKG — minimal KnowledgeGraph stub with a scripted getSession + a capture
// of ingestTurn calls so we can assert the summary persist convention.
// ---------------------------------------------------------------------------

interface MockTurn {
  id: string;
  time: string;
  userMessage: string;
  assistantAnswer: string;
}

interface IngestCall {
  scope: string;
  time: string;
  userMessage: string;
  assistantAnswer: string;
  entryType?: string;
}

function makeMockKg(turns: ReadonlyArray<MockTurn>): {
  kg: KnowledgeGraph;
  ingests: IngestCall[];
} {
  const ingests: IngestCall[] = [];
  const kg = {
    async getSession(scope: string) {
      if (turns.length === 0) return null;
      return {
        scope,
        turns: turns.map((t) => ({
          turn: {
            id: t.id,
            type: 'Turn' as const,
            props: {
              time: t.time,
              userMessage: t.userMessage,
              assistantAnswer: t.assistantAnswer,
            },
          },
          capturedEntities: [],
        })),
        runId: null,
        agentInvocationIds: [],
        toolCallIds: [],
      };
    },
    async ingestTurn(turn: {
      scope: string;
      time: string;
      userMessage: string;
      assistantAnswer: string;
      entryType?: string;
    }) {
      ingests.push({
        scope: turn.scope,
        time: turn.time,
        userMessage: turn.userMessage,
        assistantAnswer: turn.assistantAnswer,
        ...(turn.entryType ? { entryType: turn.entryType } : {}),
      });
      return {
        sessionId: `session:${turn.scope}`,
        turnId: `turn:${turn.scope}:${turn.time}`,
        entityNodeIds: [],
      };
    },
    async findEntityCapturedTurns() { return []; },
    async searchTurns() { return []; },
    async searchTurnsByEmbedding() { return []; },
    async getNeighbors() { return []; },
    async findEntities() { return []; },
    async listSessions() { return []; },
    async getStats() {
      return {
        totalNodes: 0,
        totalEdges: 0,
        byNodeType: {} as Record<string, number>,
        byEdgeType: {} as Record<string, number>,
      };
    },
  } as unknown as KnowledgeGraph;
  return { kg, ingests };
}

class StubGenerator implements SessionSummaryGenerator {
  constructor(public reply: string, public calls: number = 0) {}
  async generate(): Promise<string> {
    this.calls += 1;
    return this.reply;
  }
}

const ANCIENT = '2024-01-01T08:00:00.000Z';
const ANCIENT2 = '2024-01-01T08:01:00.000Z';

describe('SessionBriefingService.loadSessionBriefing', () => {
  it('mode=empty when the scope is unknown', async () => {
    const { kg } = makeMockKg([]);
    const gen = new StubGenerator('');
    const svc = createSessionBriefingService({
      kg,
      summaryGenerator: gen,
      log: () => {},
    });
    const r = await svc.loadSessionBriefing({
      scope: 'nope',
      agentId: 'agent-test',
    });
    assert.equal(r.mode, 'empty');
    assert.equal(r.text, '');
    assert.equal(gen.calls, 0);
  });

  it('mode=resume when the newest non-marker turn is fresh (< window)', async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString(); // 5min ago
    const { kg } = makeMockKg([
      {
        id: 'turn:s:t1',
        time: recent,
        userMessage: 'wo waren wir?',
        assistantAnswer: 'beim deployment',
      },
    ]);
    const gen = new StubGenerator('');
    const svc = createSessionBriefingService({
      kg,
      summaryGenerator: gen,
      log: () => {},
    });
    const r = await svc.loadSessionBriefing({
      scope: 's',
      agentId: 'agent-test',
    });
    assert.equal(r.mode, 'resume');
    assert.equal(r.stats.resumeTurns, 1);
    assert.equal(gen.calls, 0);
    assert.ok(/Resume/.test(r.text));
    assert.ok(/wo waren wir\?/.test(r.text));
  });

  it('mode=briefing regenerates summary when newest turn is older than window AND no fresh summary', async () => {
    const { kg, ingests } = makeMockKg([
      {
        id: 'turn:s:t1',
        time: ANCIENT,
        userMessage: 'Migration 0008?',
        assistantAnswer: 'deployed.',
      },
    ]);
    const gen = new StubGenerator('- Decision: Migration 0008 deployed');
    const svc = createSessionBriefingService({
      kg,
      summaryGenerator: gen,
      log: () => {},
    });
    const r = await svc.loadSessionBriefing({
      scope: 's',
      agentId: 'agent-test',
    });
    assert.equal(r.mode, 'briefing');
    assert.equal(gen.calls, 1);
    assert.equal(r.stats.summaryRegenerated, true);
    assert.equal(r.stats.summaryFound, false);
    assert.ok(/Briefing/.test(r.text));
    assert.ok(/Migration 0008 deployed/.test(r.text));
    // Persisted via ingestTurn with the marker convention.
    assert.equal(ingests.length, 1);
    const persist = ingests[0];
    assert.ok(persist !== undefined);
    assert.equal(persist.userMessage, SESSION_SUMMARY_MARKER);
    assert.equal(persist.entryType, 'process');
    assert.equal(persist.assistantAnswer, '- Decision: Migration 0008 deployed');
  });

  it('mode=briefing reuses existing summary when newer than newest non-marker turn', async () => {
    const { kg, ingests } = makeMockKg([
      {
        id: 'turn:s:t1',
        time: ANCIENT,
        userMessage: 'real chat',
        assistantAnswer: 'real answer',
      },
      {
        id: 'turn:s:t2',
        time: ANCIENT2,
        userMessage: SESSION_SUMMARY_MARKER,
        assistantAnswer: '- Cached: prior summary bullets',
      },
    ]);
    const gen = new StubGenerator('SHOULD NOT BE CALLED');
    const svc = createSessionBriefingService({
      kg,
      summaryGenerator: gen,
      log: () => {},
    });
    const r = await svc.loadSessionBriefing({
      scope: 's',
      agentId: 'agent-test',
    });
    assert.equal(r.mode, 'briefing');
    assert.equal(gen.calls, 0); // didn't regenerate
    assert.equal(r.stats.summaryRegenerated, false);
    assert.equal(r.stats.summaryFound, true);
    assert.ok(/prior summary bullets/.test(r.text));
    assert.equal(ingests.length, 0);
  });

  it('mode=briefing regenerates when latest summary is older than newest non-marker turn', async () => {
    const { kg, ingests } = makeMockKg([
      // Summary is OLDER than the real turn → stale, must regenerate.
      {
        id: 'turn:s:t1',
        time: ANCIENT,
        userMessage: SESSION_SUMMARY_MARKER,
        assistantAnswer: '- old bullets',
      },
      {
        id: 'turn:s:t2',
        time: ANCIENT2,
        userMessage: 'newer chat',
        assistantAnswer: 'newer answer',
      },
    ]);
    const gen = new StubGenerator('- Fresh: regenerated bullets');
    const svc = createSessionBriefingService({
      kg,
      summaryGenerator: gen,
      log: () => {},
    });
    const r = await svc.loadSessionBriefing({
      scope: 's',
      agentId: 'agent-test',
    });
    assert.equal(r.mode, 'briefing');
    assert.equal(gen.calls, 1);
    assert.equal(r.stats.summaryRegenerated, true);
    assert.ok(/regenerated bullets/.test(r.text));
    assert.equal(ingests.length, 1);
  });

  it('budgetTokens caps the rendered output', async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const { kg } = makeMockKg([
      {
        id: 'turn:s:t1',
        time: recent,
        userMessage: 'A'.repeat(2000),
        assistantAnswer: 'B'.repeat(4000),
      },
      {
        id: 'turn:s:t2',
        time: recent,
        userMessage: 'C'.repeat(2000),
        assistantAnswer: 'D'.repeat(4000),
      },
    ]);
    const svc = createSessionBriefingService({
      kg,
      summaryGenerator: new StubGenerator(''),
      log: () => {},
      // 10 tokens × 4 chars/token = 40 char budget — heading already hits cap.
      defaultBudgetTokens: 10,
    });
    const r = await svc.loadSessionBriefing({
      scope: 's',
      agentId: 'agent-test',
      budgetTokens: 10,
    });
    assert.equal(r.mode, 'resume');
    assert.ok(r.text.length <= 80, `expected <= 80 char, got ${String(r.text.length)}`);
  });

  it('treats marker-only turns as no real content (mode=empty)', async () => {
    const { kg } = makeMockKg([
      {
        id: 'turn:s:t1',
        time: ANCIENT,
        userMessage: SESSION_SUMMARY_MARKER,
        assistantAnswer: '- old bullets',
      },
    ]);
    const svc = createSessionBriefingService({
      kg,
      summaryGenerator: new StubGenerator('SHOULD NOT BE CALLED'),
      log: () => {},
    });
    const r = await svc.loadSessionBriefing({
      scope: 's',
      agentId: 'agent-test',
    });
    assert.equal(r.mode, 'empty');
    assert.equal(r.text, '');
  });

  it('returns mode=empty when generator yields empty string and no prior summary', async () => {
    const { kg, ingests } = makeMockKg([
      {
        id: 'turn:s:t1',
        time: ANCIENT,
        userMessage: 'q',
        assistantAnswer: 'a',
      },
    ]);
    const svc = createSessionBriefingService({
      kg,
      summaryGenerator: new StubGenerator(''), // Haiku failure / empty
      log: () => {},
    });
    const r = await svc.loadSessionBriefing({
      scope: 's',
      agentId: 'agent-test',
    });
    assert.equal(r.mode, 'empty');
    assert.equal(r.text, '');
    assert.equal(ingests.length, 0); // empty result not persisted
  });
});
