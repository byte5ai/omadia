/**
 * #584 slice ⑤ — zero-change replay guarantee of the transcript chunk
 * projection (ticket-02 decision): chunks logged through the REAL
 * `SessionLogger` must survive the existing markdown → parser → graph
 * backfill machinery unchanged. This is the acceptance seam that justifies
 * "one chunk = one turn via the shared log() path" — no new entryType, no
 * TurnIngest extension, no parser change.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryMemoryStore } from '@omadia/memory';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { SessionLogger, type SessionLogEntry } from '@omadia/orchestrator';
import { backfillGraph, parseSessionTranscript } from '@omadia/orchestrator-extras';
import {
  handleTranscribeRecording,
  recordingIdFor,
  transcriptScope,
  type TranscribeRecordingToolDeps,
  type TranscriptTurnLogger,
} from '@omadia/plugin-transcription';
import type { Transcript } from '@omadia/transcription-api';

const STORAGE_KEY =
  'transcription-uploads/2026-08-18T10:00:00.000Z-1234567890abcdef.wav';
const RECORDING_START = '2026-08-17T14:30:00Z';

/** A monologue long enough that its single chunk exceeds the logger's
 *  1500-char chat display cap — the lossless flag is what keeps the markdown
 *  a faithful replay source. */
const MONOLOGUE = Array.from(
  { length: 30 },
  (_, i) =>
    `Der ausführliche Protokollsatz Nummer ${String(i)} beschreibt die Beschlusslage im Detail.`,
).join(' ');

function makeDeps(args: {
  logger: TranscriptTurnLogger;
  transcript: Transcript;
}): TranscribeRecordingToolDeps {
  const objects = new Map<string, Buffer>();
  return {
    getTranscription: () => ({
      transcribeFile: async () => args.transcript,
      transcribeStream: () => {
        throw new Error('unused');
      },
    }),
    getArtifactStore: () => ({
      exists: async (key: string) => objects.has(key),
      put: async (key: string, body: Buffer) => {
        objects.set(key, body);
      },
    }),
    getRecordingReader: () => ({
      readByStorageKey: async () => ({
        bytes: Buffer.from('fake-audio'),
        contentType: 'audio/wav',
        fileName: 'meeting.wav',
      }),
    }),
    getSessionLogger: () => args.logger,
    currentUploader: () => undefined,
  };
}

describe('transcript projection replay (parser + backfill, zero changes)', () => {
  it('round-trips logged chunk turns bit-identically and rebuilds an identical graph', async () => {
    const store = new InMemoryMemoryStore();
    const liveGraph = new InMemoryKnowledgeGraph();
    const inner = new SessionLogger(store, liveGraph);
    const logged: SessionLogEntry[] = [];
    const spying: TranscriptTurnLogger = {
      log: async (entry: SessionLogEntry) => {
        logged.push(entry);
        return inner.log(entry);
      },
    };

    const result = await handleTranscribeRecording(
      { storage_key: STORAGE_KEY, recording_start: RECORDING_START },
      makeDeps({
        logger: spying,
        transcript: {
          segments: [
            { id: 'seg-0', text: MONOLOGUE },
            {
              id: 'seg-1',
              text: 'Kurze Rückfrage: Kontakt bitte an max.mustermann@example.com.',
            },
          ],
          timing: 'none',
          usage: { attempts: 1 },
        },
      }),
    );
    assert.match(result, /Aufnahme transkribiert/);
    assert.ok(logged.length >= 2, 'monologue + follow-up must span >1 chunk');
    const oversized = logged.filter((e) => e.userMessage.length > 1500);
    assert.ok(oversized.length >= 1, 'at least one chunk exceeds the chat display cap');

    const recordingId = recordingIdFor(STORAGE_KEY);
    const scope = transcriptScope(recordingId);
    const day = '2026-08-17';
    const markdown = await store.readFile(`/memories/sessions/${scope}/${day}.md`);

    // Privacy: the raw email never reaches markdown (masked pre-log).
    assert.ok(!markdown.includes('max.mustermann@example.com'));

    // Parser round-trip: every chunk turn comes back byte-identical, at
    // recordingStart + offset, with the empty assistant answer intact.
    const parsed = parseSessionTranscript(day, markdown);
    assert.equal(parsed.length, logged.length);
    parsed.forEach((turn, i) => {
      const entry = logged[i]!;
      assert.equal(turn.userMessage, entry.userMessage);
      assert.equal(turn.assistantAnswer, '');
      assert.equal(turn.time, entry.time!.toISOString());
      assert.equal(
        new Date(turn.time).getTime(),
        Date.parse(RECORDING_START) + i,
      );
    });

    // Backfill round-trip: a fresh graph rebuilt from the markdown matches
    // the live-ingested one on every node/edge count.
    const restored = new InMemoryKnowledgeGraph();
    const backfill = await backfillGraph(store, restored);
    assert.equal(backfill.scopes, 1);
    assert.equal(backfill.turns, logged.length);
    assert.deepEqual(backfill.skippedFiles, []);
    const liveStats = await liveGraph.stats();
    const restoredStats = await restored.stats();
    assert.deepEqual(restoredStats.byNodeType, liveStats.byNodeType);
    assert.deepEqual(restoredStats.byEdgeType, liveStats.byEdgeType);

    const view = await restored.getSession(scope);
    assert.ok(view);
    assert.equal(view.turns.length, logged.length);
  });
});
