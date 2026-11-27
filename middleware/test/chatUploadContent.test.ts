/**
 * ADR-0333 — a web chat upload's first bytes must match the file type its
 * extension claims.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CHECKED_UPLOAD_EXTENSIONS, uploadContentMatches } from '../src/routes/chatUploadContent.js';
import { WEB_CHAT_UPLOAD_EXTENSIONS } from '../src/routes/chatUploads.js';

const b = (s: string): Buffer => Buffer.from(s, 'latin1');

const SAMPLES: Readonly<Record<string, Buffer>> = {
  mp3: b('ID3\x04\0\0'),
  aac: Buffer.from([0xff, 0xf1, 0x50, 0x80]),
  m4a: b('\0\0\0\x20ftypM4A '),
  mp4: b('\0\0\0\x18ftypmp42'),
  wav: b('RIFF\x24\0\0\0WAVEfmt '),
  ogg: b('OggS\0\x02'),
  oga: b('OggS\0\x02'),
  opus: b('OggS\0\x02'),
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]),
  flac: b('fLaC\0\0\0\x22'),
  pdf: b('%PDF-1.7\n'),
  docx: b('PK\x03\x04\x14\0'),
  xlsx: b('PK\x03\x04\x14\0'),
  txt: b('Hallo Welt\n'),
  md: b('# Titel\n'),
  csv: b('a;b\n1;2\n'),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
  gif: b('GIF89a\x01\0'),
  webp: b('RIFF\x24\0\0\0WEBPVP8 '),
};

describe('ADR-0333 · uploadContentMatches', () => {
  it('has a signature for every accepted extension', () => {
    assert.deepEqual([...CHECKED_UPLOAD_EXTENSIONS].sort(), [...WEB_CHAT_UPLOAD_EXTENSIONS].sort());
  });

  it('accepts a file whose first bytes match its extension', () => {
    for (const ext of WEB_CHAT_UPLOAD_EXTENSIONS) {
      const sample = SAMPLES[ext];
      assert.ok(sample, `no sample for ${ext}`);
      assert.equal(uploadContentMatches(ext, sample), true, ext);
    }
  });

  it('refuses an executable or a page renamed to an accepted type', () => {
    const exe = b('MZ\x90\0\x03\0');
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0]);
    const html = b('<!doctype html><script>');
    for (const ext of ['pdf', 'png', 'jpg', 'docx', 'wav', 'mp3', 'm4a', 'webp']) {
      assert.equal(uploadContentMatches(ext, exe), false, `exe as ${ext}`);
      assert.equal(uploadContentMatches(ext, html), false, `html as ${ext}`);
    }
    assert.equal(uploadContentMatches('txt', elf), false, 'binary as txt');
    assert.equal(uploadContentMatches('wav', SAMPLES.webp ?? b('')), false, 'RIFF of another form');
  });

  it('accepts UTF-16 text with its byte-order mark', () => {
    assert.equal(uploadContentMatches('csv', Buffer.from([0xff, 0xfe, 0x61, 0, 0x3b, 0])), true);
  });

  it('refuses an extension it has no signature for', () => {
    assert.equal(uploadContentMatches('exe', b('MZ')), false);
  });
});
