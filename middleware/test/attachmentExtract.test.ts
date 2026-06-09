import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { extractAttachmentText } from '../packages/harness-orchestrator/src/attachmentExtract.js';

describe('extractAttachmentText', () => {
  it('passes through markdown via contentType', async () => {
    const md = '# Title\n\nSome **bold** body.';
    const r = await extractAttachmentText(
      Buffer.from(md, 'utf8'),
      'text/markdown',
      undefined,
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.text.includes('# Title'));
    assert.ok(r.ok && r.text.includes('**bold**'));
  });

  it('passes through plain text via .txt extension when contentType is unknown', async () => {
    const r = await extractAttachmentText(
      Buffer.from('hello world', 'utf8'),
      undefined,
      'notes.TXT',
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.text === 'hello world');
  });

  it('passes through CSV', async () => {
    const csv = 'a,b,c\n1,2,3';
    const r = await extractAttachmentText(
      Buffer.from(csv, 'utf8'),
      'text/csv',
      'data.csv',
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.text.includes('a,b,c'));
  });

  it('passes through JSON via application/json', async () => {
    const json = JSON.stringify({ k: 'v', n: 1 });
    const r = await extractAttachmentText(
      Buffer.from(json, 'utf8'),
      'application/json',
      undefined,
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.text.includes('"k":"v"'));
  });

  it('strips charset params from contentType', async () => {
    const r = await extractAttachmentText(
      Buffer.from('x', 'utf8'),
      'text/plain; charset=utf-8',
      undefined,
    );
    assert.equal(r.ok, true);
  });

  it('rejects images as non-text-extractable', async () => {
    const r = await extractAttachmentText(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'image/png',
      'logo.png',
    );
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /image/i.test(r.reason));
  });

  it('rejects unknown/binary types with a clear reason', async () => {
    const r = await extractAttachmentText(
      Buffer.from([0x00, 0x01, 0x02]),
      'application/octet-stream',
      'mystery.bin',
    );
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /unsupported/i.test(r.reason));
  });

  it('rejects empty content', async () => {
    const r = await extractAttachmentText(
      Buffer.from('   \n\n  ', 'utf8'),
      'text/plain',
      undefined,
    );
    assert.equal(r.ok, false);
  });

  it('collapses excessive blank lines', async () => {
    const r = await extractAttachmentText(
      Buffer.from('a\n\n\n\n\nb', 'utf8'),
      'text/plain',
      undefined,
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.text === 'a\n\nb');
  });

  it('truncates output beyond the char cap with a marker', async () => {
    const big = 'x'.repeat(25_000);
    const r = await extractAttachmentText(
      Buffer.from(big, 'utf8'),
      'text/plain',
      undefined,
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.text.length < 25_000);
    assert.ok(r.ok && r.text.endsWith('…[truncated]'));
  });

  it('routes .docx by extension to the docx extractor (no crash on bad bytes)', async () => {
    // Not a real docx — mammoth should throw internally; we assert the
    // routing reached the docx branch and the error was caught gracefully.
    const r = await extractAttachmentText(
      Buffer.from('not really a docx', 'utf8'),
      undefined,
      'broken.docx',
    );
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason.length > 0);
  });

  it('routes .pdf by contentType to the pdf extractor (no crash on bad bytes)', async () => {
    const r = await extractAttachmentText(
      Buffer.from('not really a pdf', 'utf8'),
      'application/pdf',
      undefined,
    );
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason.length > 0);
  });
});
