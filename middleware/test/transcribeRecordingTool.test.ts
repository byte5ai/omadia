import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryMemoryStore } from '@omadia/memory';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  SessionLogger,
  TranscribeRecordingTool,
  turnContext,
  type AttachmentReader,
} from '@omadia/orchestrator';
import {
  TranscriptionQuotaExceededError,
  type Transcript,
  type TranscribeOpts,
  type TranscriptionService,
} from '@omadia/plugin-api';

/**
 * `transcribe_recording` (#584 WS I) — the artifact-convergence tool: a
 * recorded audio file must produce the SAME substrate a live chat session
 * does (markdown session transcript + KG turns), with speaker attribution
 * and the hint seam wired through.
 */

const AUDIO_KEY = 'uploads/2026/standup.wav';

function fakeReader(found: boolean): AttachmentReader {
  return {
    readByStorageKey: async (key: string) =>
      found && key === AUDIO_KEY
        ? {
            bytes: Buffer.from([1, 2, 3]),
            contentType: 'audio/wav',
            fileName: 'standup.wav',
          }
        : undefined,
    readByUrl: async () => undefined,
  };
}

function fakeTranscription(
  transcript: Transcript,
): TranscriptionService & { seenOpts: Array<TranscribeOpts | undefined> } {
  const seenOpts: Array<TranscribeOpts | undefined> = [];
  return {
    providerId: transcript.provider,
    seenOpts,
    async transcribeFile(_ref, opts) {
      seenOpts.push(opts);
      return transcript;
    },
    transcribeStream() {
      throw new Error('not under test');
    },
  };
}

const TWO_SPEAKERS: Transcript = {
  text: 'Guten Morgen. Fangen wir an.',
  segments: [
    { text: 'Guten Morgen.', startMs: 0, endMs: 1_000, speaker: 'Anna' },
    { text: 'Fangen wir an.', startMs: 1_000, endMs: 2_500, speaker: 'Ben' },
  ],
  language: 'de',
  durationMs: 2_500,
  provider: 'openai:gpt-transcribe',
};

function makeTool(opts: {
  service?: TranscriptionService;
  reader?: AttachmentReader;
}): {
  tool: TranscribeRecordingTool;
  store: InMemoryMemoryStore;
  graph: InMemoryKnowledgeGraph;
} {
  const store = new InMemoryMemoryStore();
  const graph = new InMemoryKnowledgeGraph();
  const tool = new TranscribeRecordingTool({
    reader: opts.reader ?? fakeReader(true),
    getTranscription: () => opts.service,
    makeSessionLogger: (agentSlug) =>
      new SessionLogger(store, graph, undefined, agentSlug),
  });
  return { tool, store, graph };
}

describe('transcribe_recording', () => {
  it('produces the live-session artifact shape: one KG turn per utterance, speaker-attributed, plus the markdown transcript', async () => {
    const service = fakeTranscription(TWO_SPEAKERS);
    const { tool, store, graph } = makeTool({ service });

    const result = await turnContext.run(
      {
        turnId: 't1',
        turnDate: '2026-08-21',
        sessionScope: 'meeting-42',
        agentSlug: 'facilitator',
        resolvedOmadiaUserId: 'user-uuid-1',
      },
      () => tool.handle({ storage_key: AUDIO_KEY }),
    );

    assert.ok(!result.startsWith('Error:'), result);
    assert.match(result, /openai:gpt-transcribe/);
    assert.match(result, /2 Einträge/);

    // KG side — agent-qualified scope, one Turn per utterance, speaker prop.
    const view = await graph.getSession('facilitator::meeting-42');
    assert.ok(view, 'expected the agent-qualified session in the graph');
    assert.equal(view.turns.length, 2);
    const speakers = view.turns
      .map((t) => (t.turn.props as { speaker?: string }).speaker)
      .sort();
    assert.deepEqual(speakers, ['Anna', 'Ben']);
    const userIds = view.turns.map(
      (t) => (t.turn.props as { userId?: string }).userId,
    );
    assert.deepEqual(userIds, ['user-uuid-1', 'user-uuid-1']);

    // Markdown side — shared conversation-scope path, speaker labels rendered.
    const files = (await store.list('/memories/sessions/meeting-42')).filter(
      (e) => !e.isDirectory,
    );
    assert.equal(files.length, 1);
    const md = await store.readFile(files[0]!.virtualPath);
    assert.match(md, /\*\*Anna:\*\*/);
    assert.match(md, /\*\*Ben:\*\*/);
    assert.match(md, /Guten Morgen\./);
  });

  it('threads the hint seam through to the provider (languages, keywords, context)', async () => {
    const service = fakeTranscription(TWO_SPEAKERS);
    const { tool } = makeTool({ service });
    await tool.handle({
      storage_key: AUDIO_KEY,
      language_hints: ['de'],
      keyword_hints: ['Anna', 'Facilitator'],
      context: 'Daily Standup des omadia-Teams',
    });
    assert.deepEqual(service.seenOpts[0], {
      languageHints: ['de'],
      keywordHints: ['Anna', 'Facilitator'],
      context: 'Daily Standup des omadia-Teams',
    });
  });

  it('degrades to a clear error string when no provider is installed', async () => {
    const { tool } = makeTool({ service: undefined });
    const result = await tool.handle({ storage_key: AUDIO_KEY });
    assert.match(result, /^Error: kein Transkriptions-Provider/);
  });

  it('reports an unknown attachment instead of throwing', async () => {
    const service = fakeTranscription(TWO_SPEAKERS);
    const { tool } = makeTool({ service, reader: fakeReader(false) });
    const result = await tool.handle({ storage_key: AUDIO_KEY });
    assert.match(result, /not found/);
  });

  it('surfaces quota exhaustion as the guardrail message', async () => {
    const service = fakeTranscription(TWO_SPEAKERS);
    service.transcribeFile = async () => {
      throw new TranscriptionQuotaExceededError('facilitator', 600, 601);
    };
    const { tool } = makeTool({ service });
    const result = await tool.handle({ storage_key: AUDIO_KEY });
    assert.match(result, /^Error: transcription minute quota exhausted/);
  });

  it('validates its input', async () => {
    const { tool } = makeTool({ service: fakeTranscription(TWO_SPEAKERS) });
    const result = await tool.handle({ nope: 1 });
    assert.match(result, /^Error: invalid transcribe_recording input/);
  });

  it('outside any turn context, transcripts land under a key-derived scope instead of vanishing', async () => {
    const service = fakeTranscription(TWO_SPEAKERS);
    const { tool, graph } = makeTool({ service });
    const result = await tool.handle({ storage_key: AUDIO_KEY });
    assert.ok(!result.startsWith('Error:'), result);
    const view = await graph.getSession('transcript-uploads-2026-standup-wav');
    assert.ok(view);
    assert.equal(view.turns.length, 2);
  });
});
