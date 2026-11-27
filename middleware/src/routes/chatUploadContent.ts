/**
 * Upload content check for web chat uploads (ADR-0333): the stored bytes must
 * look like the file type the extension claims. The extension still decides
 * the content type the kernel states (ADR-0310); this check only refuses a
 * file whose first bytes contradict it, such as an executable renamed to
 * `.pdf` or an HTML page renamed to `.png`.
 *
 * Signatures only, no parsing: the readers behind the turn (ingest, vision,
 * transcription) validate the full format themselves.
 */

/** Bytes of a text file inspected for a NUL byte. */
const TEXT_SNIFF_BYTES = 8 * 1024;

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** True when `buf` holds `sig` at `offset`. */
function at(buf: Buffer, offset: number, sig: readonly number[]): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((byte, i) => buf[offset + i] === byte);
}

const ID3 = ascii('ID3');
const RIFF = ascii('RIFF');
const FTYP = ascii('ftyp');
const OGGS = ascii('OggS');
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** An MPEG audio frame sync (11 set bits), as MP3 and ADTS AAC streams start. */
const isFrameSync = (buf: Buffer): boolean =>
  buf.length >= 2 && buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0;

const isIsoMedia = (buf: Buffer): boolean => at(buf, 4, FTYP);

const isRiff = (buf: Buffer, form: string): boolean => at(buf, 0, RIFF) && at(buf, 8, ascii(form));

/** A UTF-16 byte-order mark: such text carries NUL bytes by design. */
const hasUtf16Bom = (buf: Buffer): boolean => at(buf, 0, [0xff, 0xfe]) || at(buf, 0, [0xfe, 0xff]);

/** Plain text: no NUL byte in the first {@link TEXT_SNIFF_BYTES}, unless UTF-16. */
function isText(buf: Buffer): boolean {
  if (hasUtf16Bom(buf)) return true;
  return !buf.subarray(0, TEXT_SNIFF_BYTES).includes(0);
}

const CHECKS: Readonly<Record<string, (buf: Buffer) => boolean>> = {
  mp3: (b) => at(b, 0, ID3) || isFrameSync(b),
  aac: (b) => at(b, 0, ID3) || isFrameSync(b),
  m4a: isIsoMedia,
  mp4: isIsoMedia,
  wav: (b) => isRiff(b, 'WAVE'),
  ogg: (b) => at(b, 0, OGGS),
  oga: (b) => at(b, 0, OGGS),
  opus: (b) => at(b, 0, OGGS),
  webm: (b) => at(b, 0, [0x1a, 0x45, 0xdf, 0xa3]),
  flac: (b) => at(b, 0, ascii('fLaC')),
  pdf: (b) => at(b, 0, ascii('%PDF-')),
  docx: (b) => at(b, 0, ZIP),
  xlsx: (b) => at(b, 0, ZIP),
  txt: isText,
  md: isText,
  csv: isText,
  png: (b) => at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (b) => at(b, 0, [0xff, 0xd8, 0xff]),
  jpeg: (b) => at(b, 0, [0xff, 0xd8, 0xff]),
  gif: (b) => at(b, 0, ascii('GIF87a')) || at(b, 0, ascii('GIF89a')),
  webp: (b) => isRiff(b, 'WEBP'),
};

/**
 * Whether `content` matches the accepted file type `extension` (lower case,
 * without the dot). An extension without a check answers false, so a type
 * added to the accepted list without a signature is refused, not let through.
 */
export function uploadContentMatches(extension: string, content: Buffer): boolean {
  const check = CHECKS[extension];
  return check !== undefined && check(content);
}

/** The extensions this module has a signature for (for the coverage test). */
export const CHECKED_UPLOAD_EXTENSIONS: readonly string[] = Object.keys(CHECKS);
