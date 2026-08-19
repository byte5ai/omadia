/**
 * #584 — the REAL header probe (`music-metadata`) against tiny
 * generated fixture audio, plus the Billed-Minutes derivation.
 *
 * The fixtures are generated, not committed: header-validity is what matters,
 * not content (spec, Testing Decisions). Three valid containers (wav, mp3,
 * ogg/opus) and one corrupt buffer pin the fail-closed contract: a valid
 * header yields a finite positive duration, anything unprobeable yields
 * `undefined` — which the tool treats as a rejection.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  deriveBilledMinutes,
  formatMinutes,
  probeSourceMinutes,
} from '../src/metering.js';

/** PCM16 mono 8 kHz WAV of `seconds` silence — 44-byte RIFF header + data. */
function wavFixture(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const dataLen = samples * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

/** MPEG-1 Layer III 128 kbps 44.1 kHz frames (417 bytes each, zero payload).
 *  Each frame is 1152 samples ≈ 26.12 ms. */
function mp3Fixture(frames: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < frames; i++) {
    const f = Buffer.alloc(417);
    f[0] = 0xff;
    f[1] = 0xfb;
    f[2] = 0x90;
    f[3] = 0x44;
    parts.push(f);
  }
  return Buffer.concat(parts);
}

/** Ogg CRC-32 (poly 0x04c11db7, no reflection, init/xorout 0). */
function oggCrc(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let r = n << 24;
    for (let i = 0; i < 8; i++) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) : r << 1;
    }
    table[n] = r >>> 0;
  }
  let c = 0;
  for (const b of buf) c = ((c << 8) >>> 0) ^ table[((c >>> 24) ^ b) & 0xff]!;
  return c >>> 0;
}

function oggPage(
  serial: number,
  seq: number,
  granule: number,
  headerType: number,
  segments: Buffer[],
): Buffer {
  const segTable = Buffer.from(segments.map((s) => s.length));
  const body = Buffer.concat(segments);
  const h = Buffer.alloc(27);
  h.write('OggS', 0);
  h[4] = 0;
  h[5] = headerType;
  h.writeBigUInt64LE(BigInt(granule), 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(seq, 18);
  h.writeUInt32LE(0, 22); // CRC placeholder
  h[26] = segments.length;
  const page = Buffer.concat([h, segTable, body]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/** Ogg/Opus: OpusHead (pre-skip 312) + OpusTags + one audio page whose
 *  granule position encodes `seconds` at 48 kHz. */
function oggOpusFixture(seconds: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0);
  head[8] = 1; // version
  head[9] = 1; // channels
  head.writeUInt16LE(312, 10); // pre-skip
  head.writeUInt32LE(48_000, 12);
  head.writeUInt16LE(0, 16);
  head[18] = 0;
  const tags = Buffer.concat([
    Buffer.from('OpusTags'),
    Buffer.from([4, 0, 0, 0]),
    Buffer.from('test'),
    Buffer.from([0, 0, 0, 0]),
  ]);
  const granule = Math.round(seconds * 48_000);
  const audio = Buffer.from([0x08, 0xff, 0xfe]);
  return Buffer.concat([
    oggPage(1, 0, 0, 2, [head]),
    oggPage(1, 1, 0, 0, [tags]),
    oggPage(1, 2, granule, 4, [audio]),
  ]);
}

describe('#584 — header probe (real music-metadata, fixture audio)', () => {
  it('probes a WAV duration exactly', async () => {
    const minutes = await probeSourceMinutes(wavFixture(3));
    assert.ok(minutes !== undefined);
    assert.ok(Math.abs(minutes - 3 / 60) < 1e-9, `got ${String(minutes)}`);
  });

  it('probes an MP3 duration from its frames', async () => {
    // 80 frames × 1152 samples / 44100 Hz ≈ 2.09 s.
    const minutes = await probeSourceMinutes(mp3Fixture(80));
    assert.ok(minutes !== undefined);
    const seconds = minutes * 60;
    assert.ok(seconds > 1.9 && seconds < 2.3, `got ${String(seconds)}s`);
  });

  it('probes an Ogg/Opus duration from the final granule position', async () => {
    const minutes = await probeSourceMinutes(oggOpusFixture(3));
    assert.ok(minutes !== undefined);
    const seconds = minutes * 60;
    // granule minus 312-sample pre-skip → just under 3 s.
    assert.ok(seconds > 2.9 && seconds <= 3, `got ${String(seconds)}s`);
  });

  it('fails CLOSED on a corrupt header: undefined, never a throw', async () => {
    const corrupt = Buffer.from('definitely-not-audio-bytes-here-at-all!!');
    assert.equal(await probeSourceMinutes(corrupt), undefined);
    assert.equal(await probeSourceMinutes(Buffer.alloc(0)), undefined);
    // A recognised container with an unusable duration is also a rejection.
    const truncatedWav = wavFixture(2).subarray(0, 20);
    assert.equal(await probeSourceMinutes(truncatedWav), undefined);
  });
});

describe('#584 — Billed-Minutes derivation (capability layer, shape fixed now)', () => {
  it('batch: source × attempts — every retry books in full', () => {
    assert.equal(deriveBilledMinutes({ attempts: 1 }, 10), 10);
    assert.equal(deriveBilledMinutes({ attempts: 3 }, 10), 30);
    assert.equal(deriveBilledMinutes({ attempts: 0 }, 10), 0);
  });

  it('realtime: sum of measured per-attempt stream durations, source plays no role', () => {
    assert.equal(
      deriveBilledMinutes(
        { attempts: 2, attemptDurationsMs: [90_000, 30_000] },
        999,
      ),
      2,
    );
    // Present-but-empty durations: a stream that never carried audio bills 0.
    assert.equal(
      deriveBilledMinutes({ attempts: 1, attemptDurationsMs: [] }, 999),
      0,
    );
    // Defensive: a negative measurement can only shrink to 0, never credit.
    assert.equal(
      deriveBilledMinutes({ attempts: 1, attemptDurationsMs: [-5_000, 60_000] }, 999),
      1,
    );
  });
});

describe('#584 — formatMinutes (human-facing messages)', () => {
  it('renders at most two decimals without trailing noise', () => {
    assert.equal(formatMinutes(2), '2');
    assert.equal(formatMinutes(1 / 3), '0.33');
    assert.equal(formatMinutes(61.239), '61.24');
    assert.equal(formatMinutes(0), '0');
  });
});
