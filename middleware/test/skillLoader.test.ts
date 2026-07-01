import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkill, parseSkillMarkdown } from '../src/services/skillLoader.js';

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
});
