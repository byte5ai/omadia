import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkill } from '../src/services/skillLoader.js';

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
