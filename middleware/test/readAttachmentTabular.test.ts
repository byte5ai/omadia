/**
 * `read_attachment` refuses tabular uploads.
 *
 * The tool is intern-exempt: what it returns reaches the model as it is, with
 * prompt masking on or off. A table (CSV, XLSX) is imported as a dataset when
 * it is uploaded — every cell privacy-scanned, flagged cells encrypted at rest
 * (security-architecture §6b) — so returning its text here would put exactly
 * those cells on the wire in clear. The tool answers with a model-readable
 * `Error:` that points to `query_dataset` instead, decided by the same
 * `detectTabularFormat` rule the chat-attachment ingest applies.
 *
 * All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  type AttachmentReader,
  ReadAttachmentTool,
  readAttachmentToolSpec,
} from '@omadia/orchestrator';

const CSV = 'name,email\nJana Beispielfrau,jana.beispiel@firma.example\n';
const CELLS = ['Jana Beispielfrau', 'jana.beispiel@firma.example'];

type StoredFile = { bytes: Buffer; contentType?: string; fileName?: string };

function reader(files: Record<string, StoredFile>): AttachmentReader {
  return {
    readByStorageKey: async (key: string) => files[key],
    readByUrl: async () => undefined,
  };
}

async function readOne(key: string, file: StoredFile): Promise<string> {
  return new ReadAttachmentTool(reader({ [key]: file })).handle({ storage_key: key });
}

function assertRefused(result: string): void {
  assert.match(result, /^Error: /);
  assert.ok(result.includes('query_dataset'), result);
  for (const cell of CELLS) {
    assert.equal(result.includes(cell), false, `a cell reached the model: ${cell}`);
  }
}

describe('read_attachment — tabular uploads', () => {
  const cases: ReadonlyArray<readonly [label: string, file: Omit<StoredFile, 'bytes'>]> = [
    ['a .csv file name', { contentType: 'application/octet-stream', fileName: 'kunden.csv' }],
    ['a text/csv content type', { contentType: 'text/csv; charset=utf-8', fileName: 'export' }],
    ['a CSV a Windows browser uploads', { contentType: 'application/vnd.ms-excel', fileName: 'Kunden.CSV' }],
    [
      'an .xlsx workbook',
      {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: 'kunden.xlsx',
      },
    ],
  ];
  for (const [label, file] of cases) {
    it(`refuses ${label} and points to query_dataset`, async () => {
      assertRefused(await readOne('uploads/f1', { bytes: Buffer.from(CSV, 'utf8'), ...file }));
    });
  }

  it('reads the format off the storage key when the store names no file', async () => {
    // `text/plain` alone would pass the extractor's plain-text branch.
    assertRefused(
      await readOne('uploads/2026/abc123.csv', {
        bytes: Buffer.from(CSV, 'utf8'),
        contentType: 'text/plain',
      }),
    );
  });

  it('still returns the text of a document', async () => {
    const text = '# Notizen\nJana ruft morgen zurück.';
    assert.equal(
      await readOne('uploads/notes.md', {
        bytes: Buffer.from(text, 'utf8'),
        contentType: 'text/markdown',
        fileName: 'notes.md',
      }),
      text,
    );
  });

  it('offers no CSV in its description and names the dataset path', () => {
    assert.equal(/\.csv\b/i.test(readAttachmentToolSpec.description), false);
    assert.ok(readAttachmentToolSpec.description.includes('query_dataset'));
  });
});
