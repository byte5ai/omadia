import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { SessionLogEntry } from '@omadia/orchestrator';
import {
  TranscriptionError,
  type AudioFile,
  type TranscribeOptions,
  type Transcript,
  type TranscriptionService,
} from '@omadia/transcription-api';

import {
  handleTranscribeRecording,
  type TranscribeRecordingToolDeps,
} from '../src/transcribeRecordingTool.js';
import {
  recordingIdFor,
  transcriptArtifactKey,
  transcriptScope,
  type TranscriptArtifact,
} from '../src/transcriptArtifact.js';

const STORAGE_KEY =
  'transcription-uploads/2026-08-18T10:00:00.000Z-9f2a1c0be4d7a355.wav';

class FakeTranscriptionService implements TranscriptionService {
  calls: Array<{ audio: AudioFile; opts?: TranscribeOptions }> = [];
  constructor(private readonly result: Transcript) {}

  async transcribeFile(
    audio: AudioFile,
    opts?: TranscribeOptions,
  ): Promise<Transcript> {
    this.calls.push({ audio, ...(opts ? { opts } : {}) });
    return this.result;
  }

  // eslint-disable-next-line require-yield
  async *transcribeStream(): AsyncIterable<never> {
    throw new Error('not under test');
  }
}

class FakeArtifactStore {
  objects = new Map<string, { body: Buffer; contentType?: string }>();

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    this.objects.set(key, { body, ...(contentType ? { contentType } : {}) });
  }

  artifact(key: string): TranscriptArtifact {
    const stored = this.objects.get(key);
    assert.ok(stored, `artifact ${key} not written`);
    return JSON.parse(stored.body.toString('utf8')) as TranscriptArtifact;
  }
}

class FakeLogger {
  entries: SessionLogEntry[] = [];

  async log(entry: SessionLogEntry): Promise<{ turnExternalId: string }> {
    this.entries.push(entry);
    return { turnExternalId: `turn:${entry.scope}:${String(this.entries.length)}` };
  }
}

function makeDeps(overrides?: Partial<TranscribeRecordingToolDeps>): {
  deps: TranscribeRecordingToolDeps;
  service: FakeTranscriptionService;
  store: FakeArtifactStore;
  logger: FakeLogger;
} {
  const service = new FakeTranscriptionService({
    segments: [
      { id: 'seg-0', text: 'Hallo zusammen, willkommen zum Meeting.' },
      { id: 'seg-1', text: 'Danke, legen wir los.' },
    ],
    timing: 'none',
    detectedLanguages: ['de'],
    usage: { attempts: 1 },
  });
  const store = new FakeArtifactStore();
  const logger = new FakeLogger();
  const deps: TranscribeRecordingToolDeps = {
    getTranscription: () => service,
    getArtifactStore: () => store,
    getRecordingReader: () => ({
      readByStorageKey: async (key: string) =>
        key === STORAGE_KEY
          ? {
              bytes: Buffer.from('fake-audio'),
              contentType: 'audio/wav',
              fileName: 'meeting.wav',
            }
          : undefined,
    }),
    getSessionLogger: () => logger,
    currentUploader: () => ({ userId: 'aad-123', omadiaUserId: 'uuid-456' }),
    ...overrides,
  };
  return { deps, service, store, logger };
}

describe('handleTranscribeRecording', () => {
  it('writes the unmasked artifact with metadata and default speaker labels', async () => {
    const { deps, service, store } = makeDeps();
    const result = await handleTranscribeRecording(
      { storage_key: STORAGE_KEY, recording_start: '2026-08-17T14:30:00Z' },
      deps,
    );

    assert.match(result, /Aufnahme transkribiert/);
    assert.equal(service.calls.length, 1);
    assert.equal(service.calls[0]?.audio.filename, 'meeting.wav');
    assert.equal(service.calls[0]?.audio.mimeType, 'audio/wav');

    const recordingId = recordingIdFor(STORAGE_KEY);
    const artifact = store.artifact(transcriptArtifactKey(recordingId));
    assert.equal(artifact.version, 1);
    assert.equal(artifact.recordingId, recordingId);
    assert.equal(artifact.storageKey, STORAGE_KEY);
    assert.equal(artifact.recordingStart, '2026-08-17T14:30:00.000Z');
    assert.deepEqual(artifact.uploader, {
      userId: 'aad-123',
      omadiaUserId: 'uuid-456',
    });
    assert.equal(artifact.timing, 'none');
    assert.deepEqual(artifact.detectedLanguages, ['de']);
    assert.deepEqual(
      artifact.segments.map((s) => s.speaker),
      ['speaker_0', 'speaker_0'],
    );
    assert.equal(
      artifact.segments[0]?.text,
      'Hallo zusammen, willkommen zum Meeting.',
    );
  });

  it('keeps a provider-attributed speaker and defaults only unattributed segments', async () => {
    const { deps, store } = makeDeps();
    const service = new FakeTranscriptionService({
      segments: [
        { id: 'seg-0', text: 'Erster Punkt.', speaker: 'diarized-A' },
        { id: 'seg-1', text: 'Zweiter Punkt.' },
      ],
      timing: 'provider',
      usage: { attempts: 1 },
    });
    deps.getTranscription = () => service;

    await handleTranscribeRecording({ storage_key: STORAGE_KEY }, deps);
    const artifact = store.artifact(
      transcriptArtifactKey(recordingIdFor(STORAGE_KEY)),
    );
    assert.deepEqual(
      artifact.segments.map((s) => s.speaker),
      ['diarized-A', 'speaker_0'],
    );
  });

  it('logs one masked chunk turn per chunk: scope, time offsets, empty answer, no userId', async () => {
    const { deps, logger } = makeDeps();
    await handleTranscribeRecording(
      { storage_key: STORAGE_KEY, recording_start: '2026-08-17T14:30:00Z' },
      deps,
    );

    const recordingId = recordingIdFor(STORAGE_KEY);
    assert.equal(logger.entries.length, 1);
    const entry = logger.entries[0]!;
    assert.equal(entry.scope, transcriptScope(recordingId));
    assert.equal(
      entry.userMessage,
      '[speaker_0]: Hallo zusammen, willkommen zum Meeting.\n[speaker_0]: Danke, legen wir los.',
    );
    assert.equal(entry.assistantAnswer, '');
    assert.equal(entry.userId, undefined);
    assert.equal(entry.losslessUserMessage, true);
    // timing 'none' → chunk index offsets: first chunk at recordingStart + 0ms.
    assert.equal(
      entry.time?.toISOString(),
      '2026-08-17T14:30:00.000Z',
    );
  });

  it('spreads multi-chunk projections across recordingStart + offset', async () => {
    const { deps, logger } = makeDeps();
    const longText = Array.from(
      { length: 40 },
      (_, i) => `Der ausführliche Protokollsatz Nummer ${String(i)} hat Substanz.`,
    ).join(' ');
    deps.getTranscription = () =>
      new FakeTranscriptionService({
        segments: [{ id: 'seg-0', text: longText }],
        timing: 'none',
        usage: { attempts: 1 },
      });

    await handleTranscribeRecording(
      { storage_key: STORAGE_KEY, recording_start: '2026-08-17T14:30:00Z' },
      deps,
    );
    assert.ok(logger.entries.length > 1);
    const times = logger.entries.map((e) => e.time?.getTime());
    const base = Date.parse('2026-08-17T14:30:00Z');
    times.forEach((t, i) => {
      assert.equal(t, base + i);
    });
  });

  it('masks PII before logging while the artifact stays unmasked', async () => {
    const { deps, store, logger } = makeDeps();
    const pii = 'Meldet euch bei max.mustermann@example.com für Details.';
    deps.getTranscription = () =>
      new FakeTranscriptionService({
        segments: [{ id: 'seg-0', text: pii }],
        timing: 'none',
        usage: { attempts: 1 },
      });

    await handleTranscribeRecording({ storage_key: STORAGE_KEY }, deps);

    const artifact = store.artifact(
      transcriptArtifactKey(recordingIdFor(STORAGE_KEY)),
    );
    assert.ok(artifact.segments[0]?.text.includes('max.mustermann@example.com'));
    assert.equal(logger.entries.length, 1);
    assert.ok(
      !logger.entries[0]!.userMessage.includes('max.mustermann@example.com'),
      'logged chunk must not carry the raw email',
    );
  });

  it('reports a mid-projection log failure honestly instead of claiming success', async () => {
    const { deps, store } = makeDeps();
    const longText = Array.from(
      { length: 40 },
      (_, i) => `Der ausführliche Protokollsatz Nummer ${String(i)} hat Substanz.`,
    ).join(' ');
    deps.getTranscription = () =>
      new FakeTranscriptionService({
        segments: [{ id: 'seg-0', text: longText }],
        timing: 'none',
        usage: { attempts: 1 },
      });
    let calls = 0;
    deps.getSessionLogger = () => ({
      log: async () => {
        calls += 1;
        if (calls > 1) throw new Error('graph down');
        return { turnExternalId: 'turn:x:1' };
      },
    });

    const result = await handleTranscribeRecording(
      { storage_key: STORAGE_KEY },
      deps,
    );
    assert.match(result, /Fehler: Transcript-Artifact wurde geschrieben/);
    assert.match(result, /nach 1 von \d+ Chunks/);
    // The artifact (canonical truth) is durable despite the projection break.
    assert.ok(store.objects.has(transcriptArtifactKey(recordingIdFor(STORAGE_KEY))));
  });

  it('is idempotent: an existing artifact short-circuits without transcribing or logging', async () => {
    const { deps, service, store, logger } = makeDeps();
    const key = transcriptArtifactKey(recordingIdFor(STORAGE_KEY));
    await store.put(key, Buffer.from('{}'), 'application/json');

    const result = await handleTranscribeRecording(
      { storage_key: STORAGE_KEY },
      deps,
    );
    assert.match(result, /bereits ingestiert/);
    assert.equal(service.calls.length, 0);
    assert.equal(logger.entries.length, 0);
    assert.equal(store.artifact(key) instanceof Object, true);
  });

  it('defaults recording_start to the upload time embedded in the storage key', async () => {
    const { deps, store } = makeDeps();
    await handleTranscribeRecording({ storage_key: STORAGE_KEY }, deps);
    const artifact = store.artifact(
      transcriptArtifactKey(recordingIdFor(STORAGE_KEY)),
    );
    assert.equal(artifact.recordingStart, '2026-08-18T10:00:00.000Z');
  });

  it('maps TranscriptionError onto a code-bearing message without side effects', async () => {
    const { deps, store, logger } = makeDeps();
    deps.getTranscription = () => ({
      transcribeFile: async () => {
        throw new TranscriptionError('auth', 'invalid api key');
      },
      transcribeStream: () => {
        throw new Error('unused');
      },
    });

    const result = await handleTranscribeRecording(
      { storage_key: STORAGE_KEY },
      deps,
    );
    assert.match(result, /Fehler bei der Transkription \(auth\): invalid api key/);
    assert.equal(store.objects.size, 0);
    assert.equal(logger.entries.length, 0);
  });

  it('degrades with clear errors when a dependency is missing or the key is unknown', async () => {
    const missingProvider = makeDeps({ getTranscription: () => undefined });
    assert.match(
      await handleTranscribeRecording({ storage_key: STORAGE_KEY }, missingProvider.deps),
      /Kein Transcription-Provider aktiv/,
    );

    const missingStore = makeDeps({ getArtifactStore: () => undefined });
    assert.match(
      await handleTranscribeRecording({ storage_key: STORAGE_KEY }, missingStore.deps),
      /Blob-Store/,
    );

    const missingLogger = makeDeps({ getSessionLogger: () => undefined });
    assert.match(
      await handleTranscribeRecording({ storage_key: STORAGE_KEY }, missingLogger.deps),
      /Session-Logger/,
    );
    assert.equal(missingLogger.store.objects.size, 0);

    const unknownKey = makeDeps();
    assert.match(
      await handleTranscribeRecording(
        { storage_key: 'transcription-uploads/nope.wav' },
        unknownKey.deps,
      ),
      /nicht gefunden/,
    );
    assert.equal(unknownKey.store.objects.size, 0);
  });

  it('rejects malformed input', async () => {
    const { deps } = makeDeps();
    assert.match(await handleTranscribeRecording(undefined, deps), /Fehler/);
    assert.match(await handleTranscribeRecording({}, deps), /storage_key/);
    assert.match(
      await handleTranscribeRecording(
        { storage_key: STORAGE_KEY, recording_start: 'gestern' },
        deps,
      ),
      /recording_start/,
    );
  });
});
