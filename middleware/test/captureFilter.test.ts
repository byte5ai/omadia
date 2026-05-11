import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CaptureFilter,
  CaptureFilteringKnowledgeGraph,
  parseHints,
  stripPrivacy,
  type SignificanceScorer,
} from '@omadia/orchestrator-extras';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

// ---------------------------------------------------------------------------
// stripPrivacy
// ---------------------------------------------------------------------------
describe('stripPrivacy', () => {
  it('removes a single <private>...</private> block', () => {
    const r = stripPrivacy('hello <private>secret</private> world');
    assert.equal(r.cleaned, 'hello  world');
    assert.equal(r.blocksStripped, 1);
  });

  it('removes multiple blocks in one string', () => {
    const r = stripPrivacy(
      '<private>a</private> mid <private>b</private> end',
    );
    assert.equal(r.cleaned, ' mid  end');
    assert.equal(r.blocksStripped, 2);
  });

  it('removes a multi-line block', () => {
    const r = stripPrivacy(
      'before\n<private>line1\nline2\nline3</private>\nafter',
    );
    assert.equal(r.cleaned, 'before\n\nafter');
    assert.equal(r.blocksStripped, 1);
  });

  it('treats nested-looking tags as plain text (no nesting allowed)', () => {
    // The regex is non-greedy, so the FIRST closing </private> ends the
    // block. The inner `<private>inner</private>` literal is consumed
    // along with the wrapping tags; the trailing fragment leaks because
    // the regex isn't a nesting parser. Documented by HANDOFF.
    const r = stripPrivacy('<private>outer<private>inner</private>tail</private>');
    assert.equal(r.blocksStripped, 1);
    assert.ok(r.cleaned.includes('tail'));
  });

  it('returns the input unchanged when no blocks present', () => {
    const r = stripPrivacy('plain text without markers');
    assert.equal(r.cleaned, 'plain text without markers');
    assert.equal(r.blocksStripped, 0);
  });
});

// ---------------------------------------------------------------------------
// parseHints
// ---------------------------------------------------------------------------
describe('parseHints', () => {
  it('extracts and strips a single hint', () => {
    const r = parseHints(
      'todo <palaia-hint type="task" visibility="private" /> rest',
    );
    assert.equal(r.tagsStripped, 1);
    assert.equal(r.hints.length, 1);
    assert.equal(r.hints[0]?.type, 'task');
    assert.equal(r.hints[0]?.visibility, 'private');
    assert.equal(r.hints[0]?.force, false);
    assert.ok(!r.cleaned.includes('palaia-hint'));
  });

  it('honours force="true" attribute', () => {
    const r = parseHints('<palaia-hint type="process" force="true" />');
    assert.equal(r.hints[0]?.force, true);
  });

  it('rejects unknown entry_type and visibility values', () => {
    const r = parseHints('<palaia-hint type="bogus" visibility="weird" />');
    assert.equal(r.hints[0]?.type, undefined);
    assert.equal(r.hints[0]?.visibility, undefined);
  });

  it('accepts shared:<project> visibility', () => {
    const r = parseHints('<palaia-hint visibility="shared:acme" />');
    assert.equal(r.hints[0]?.visibility, 'shared:acme');
  });

  it('extracts multiple hints in one string', () => {
    const r = parseHints(
      '<palaia-hint type="task" /> middle <palaia-hint visibility="public" />',
    );
    assert.equal(r.hints.length, 2);
    assert.equal(r.tagsStripped, 2);
  });
});

// ---------------------------------------------------------------------------
// CaptureFilter.classify — capture-level gates
// ---------------------------------------------------------------------------
describe('CaptureFilter.classify', () => {
  function buildScorer(impl: (text: string) => Promise<{
    score: number;
    suggestedEntryType?: 'memory' | 'process' | 'task';
  }>): { scorer: SignificanceScorer; calls: number } {
    let calls = 0;
    return {
      scorer: {
        async score(text: string) {
          calls += 1;
          return impl(text);
        },
      },
      get calls() {
        return calls;
      },
    };
  }

  it('level=off passes through ungestripped text and skips scorer', async () => {
    const scorer = buildScorer(async () => ({ score: 0.9 }));
    const filter = new CaptureFilter({
      captureLevel: 'off',
      defaultVisibility: 'team',
      significanceThreshold: 0.2,
      significanceScorer: scorer.scorer,
    });
    const decision = await filter.classify({
      userMessage: 'before <private>secret</private> after <palaia-hint type="task" />',
      assistantAnswer: 'ok',
    });
    assert.equal(decision.persist, true);
    assert.ok(
      decision.cleanUserMessage.includes('<private>'),
      'level=off must not strip',
    );
    assert.equal(scorer.calls, 0);
  });

  it('level=minimal strips privacy + hints, skips scorer, never drops', async () => {
    const scorer = buildScorer(async () => ({ score: 0.05 }));
    const filter = new CaptureFilter({
      captureLevel: 'minimal',
      defaultVisibility: 'team',
      significanceThreshold: 0.2,
      significanceScorer: scorer.scorer,
    });
    const decision = await filter.classify({
      userMessage: '<private>token</private> hello <palaia-hint type="task" visibility="private" />',
      assistantAnswer: '<private>x</private> response',
    });
    assert.equal(decision.persist, true);
    assert.equal(decision.significance, null);
    assert.equal(scorer.calls, 0);
    assert.ok(!decision.cleanUserMessage.includes('<private>'));
    assert.ok(!decision.cleanUserMessage.includes('palaia-hint'));
    assert.ok(!decision.cleanAssistantAnswer.includes('<private>'));
    // Hint overrides at minimal too — privacy/hint cleanup is orthogonal.
    assert.equal(decision.entryType, 'task');
    assert.equal(decision.visibility, 'private');
  });

  it('level=normal drops sub-threshold turns', async () => {
    const scorer = buildScorer(async () => ({ score: 0.1 }));
    const filter = new CaptureFilter({
      captureLevel: 'normal',
      defaultVisibility: 'team',
      significanceThreshold: 0.2,
      significanceScorer: scorer.scorer,
    });
    const decision = await filter.classify({
      userMessage: 'thx',
      assistantAnswer: 'np',
    });
    assert.equal(decision.persist, false);
    assert.equal(decision.shouldEmbed, false);
    assert.equal(scorer.calls, 1);
  });

  it('level=normal persists supra-threshold turns', async () => {
    const scorer = buildScorer(async () => ({
      score: 0.74,
      suggestedEntryType: 'process',
    }));
    const filter = new CaptureFilter({
      captureLevel: 'normal',
      defaultVisibility: 'team',
      significanceThreshold: 0.2,
      significanceScorer: scorer.scorer,
    });
    const decision = await filter.classify({
      userMessage: 'how do I run the daily etl',
      assistantAnswer: '1) … 2) … 3) …',
    });
    assert.equal(decision.persist, true);
    assert.equal(decision.entryType, 'process');
    assert.ok(
      decision.significance !== null && decision.significance > 0.7,
    );
  });

  it('force-hint skips the scorer even at level=normal', async () => {
    const scorer = buildScorer(async () => ({ score: 0.1 }));
    const filter = new CaptureFilter({
      captureLevel: 'normal',
      defaultVisibility: 'team',
      significanceThreshold: 0.2,
      significanceScorer: scorer.scorer,
    });
    const decision = await filter.classify({
      userMessage: '<palaia-hint type="process" force="true" />',
      assistantAnswer: '',
    });
    assert.equal(scorer.calls, 0);
    assert.equal(decision.persist, true);
    assert.equal(decision.entryType, 'process');
    assert.equal(decision.significance, null);
  });

  it('scorer error → persist with default classification + significance=null', async () => {
    const filter = new CaptureFilter({
      captureLevel: 'normal',
      defaultVisibility: 'team',
      significanceThreshold: 0.2,
      significanceScorer: {
        async score() {
          throw new Error('haiku unavailable');
        },
      },
      log: () => {},
    });
    const decision = await filter.classify({
      userMessage: 'something',
      assistantAnswer: 'something',
    });
    assert.equal(decision.persist, true);
    assert.equal(decision.significance, null);
    assert.equal(decision.entryType, 'memory');
  });
});

// ---------------------------------------------------------------------------
// CaptureFilteringKnowledgeGraph (decorator wiring)
// ---------------------------------------------------------------------------
describe('CaptureFilteringKnowledgeGraph', () => {
  it('forwards to inner with cleaned text + decision fields', async () => {
    const inner = new InMemoryKnowledgeGraph();
    const filter = new CaptureFilter({
      captureLevel: 'minimal',
      defaultVisibility: 'team',
      significanceThreshold: 0.2,
    });
    const wrapped = new CaptureFilteringKnowledgeGraph({
      inner,
      filter,
      log: () => {},
    });

    await wrapped.ingestTurn({
      scope: 'test-scope',
      time: '2026-05-08T08:00:00.000Z',
      userMessage:
        'before <private>secret</private> after <palaia-hint type="task" visibility="private" />',
      assistantAnswer: 'ok',
      entityRefs: [],
    });

    const session = await inner.getSession('test-scope');
    assert.ok(session, 'session should exist');
    const turnEntry = session.turns[0];
    assert.ok(turnEntry, 'turn should be persisted');
    const turn = turnEntry.turn;
    assert.ok(
      !(turn.props['userMessage'] as string).includes('<private>'),
      'persisted text must be stripped',
    );
    assert.ok(
      !(turn.props['userMessage'] as string).includes('palaia-hint'),
      'palaia-hint must be stripped',
    );
    // In-Memory mirror: hint propagated into palaia fields.
    assert.equal(turn.entryType, 'task');
    assert.equal(turn.visibility, 'private');
    assert.equal(turn.significance, null);
  });

  it('persist=false skips the inner write entirely', async () => {
    const inner = new InMemoryKnowledgeGraph();
    let innerCalls = 0;
    const proxiedInner = new Proxy(inner, {
      get(target, prop, recv) {
        if (prop === 'ingestTurn') {
          return async (...args: Parameters<typeof inner.ingestTurn>) => {
            innerCalls += 1;
            return target.ingestTurn(...args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const filter = new CaptureFilter({
      captureLevel: 'normal',
      defaultVisibility: 'team',
      significanceThreshold: 0.5,
      significanceScorer: {
        async score() {
          return { score: 0.1 };
        },
      },
    });
    const wrapped = new CaptureFilteringKnowledgeGraph({
      inner: proxiedInner,
      filter,
      log: () => {},
    });

    const result = await wrapped.ingestTurn({
      scope: 'drop-scope',
      time: '2026-05-08T08:00:00.000Z',
      userMessage: 'thx',
      assistantAnswer: 'np',
      entityRefs: [],
    });
    assert.equal(innerCalls, 0, 'inner.ingestTurn must NOT be called');
    assert.equal(result.sessionId, 'session:drop-scope');
    assert.ok(result.turnId.startsWith('turn:drop-scope'));
    assert.deepEqual(result.entityNodeIds, []);
  });
});
