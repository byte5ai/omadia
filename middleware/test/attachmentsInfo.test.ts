import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseAttachmentsInfo } from '../packages/harness-orchestrator/src/attachmentsInfo.js';

const MIDDLE_DOT = '·'; // ·

describe('parseAttachmentsInfo', () => {
  it('returns [] when no block is present', () => {
    assert.deepEqual(parseAttachmentsInfo('just a normal message'), []);
    assert.deepEqual(parseAttachmentsInfo(''), []);
  });

  it('parses a single file with storage_key only', () => {
    const msg = [
      'Bitte fasse das Dokument zusammen.',
      '',
      `[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:`,
      `- report.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document, 42 KB) ${MIDDLE_DOT} storage_key=uploads/2026/report.docx`,
    ].join('\n');
    const out = parseAttachmentsInfo(msg);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.fileName, 'report.docx');
    assert.equal(
      out[0]?.contentType,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.equal(out[0]?.storageKey, 'uploads/2026/report.docx');
    assert.equal(out[0]?.signedUrl, undefined);
  });

  it('parses a file with storage_key AND signed_url', () => {
    const msg = [
      `[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:`,
      `- notes.md (text/markdown, 3 KB) ${MIDDLE_DOT} storage_key=uploads/x/notes.md ${MIDDLE_DOT} signed_url=https://bucket.example/notes.md?sig=abc`,
    ].join('\n');
    const out = parseAttachmentsInfo(msg);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.storageKey, 'uploads/x/notes.md');
    assert.equal(
      out[0]?.signedUrl,
      'https://bucket.example/notes.md?sig=abc',
    );
  });

  it('parses multiple files, mixed signed_url presence', () => {
    const msg = [
      'Schau dir die Dateien an.',
      `[attachments-info] 3 Datei(en) in diesem Turn hochgeladen + persistiert:`,
      `- a.txt (text/plain, 1 KB) ${MIDDLE_DOT} storage_key=k/a.txt`,
      `- b.pdf (application/pdf, 100 KB) ${MIDDLE_DOT} storage_key=k/b.pdf ${MIDDLE_DOT} signed_url=https://s/b.pdf`,
      `- c.json (application/json, 2 KB) ${MIDDLE_DOT} storage_key=k/c.json`,
    ].join('\n');
    const out = parseAttachmentsInfo(msg);
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((o) => o.fileName),
      ['a.txt', 'b.pdf', 'c.json'],
    );
    assert.equal(out[0]?.signedUrl, undefined);
    assert.equal(out[1]?.signedUrl, 'https://s/b.pdf');
    assert.equal(out[2]?.signedUrl, undefined);
  });

  it('skips malformed per-file lines but keeps valid ones', () => {
    const msg = [
      `[attachments-info] 2 Datei(en) in diesem Turn hochgeladen + persistiert:`,
      `- garbage line without a key`,
      `- ok.csv (text/csv, 5 KB) ${MIDDLE_DOT} storage_key=k/ok.csv`,
    ].join('\n');
    const out = parseAttachmentsInfo(msg);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.fileName, 'ok.csv');
  });

  it('handles filenames containing spaces', () => {
    const msg = [
      `[attachments-info] 1 Datei(en) in diesem Turn hochgeladen + persistiert:`,
      `- my final report.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document, 9 KB) ${MIDDLE_DOT} storage_key=k/my-final.docx`,
    ].join('\n');
    const out = parseAttachmentsInfo(msg);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.fileName, 'my final report.docx');
    assert.equal(out[0]?.storageKey, 'k/my-final.docx');
  });
});
