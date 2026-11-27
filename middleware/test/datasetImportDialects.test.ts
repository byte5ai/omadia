/**
 * #1845 / #1847 / #1867 — dataset import: ISO dates, CSV dialects and
 * encodings, linear whole-table masking.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildDatasetFromCsv,
  parseCsv,
} from '../packages/harness-orchestrator/src/datasetImport.js';
import { sniffCsvDelimiter, uniqueHeaders } from '../packages/harness-orchestrator/src/datasetCsvDialect.js';
import {
  dateOrderForColumn,
  normaliseDateCell,
} from '../packages/harness-orchestrator/src/datasetDates.js';
import { createBaselineDetector, maskTableCells } from '@omadia/plugin-privacy-guard';

const csv = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('#1845 — date cells are stored as ISO-8601', () => {
  it('normalises d.m.yyyy, slash dates, XLSX timestamps and zones', () => {
    assert.equal(normaliseDateCell('19.04.2024'), '2024-04-19');
    assert.equal(normaliseDateCell('3.2.2025'), '2025-02-03');
    assert.equal(normaliseDateCell('19/04/2024'), '2024-04-19');
    assert.equal(normaliseDateCell('04/19/2024', 'mdy'), '2024-04-19');
    assert.equal(normaliseDateCell('01.03.25'), '2025-03-01');
    assert.equal(normaliseDateCell('01.03.2025 10:30'), '2025-03-01T10:30');
    assert.equal(normaliseDateCell('2025-03-01T10:30:00.000Z'), '2025-03-01T10:30:00Z');
    assert.equal(normaliseDateCell('2025-03-01T12:30:00+02:00'), '2025-03-01T10:30:00Z');
    assert.equal(normaliseDateCell('2025-03-01T10:30:00'), '2025-03-01T10:30:00');
    assert.equal(normaliseDateCell('2025-03-01'), '2025-03-01');
  });

  it('refuses impossible dates', () => {
    assert.equal(normaliseDateCell('31.02.2024'), undefined);
    assert.equal(normaliseDateCell('2024-13-01'), undefined);
    assert.equal(normaliseDateCell('1.2.3'), undefined);
  });

  it('reads a slash column month-first only when day-first does not fit', () => {
    assert.equal(dateOrderForColumn(['19/04/2024', '03/02/2025']), 'dmy');
    assert.equal(dateOrderForColumn(['04/19/2024', '12/27/2025']), 'mdy');
    assert.equal(dateOrderForColumn(['19/04/2024', '04/19/2024']), undefined);
    assert.equal(dateOrderForColumn(['19.04.2024', '04.19.2024']), undefined);
  });

  it('types d.m.yyyy as date and stores it so text order is date order (issue repro)', async () => {
    const built = await buildDatasetFromCsv(
      csv(
        'Name,Datum,Datum_DE\nAnna,2024-04-19,19.04.2024\nBen,2025-11-28,28.11.2025\nClara,2025-12-27,27.12.2025\nDana,2025-02-03,03.02.2025\n',
      ),
    );
    assert.ok(built.ok);
    const de = built.columns.find((c) => c.name === 'Datum_DE');
    assert.equal(de?.type, 'date');
    assert.equal(de?.sample, '2024-04-19');
    const latest = [...built.rows].sort((a, b) =>
      String(b['Datum_DE']).localeCompare(String(a['Datum_DE'])),
    )[0];
    assert.equal(latest?.['Name'], 'Clara');
    for (const row of built.rows) assert.equal(row['Datum_DE'], row['Datum']);
  });

  it('types an XLSX-style timestamp column as date, not string', async () => {
    const built = await buildDatasetFromCsv(
      csv('t\n2025-03-01T10:30:00.000Z\n2025-03-02\n'),
    );
    assert.ok(built.ok);
    assert.equal(built.columns[0]?.type, 'date');
    assert.equal(built.rows[0]?.['t'], '2025-03-01T10:30:00Z');
  });
});

describe('#1847 — CSV dialects, encodings and repeated headers', () => {
  it('keeps every column of a repeated header name', () => {
    const parsed = parseCsv(csv('a,b,a\n1,2,3\n4,5,6\n'));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.headers, ['a', 'b', 'a_2']);
    assert.deepEqual(parsed.rows[0], { a: '1', b: '2', a_2: '3' });
  });

  it('never lets a suffix collide with a real header', () => {
    assert.deepEqual(uniqueHeaders(['a', 'a', 'a_2']), ['a', 'a_3', 'a_2']);
    assert.deepEqual(uniqueHeaders(['', ' x ', 'x']), ['column_1', 'x', 'x_2']);
  });

  it('reads semicolon-separated files, with and without quotes', () => {
    const quoted = parseCsv(csv('Kundennr;Name;Notiz\nK-0001;Kai Böhm;"Frau ""Weiß"""\n'));
    assert.ok(quoted.ok);
    assert.deepEqual(quoted.headers, ['Kundennr', 'Name', 'Notiz']);
    assert.equal(quoted.rows[0]?.['Notiz'], 'Frau "Weiß"');
    const plain = parseCsv(csv('Kundennr;Name;Ort\nK-0001;Kai Böhm;Berlin\n'));
    assert.ok(plain.ok);
    assert.deepEqual(plain.rows[0], { Kundennr: 'K-0001', Name: 'Kai Böhm', Ort: 'Berlin' });
  });

  it('reads tab-separated files and keeps commas inside a semicolon file', () => {
    assert.equal(sniffCsvDelimiter('a\tb\tc\n1\t2\t3'), '\t');
    assert.equal(sniffCsvDelimiter('"x;y",b\n1,2'), ',');
    const parsed = parseCsv(csv('Betrag;Text\n1,50;a, b\n'));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.rows[0], { Betrag: '1,50', Text: 'a, b' });
  });

  it('decodes Windows-1252 instead of storing replacement characters', () => {
    const bytes = Buffer.from([
      ...Buffer.from('Kundennr,Name\nK-0001,', 'latin1'),
      0xd6, // Ö
      ...Buffer.from('mer Hoffmann-R', 'latin1'),
      0xf6, // ö
      ...Buffer.from('der\n', 'latin1'),
    ]);
    const parsed = parseCsv(bytes);
    assert.ok(parsed.ok);
    assert.equal(parsed.rows[0]?.['Name'], 'Ömer Hoffmann-Röder');
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const parsed = parseCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv('id,x\n1,2\n')]));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.headers, ['id', 'x']);
  });

  it('returns coded failures the UI can translate', () => {
    const ragged = parseCsv(csv('a,b\n1,2\n3\n'));
    assert.ok(!ragged.ok);
    assert.equal(ragged.code, 'csv_ragged_rows');
    assert.equal(typeof ragged.line, 'number');
    const broken = parseCsv(csv('a,b\n"1,2\n'));
    assert.ok(!broken.ok);
    assert.equal(broken.code, 'csv_unreadable');
    const empty = parseCsv(csv('a,b\n'));
    assert.ok(!empty.ok);
    assert.equal(empty.code, 'csv_empty');
  });
});

describe('#1867 — whole-table masking is linear and keeps one surrogate per value', () => {
  it('masks a value wherever it reappears, with the same surrogate', async () => {
    const { masked } = await maskTableCells(
      ['mail anna@example.org', 'anna@example.org', 'ben@example.org', 'no pii here', ''],
      [createBaselineDetector()],
    );
    assert.equal(masked[3], 'no pii here');
    assert.equal(masked[4], '');
    assert.ok(!masked.slice(0, 3).some((m) => m.includes('example.org')));
    assert.equal(masked[0], `mail ${masked[1] ?? ''}`);
    assert.notEqual(masked[1], masked[2]);
  });

  it('never mints a surrogate equal to a value the table already holds', async () => {
    // The first pool e-mail surrogate already stands in the table.
    const first = (await maskTableCells(['x@example.org'], [createBaselineDetector()])).masked[0] ?? '';
    const { masked } = await maskTableCells(['x@example.org', first], [createBaselineDetector()]);
    assert.equal(masked[1], first, 'a surrogate-shaped value stays as written');
    assert.notEqual(masked[0], first);
  });

  it('keeps distinct surrogates beyond the size of a cycling pool', async () => {
    // The phone pool cycles after 10,000 numbers.
    const cells = Array.from({ length: 10_050 }, (_, i) => `+49 170 ${String(2_000_000 + i)}`);
    const { masked } = await maskTableCells(cells, [createBaselineDetector()]);
    assert.equal(new Set(masked).size, cells.length);
    assert.ok(!masked.some((m) => m.includes('+49 170')));
  });

  it('imports 20,000 contact rows in linear time without starving the event loop', async () => {
    const rows = 20_000;
    const lines = ['id,name,email,phone,city'];
    for (let i = 1; i <= rows; i++) {
      lines.push(`${String(i)},Customer ${String(i)},customer${String(i)}@example.org,+49 170 ${String(1_000_000 + i)},Berlin`);
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    const started = Date.now();
    const built = await buildDatasetFromCsv(csv(lines.join('\n')));
    const elapsed = Date.now() - started;
    clearInterval(timer);
    assert.ok(built.ok);
    assert.equal(built.privacyScan.maskedCells, rows * 2);
    assert.equal(new Set(built.rows.map((r) => r['email'])).size, rows, 'one surrogate per e-mail');
    // Quadratic code took ~94 s for 5,000 rows; linear code needs a few
    // seconds for 20,000 even on a slow CI runner.
    assert.ok(elapsed < 60_000, `import took ${String(elapsed)} ms`);
    assert.ok(ticks > 0, 'a timer fired during the import — the event loop was not blocked throughout');
  });
});
