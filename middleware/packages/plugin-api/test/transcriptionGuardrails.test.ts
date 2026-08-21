import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  TranscriptionQuotaExceededError,
  withTranscriptionGuardrails,
} from '../src/index.js';
import type {
  TranscribeOpts,
  Transcript,
  TranscriptDelta,
  TranscriptionService,
} from '../src/index.js';

/** A provider that records the opts it saw and answers with a fixed-duration
 *  transcript / a scripted delta stream. */
function fakeProvider(opts: {
  durationMs?: number;
  streamDeltas?: number;
}): TranscriptionService & { seenOpts: Array<TranscribeOpts | undefined> } {
  const seenOpts: Array<TranscribeOpts | undefined> = [];
  return {
    providerId: 'fake:stt',
    seenOpts,
    async transcribeFile(_ref, o): Promise<Transcript> {
      seenOpts.push(o);
      return {
        text: 'hallo',
        segments: [{ text: 'hallo' }],
        ...(opts.durationMs !== undefined
          ? { durationMs: opts.durationMs }
          : {}),
        provider: 'fake:stt',
      };
    },
    transcribeStream(_audio, o): AsyncIterable<TranscriptDelta> {
      seenOpts.push(o);
      const n = opts.streamDeltas ?? 3;
      return (async function* (): AsyncGenerator<TranscriptDelta> {
        for (let i = 0; i < n; i++) {
          yield { kind: 'partial', itemId: 'item_1', text: `d${String(i)}` };
        }
      })();
    },
  };
}

async function* emptyAudio(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([0]);
}

describe('withTranscriptionGuardrails', () => {
  it('meters batch minutes per agent from the reported duration', async () => {
    const metered: Array<[string, number, string]> = [];
    const service = withTranscriptionGuardrails(
      fakeProvider({ durationMs: 120_000 }),
      {
        resolveAgentKey: () => 'agent-a',
        onMinutesMetered: (k, m, p) => {
          metered.push([k, m, p]);
        },
      },
    );
    await service.transcribeFile({ bytes: new Uint8Array() });
    assert.deepEqual(metered, [['agent-a', 2, 'fake:stt']]);
  });

  it('falls back to the last segment end offset, and never invents spend for unknown durations', async () => {
    const metered: number[] = [];
    const inner = fakeProvider({});
    inner.transcribeFile = async () => ({
      text: 'x',
      segments: [{ text: 'x', startMs: 0, endMs: 30_000 }],
      provider: 'fake:stt',
    });
    const service = withTranscriptionGuardrails(inner, {
      onMinutesMetered: (_k, m) => {
        metered.push(m);
      },
    });
    await service.transcribeFile({ bytes: new Uint8Array() });
    assert.deepEqual(metered, [0.5]);

    const unknown = fakeProvider({}); // no durationMs, no offsets
    const meteredUnknown: number[] = [];
    const s2 = withTranscriptionGuardrails(unknown, {
      onMinutesMetered: (_k, m) => {
        meteredUnknown.push(m);
      },
    });
    await s2.transcribeFile({ bytes: new Uint8Array() });
    assert.deepEqual(meteredUnknown, []); // 0 minutes → no metering event
  });

  it('throws TranscriptionQuotaExceededError once the per-agent tally reaches the quota', async () => {
    const service = withTranscriptionGuardrails(
      fakeProvider({ durationMs: 60_000 * 5 }),
      { agentQuotaMinutes: 8, resolveAgentKey: () => 'agent-b' },
    );
    await service.transcribeFile({ bytes: new Uint8Array() }); // 5 of 8 used
    await service.transcribeFile({ bytes: new Uint8Array() }); // 10 of 8 used
    await assert.rejects(
      service.transcribeFile({ bytes: new Uint8Array() }),
      TranscriptionQuotaExceededError,
    );
  });

  it('quota tallies are per agent key, not global', async () => {
    let agent = 'agent-1';
    const service = withTranscriptionGuardrails(
      fakeProvider({ durationMs: 60_000 * 10 }),
      { agentQuotaMinutes: 5, resolveAgentKey: () => agent },
    );
    await service.transcribeFile({ bytes: new Uint8Array() });
    await assert.rejects(
      service.transcribeFile({ bytes: new Uint8Array() }),
      TranscriptionQuotaExceededError,
    );
    agent = 'agent-2';
    await service.transcribeFile({ bytes: new Uint8Array() }); // fresh tally
  });

  it('tightens (never widens) the caller-supplied per-call cap', async () => {
    const inner = fakeProvider({ durationMs: 1 });
    const service = withTranscriptionGuardrails(inner, { maxCallMinutes: 2 });
    await service.transcribeFile(
      { bytes: new Uint8Array() },
      { maxDurationMs: 60_000 },
    );
    await service.transcribeFile(
      { bytes: new Uint8Array() },
      { maxDurationMs: 600_000 },
    );
    assert.equal(inner.seenOpts[0]?.maxDurationMs, 60_000); // caller tighter
    assert.equal(inner.seenOpts[1]?.maxDurationMs, 120_000); // cap tighter
  });

  it('stream: captures attribution before the first yield and cuts off at the wall-clock cap', async () => {
    let clock = 0;
    let agent = 'stream-agent';
    const deltas: TranscriptDelta[] = [];
    const metered: Array<[string, number]> = [];
    const service = withTranscriptionGuardrails(fakeProvider({ streamDeltas: 10 }), {
      maxCallMinutes: 1,
      resolveAgentKey: () => agent,
      onMinutesMetered: (k, m) => {
        metered.push([k, m]);
      },
      now: () => clock,
    });
    const stream = service.transcribeStream(emptyAudio());
    // Attribution was resolved synchronously at the call above; a later agent
    // switch must not re-attribute the running stream.
    agent = 'someone-else';
    for await (const d of stream) {
      deltas.push(d);
      clock += 20_000; // 20s per delta → cap (60s) hit after the 3rd
    }
    assert.equal(deltas.length, 4); // 0s, 20s, 40s, 60s — 80s exceeds the cap
    assert.equal(metered.length, 1);
    assert.equal(metered[0]?.[0], 'stream-agent');
    assert.ok((metered[0]?.[1] ?? 0) <= 1); // never bills past the cap
  });
});
