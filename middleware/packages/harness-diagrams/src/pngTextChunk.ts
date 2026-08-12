/**
 * Minimal, deterministic PNG iTXt-chunk writer.
 *
 * Diagrams are the only images omadia produces (Kroki renders PNG from
 * LLM-authored source). PNG's iTXt chunk is the standardised slot for
 * machine-readable text; we use it to mark rendered diagrams as
 * AI-generated (AI Act Art. 50, epic #642 / #646).
 *
 * A tiny writer beats a dependency here: a PNG chunk is
 * `Length(4) | Type(4) | Data | CRC32(4)`, and the whole thing is ~60 lines
 * and fully testable. No wall-clock, no randomness — the chunk content is a
 * static constant, so the same Kroki output always yields byte-identical
 * marked bytes. That matters because the object store is content-addressed by
 * `kind + source`, not by bytes: a re-render must not place a different object
 * under the same key.
 */

/** 8-byte PNG signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Provenance record embedded in every rendered diagram. Machine-readable and
 * deliberately static — no per-render fields (model/provider provenance is a
 * separate follow-up, epic #650), so byte-determinism holds.
 *
 * Vocabulary is kept identical to the Office sibling (`@omadia/plugin-office`
 * `provenance.ts`, #645): field names `AIGenerated` / `Generator` /
 * `ProvenanceStandard` and the values `"Omadia"` / `"EU AI Act Art. 50"` match
 * its custom properties, so one consumer parses provenance uniformly across
 * every artifact the epic marks. `AIGenerated` is a real JSON boolean here
 * (the Office copy uses the string `"true"` only because OOXML custom
 * properties are string-typed).
 */
export const PROVENANCE_KEYWORD = 'Provenance';
export const PROVENANCE_TEXT =
  '{"AIGenerated":true,"Generator":"Omadia","ProvenanceStandard":"EU AI Act Art. 50"}';

// --- CRC32 (ISO 3309 / PNG) ------------------------------------------------

/** Precomputed CRC table (polynomial 0xEDB88320), built once at module load. */
const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 over `bytes`, as the PNG spec defines it (init/xor 0xFFFFFFFF). */
export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Chunk construction ----------------------------------------------------

/**
 * Build a complete, uncompressed iTXt chunk.
 *
 * iTXt data layout (PNG spec 11.3.4.5):
 *   keyword \0 compFlag(0) compMethod(0) langTag \0 translatedKeyword \0 text
 *
 * We keep language tag and translated keyword empty and store the text
 * uncompressed — the payload is tiny, and uncompressed keeps the bytes
 * decoder-trivial and deterministic.
 */
export function buildItxtChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'), // keyword (Latin-1, 1-79 bytes)
    Buffer.from([0x00]), // null separator
    Buffer.from([0x00]), // compression flag: 0 = uncompressed
    Buffer.from([0x00]), // compression method: 0
    Buffer.from([0x00]), // language tag: empty + null
    Buffer.from([0x00]), // translated keyword: empty + null
    Buffer.from(text, 'utf8'), // text (UTF-8)
  ]);

  const type = Buffer.from('iTXt', 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);

  return Buffer.concat([length, type, data, crc]);
}

// --- Insertion -------------------------------------------------------------

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * Offset of the IEND chunk's length field, or -1 if not found. Walks the
 * chunk list rather than assuming IEND is last — it always is in valid PNGs,
 * but walking is cheap and avoids a trailing-garbage foot-gun.
 */
function iendOffset(buf: Buffer): number {
  let offset = 8; // skip signature
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'IEND') return offset;
    offset += 12 + len; // length(4) + type(4) + data(len) + crc(4)
  }
  return -1;
}

/** True if the PNG already carries an iTXt chunk with the given keyword. */
export function hasItxtKeyword(buf: Buffer, keyword: string): boolean {
  const keywordBytes = Buffer.from(keyword, 'latin1');
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    if (type === 'iTXt') {
      const data = buf.subarray(dataStart, dataStart + len);
      const nul = data.indexOf(0x00);
      if (nul === keywordBytes.length && data.subarray(0, nul).equals(keywordBytes)) {
        return true;
      }
    }
    if (type === 'IEND') break;
    offset += 12 + len;
  }
  return false;
}

/**
 * Return `png` with a provenance iTXt chunk inserted immediately before IEND
 * (a legal position for an ancillary text chunk). The result is deterministic:
 * same input bytes → same output bytes.
 *
 * Degrades gracefully — mirrors the brand-asset fallback in `diagramService`:
 * if the buffer is not a PNG or has no IEND, it is returned unchanged (and
 * logged) rather than throwing, so a Kroki contract violation never blocks the
 * render. Idempotent: if the provenance chunk is already present, no-op.
 */
export function insertProvenanceChunk(
  png: Buffer,
  log?: (message: string) => void,
): Buffer {
  if (!isPng(png)) {
    log?.('[diagrams] provenance: not a PNG, leaving bytes unchanged');
    return png;
  }
  if (hasItxtKeyword(png, PROVENANCE_KEYWORD)) {
    return png;
  }
  const iend = iendOffset(png);
  if (iend < 0) {
    log?.('[diagrams] provenance: no IEND chunk, leaving bytes unchanged');
    return png;
  }
  const chunk = buildItxtChunk(PROVENANCE_KEYWORD, PROVENANCE_TEXT);
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)]);
}
