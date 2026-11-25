/**
 * `docs/adr/README.md` is the way into the Architecture Decision Records: an
 * index with one row per record and a topic map that assigns every area of the
 * codebase its records. AGENTS.md ("ADR-Abgleich") sends every task through
 * that map, so a record missing from it is a record nobody finds. This guard
 * keeps the three in step: the files, the index and the topic map.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADR_FILE = /^(\d{4})-[a-z0-9-]+\.md$/;
const TEMPLATE_NUMBER = '0000';
const INDEX_HEADING = '## Index';
const TOPIC_MAP_HEADING = '## Topic map';

function findAdrDir(start: string): string {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, 'docs', 'adr');
    if (existsSync(path.join(candidate, 'README.md'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no docs/adr/README.md above ${start}`);
    dir = parent;
  }
}

/** The text of one `## ` section, without the sections that follow it. */
function section(readme: string, heading: string): string {
  const start = readme.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `docs/adr/README.md has no "${heading}" section`);
  const rest = readme.slice(start + heading.length + 2);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

const adrDir = findAdrDir(HERE);
const readme = readFileSync(path.join(adrDir, 'README.md'), 'utf8');
const records = readdirSync(adrDir)
  .filter((name) => ADR_FILE.test(name) && !name.startsWith(TEMPLATE_NUMBER))
  .sort();

describe('docs/adr index guard', () => {
  it('finds the records', () => {
    assert.ok(records.length > 0, 'no ADR files found');
  });

  it('gives every number to exactly one record', () => {
    const byNumber = new Map<string, string[]>();
    for (const name of records) {
      const number = name.slice(0, 4);
      byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
    }
    const duplicates = [...byNumber.values()].filter((names) => names.length > 1);
    assert.deepEqual(duplicates, [], 'two ADR files share a number');
  });

  it('lists every record in the index', () => {
    const index = section(readme, INDEX_HEADING);
    const missing = records.filter((name) => !index.includes(`](${name})`));
    assert.deepEqual(missing, [], 'ADR files without a row in the index');
  });

  it('assigns every record to a topic in the topic map', () => {
    const topicMap = section(readme, TOPIC_MAP_HEADING);
    const missing = records.filter((name) => !topicMap.includes(`](${name})`));
    assert.deepEqual(missing, [], 'ADR files no topic in the topic map names');
  });

  it('links only to records that exist', () => {
    const linked = [...readme.matchAll(/\]\((\d{4}-[a-z0-9-]+\.md)\)/g)].map((m) => m[1] ?? '');
    const dead = [...new Set(linked)].filter((name) => !existsSync(path.join(adrDir, name)));
    assert.deepEqual(dead, [], 'README links to ADR files that do not exist');
  });

  it('titles every record with its own number', () => {
    const wrong = records.filter((name) => {
      const firstLine = readFileSync(path.join(adrDir, name), 'utf8').split('\n', 1)[0] ?? '';
      return !firstLine.startsWith(`# ${name.slice(0, 4)} `);
    });
    assert.deepEqual(wrong, [], 'ADR files whose title does not start with their number');
  });
});
