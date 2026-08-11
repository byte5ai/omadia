import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  insertProvenanceChunk,
  crc32,
  buildItxtChunk,
  hasItxtKeyword,
  PROVENANCE_KEYWORD,
  PROVENANCE_TEXT,
} from '../packages/harness-diagrams/src/pngTextChunk.js';

// A REAL Kroki-rendered mermaid PNG, not a synthetic minimal PNG — the
// acceptance criterion requires validating against genuine encoder output.
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'diagram-kroki.png',
);
const KROKI_PNG = readFileSync(FIXTURE);

/** Parse a PNG into its ordered chunk list, recomputing each CRC. */
function parseChunks(buf: Buffer): Array<{
  type: string;
  data: Buffer;
  storedCrc: number;
  computedCrc: number;
  offset: number;
}> {
  const chunks = [];
  let offset = 8; // skip signature
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const data = buf.subarray(offset + 8, offset + 8 + len);
    const storedCrc = buf.readUInt32BE(offset + 8 + len);
    const computedCrc = crc32(buf.subarray(offset + 4, offset + 8 + len));
    chunks.push({ type, data, storedCrc, computedCrc, offset });
    offset += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** Extract keyword + text from the first iTXt chunk (uncompressed). */
function readItxt(buf: Buffer): { keyword: string; text: string } | null {
  for (const c of parseChunks(buf)) {
    if (c.type !== 'iTXt') continue;
    const nul1 = c.data.indexOf(0x00);
    const keyword = c.data.subarray(0, nul1).toString('latin1');
    // after keyword\0: compFlag, compMethod, langTag\0, translatedKeyword\0, text
    let p = nul1 + 1;
    p += 2; // comp flag + method
    const langEnd = c.data.indexOf(0x00, p);
    p = langEnd + 1;
    const transEnd = c.data.indexOf(0x00, p);
    p = transEnd + 1;
    const text = c.data.subarray(p).toString('utf8');
    return { keyword, text };
  }
  return null;
}

describe('pngTextChunk', () => {
  it('fixture is a real PNG with no pre-existing provenance chunk', () => {
    assert.equal(KROKI_PNG.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(hasItxtKeyword(KROKI_PNG, PROVENANCE_KEYWORD), false);
  });

  it('inserts an iTXt chunk carrying the provenance record', () => {
    const marked = insertProvenanceChunk(KROKI_PNG);
    const itxt = readItxt(marked);
    assert.ok(itxt, 'marked PNG must contain an iTXt chunk');
    // Read-back: assert values pulled OUT of the produced bytes.
    assert.equal(itxt.keyword, PROVENANCE_KEYWORD);
    assert.equal(itxt.text, PROVENANCE_TEXT);
    const record = JSON.parse(itxt.text) as { AIGenerated: boolean };
    assert.equal(record.AIGenerated, true);
  });

  it('every chunk (including the new iTXt) has a correct CRC', () => {
    const marked = insertProvenanceChunk(KROKI_PNG);
    for (const c of parseChunks(marked)) {
      assert.equal(
        c.computedCrc,
        c.storedCrc,
        `CRC mismatch on ${c.type} chunk`,
      );
    }
  });

  it('inserts the iTXt at a legal position: after IHDR/IDAT, before IEND', () => {
    const types = parseChunks(insertProvenanceChunk(KROKI_PNG)).map((c) => c.type);
    assert.equal(types[0], 'IHDR');
    assert.equal(types[types.length - 1], 'IEND');
    const itxtIdx = types.indexOf('iTXt');
    const iendIdx = types.indexOf('IEND');
    const lastIdatIdx = types.lastIndexOf('IDAT');
    assert.ok(itxtIdx > 0, 'iTXt must not precede IHDR');
    assert.ok(itxtIdx > lastIdatIdx, 'iTXt inserted after image data');
    assert.ok(itxtIdx < iendIdx, 'iTXt must precede IEND');
  });

  it('stays valid for a standard decoder (sharp decodes it)', async () => {
    const marked = insertProvenanceChunk(KROKI_PNG);
    const meta = await sharp(marked).metadata();
    assert.equal(meta.format, 'png');
    assert.ok((meta.width ?? 0) > 0 && (meta.height ?? 0) > 0);
    // Dimensions unchanged vs the original — we only appended metadata.
    const orig = await sharp(KROKI_PNG).metadata();
    assert.equal(meta.width, orig.width);
    assert.equal(meta.height, orig.height);
  });

  it('is deterministic: same input yields byte-identical output', () => {
    const a = insertProvenanceChunk(KROKI_PNG);
    const b = insertProvenanceChunk(KROKI_PNG);
    assert.deepEqual(a, b);
  });

  it('is idempotent: re-marking an already-marked PNG is a no-op', () => {
    const once = insertProvenanceChunk(KROKI_PNG);
    const twice = insertProvenanceChunk(once);
    assert.deepEqual(twice, once);
    const itxtCount = parseChunks(twice).filter((c) => c.type === 'iTXt').length;
    assert.equal(itxtCount, 1, 'must not stack duplicate provenance chunks');
  });

  it('returns non-PNG buffers unchanged (graceful degradation)', () => {
    const garbage = Buffer.alloc(64, 0);
    assert.deepEqual(insertProvenanceChunk(garbage), garbage);
  });

  it('buildItxtChunk frames length | type | data | crc correctly', () => {
    const chunk = buildItxtChunk('Provenance', 'x');
    const len = chunk.readUInt32BE(0);
    assert.equal(chunk.subarray(4, 8).toString('latin1'), 'iTXt');
    assert.equal(chunk.length, 12 + len);
    assert.equal(
      chunk.readUInt32BE(chunk.length - 4),
      crc32(chunk.subarray(4, chunk.length - 4)),
    );
  });
});
