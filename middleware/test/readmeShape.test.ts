/**
 * The root README is omadia's landing page: a pitch with a quickstart, the way
 * the benchmark open-source projects write theirs. Defaults, limits, guides and
 * troubleshooting live in `docs/`. This guard keeps the README in that shape,
 * so a detail that belongs in a sub-document fails here instead of growing the
 * pitch. The rules and the benchmark behind them: `docs/readme-guidelines.md`.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, 'README.md')) && existsSync(path.join(dir, 'CITATION.cff'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no checkout root (README.md + CITATION.cff) above ${start}`);
    dir = parent;
  }
}

const README = readFileSync(path.join(findRepoRoot(HERE), 'README.md'), 'utf-8');
const GUIDE = 'see docs/readme-guidelines.md';

const MAX_LINES = 220;
const MAX_PARAGRAPH_WORDS = 75;
const MAX_CELL_WORDS = 30;
const MAX_SENTENCE_WORDS = 40;

/** Visible words: link targets, inline HTML and `&nbsp;` do not count. */
function words(text: string): number {
  const visible = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');
  return visible.split(/\s+/).filter(Boolean).length;
}

const withoutCode = README.replace(/```[\s\S]*?```/g, '');

/** Prose paragraphs: blocks that are not headings, lists, tables, HTML or URLs. */
const paragraphs = withoutCode
  .split(/\n\s*\n/)
  .map((block) => block.trim())
  .filter((block) => block.length > 0 && !/^(#|\||<|-|\*|\[!\[|!\[|https?:)/.test(block));

const cells = withoutCode
  .split('\n')
  .filter((line) => line.startsWith('|') && !/^\|[-:| ]+\|$/.test(line))
  .flatMap((line) => line.replace(/^\||\|$/g, '').split('|'))
  .map((cell) => cell.trim());

describe('the README stays a pitch', () => {
  it(`has at most ${MAX_LINES} lines`, () => {
    const lines = README.split('\n').length;
    assert.ok(lines <= MAX_LINES, `README has ${lines} lines; move detail into docs/ (${GUIDE})`);
  });

  it(`keeps every prose paragraph at ${MAX_PARAGRAPH_WORDS} words or fewer`, () => {
    const long = paragraphs.filter((p) => words(p) > MAX_PARAGRAPH_WORDS);
    assert.deepEqual(
      long.map((p) => `${words(p)} words: ${p.slice(0, 80)}…`),
      [],
      `README paragraphs over ${MAX_PARAGRAPH_WORDS} words belong in a sub-document (${GUIDE})`,
    );
  });

  it(`keeps every sentence at ${MAX_SENTENCE_WORDS} words or fewer`, () => {
    const long = [...paragraphs, ...cells]
      .flatMap((block) => block.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/))
      .filter((sentence) => words(sentence) > MAX_SENTENCE_WORDS);
    assert.deepEqual(long, [], `README sentences over ${MAX_SENTENCE_WORDS} words (${GUIDE})`);
  });

  it(`keeps every table cell at ${MAX_CELL_WORDS} words or fewer`, () => {
    const long = cells.filter((cell) => words(cell) > MAX_CELL_WORDS);
    assert.deepEqual(long, [], `README table cells over ${MAX_CELL_WORDS} words (${GUIDE})`);
  });

  it('uses no em dash and no middle dot', () => {
    const hits = README.split('\n').filter((line) => /[—·]/.test(line));
    assert.deepEqual(hits, [], `README lines with an em dash or a middle dot (${GUIDE})`);
  });
});
