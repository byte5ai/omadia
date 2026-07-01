import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSkill,
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from '../src/services/skillLoader.js';

describe('loadSkill', () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skill-test-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('parses frontmatter and returns the body separately', async () => {
    const dir = join(tmp, 'example');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: example\ndescription: An example skill.\n---\n\n# Example\n\nProse body.\n',
    );
    const skill = await loadSkill(dir);
    assert.equal(skill.description, 'An example skill.');
    assert.match(skill.body, /^# Example/);
    assert.ok(!skill.body.includes('---'), 'body must not contain frontmatter delimiters');
  });

  it('falls back to the directory name if description is missing', async () => {
    const dir = join(tmp, 'bare');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: bare\n---\n\nJust body.\n');
    const skill = await loadSkill(dir);
    assert.equal(skill.description, 'bare');
  });

  it('treats the whole file as body when there is no frontmatter', async () => {
    const dir = join(tmp, 'nofm');
    mkdirSync(dir);
    const content = '# No frontmatter here\n\nSome body.';
    writeFileSync(join(dir, 'SKILL.md'), content);
    const skill = await loadSkill(dir);
    assert.equal(skill.description, 'nofm');
    assert.equal(skill.body, content.trim());
  });
});

describe('parseSkillMarkdown', () => {
  it('parses frontmatter, trimmed body, and description from a raw string', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: example\ndescription: An example skill.\n---\n\n# Example\n\nProse body.\n',
    );
    assert.equal(parsed.description, 'An example skill.');
    assert.equal(parsed.frontmatter['name'], 'example');
    assert.match(parsed.body, /^# Example/);
    assert.ok(!parsed.body.includes('---'), 'body must not contain frontmatter delimiters');
  });

  it('returns undefined description when frontmatter has none', () => {
    const parsed = parseSkillMarkdown('---\nname: bare\n---\n\nJust body.\n');
    assert.equal(parsed.description, undefined);
    assert.equal(parsed.body, 'Just body.');
  });

  it('treats the whole string as body when there is no frontmatter', () => {
    const parsed = parseSkillMarkdown('# No frontmatter\n\nSome body.');
    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, '# No frontmatter\n\nSome body.');
    assert.equal(parsed.description, undefined);
  });

  it('parses CRLF frontmatter (Windows line endings)', () => {
    const parsed = parseSkillMarkdown('---\r\nname: win\r\ndescription: d\r\n---\r\n\r\nBody.\r\n');
    assert.equal(parsed.frontmatter['name'], 'win');
    assert.equal(parsed.description, 'd');
    assert.equal(parsed.body, 'Body.');
  });
});

describe('serializeSkillMarkdown', () => {
  it('round-trips simple scalars through parseSkillMarkdown', () => {
    const fm = { name: 'Research Helper', description: 'Helps research.' };
    const md = serializeSkillMarkdown(fm, '# Research\n\nBody.');
    const parsed = parseSkillMarkdown(md);
    assert.equal(parsed.frontmatter['name'], 'Research Helper');
    assert.equal(parsed.description, 'Helps research.');
    assert.match(parsed.body, /^# Research/);
  });

  it('quotes values that would misparse', () => {
    const md = serializeSkillMarkdown({ name: 'a: b' }, 'body');
    assert.match(md, /name: "a: b"/);
  });

  it('is an exact inverse of parseSkillMarkdown for tricky scalars', () => {
    const fm = { name: 'a: b', description: 'line1\nline2', note: '  spaced  ' };
    const parsed = parseSkillMarkdown(serializeSkillMarkdown(fm, '# body\n\n---\nnot frontmatter'));
    assert.equal(parsed.frontmatter['name'], 'a: b');
    assert.equal(parsed.frontmatter['description'], 'line1\nline2');
    assert.equal(parsed.frontmatter['note'], '  spaced  ');
    assert.match(parsed.body, /^# body/);
  });

  it('survives a body that itself contains a --- line', () => {
    const parsed = parseSkillMarkdown(serializeSkillMarkdown({ name: 'x' }, 'a\n---\nb'));
    assert.equal(parsed.frontmatter['name'], 'x');
    assert.equal(parsed.body, 'a\n---\nb');
  });
});
