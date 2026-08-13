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

describe('parseSkillMarkdown unparsed-frontmatter reporting', () => {
  it('reports list entries together with the key that owns them', () => {
    // A skill authored for an ecosystem that uses list-valued frontmatter
    // (agentskills.io, Hermes). The block opener must be reported with its
    // entries — otherwise the reader sees orphan fragments — and it must NOT
    // be stored as an empty string, which would be a value the source never
    // had, travelling on into the content hash and the risk scan.
    const parsed = parseSkillMarkdown('---\nname: n\ntools:\n  - read\n  - write\n---\n\nBody.\n');
    assert.ok(!('tools' in parsed.frontmatter), 'must not invent an empty `tools` value');
    assert.deepEqual(parsed.unparsedLines, ['tools:', '  - read', '  - write']);
    assert.equal(parsed.frontmatter['name'], 'n');
  });

  it('keeps two dropped blocks distinguishable by their owning key', () => {
    // Byte-identical entries under different keys must not collapse into an
    // ambiguous report.
    const parsed = parseSkillMarkdown(
      '---\nallowed-tools:\n  - Read\ndenied-tools:\n  - Read\n---\n\nBody.\n',
    );
    assert.deepEqual(parsed.unparsedLines, [
      'allowed-tools:',
      '  - Read',
      'denied-tools:',
      '  - Read',
    ]);
    assert.deepEqual(parsed.frontmatter, {});
  });

  it('reports indented nested mappings with their parent key', () => {
    const parsed = parseSkillMarkdown('---\nname: n\nmetadata:\n  author: someone\n---\n\nBody.\n');
    assert.deepEqual(parsed.unparsedLines, ['metadata:', '  author: someone']);
    assert.ok(!('metadata' in parsed.frontmatter));
  });

  it('still treats a genuinely empty trailing scalar as an empty string', () => {
    // `key:` with nothing following it is not a block opener — preserving the
    // pre-existing empty-scalar behaviour.
    const parsed = parseSkillMarkdown('---\nname: n\nnote:\n---\n\nBody.\n');
    assert.equal(parsed.frontmatter['note'], '');
    assert.deepEqual(parsed.unparsedLines, []);
  });

  it('treats an empty scalar followed by another scalar as an empty string', () => {
    const parsed = parseSkillMarkdown('---\nnote:\ndescription: d\n---\n\nBody.\n');
    assert.equal(parsed.frontmatter['note'], '');
    assert.equal(parsed.description, 'd');
    assert.deepEqual(parsed.unparsedLines, []);
  });

  it('is empty for frontmatter the parser fully represents', () => {
    const parsed = parseSkillMarkdown('---\nname: n\ndescription: d\n---\n\nBody.\n');
    assert.deepEqual(parsed.unparsedLines, []);
  });

  it('does not report blank lines or YAML comments as dropped', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: n\n\n# a comment\n   \n  # indented comment\ndescription: d\n---\n\nBody.\n',
    );
    assert.deepEqual(parsed.unparsedLines, []);
    assert.equal(parsed.frontmatter['name'], 'n');
    assert.equal(parsed.description, 'd');
  });

  it('is empty when there is no frontmatter block at all', () => {
    assert.deepEqual(parseSkillMarkdown('# Just a body').unparsedLines, []);
  });

  it('reports unparsed lines from CRLF sources too', () => {
    const parsed = parseSkillMarkdown('---\r\nname: n\r\ntools:\r\n  - read\r\n---\r\n\r\nBody.\r\n');
    assert.deepEqual(parsed.unparsedLines, ['tools:', '  - read']);
  });

  it('round-trips serializeSkillMarkdown output with nothing dropped', () => {
    const md = serializeSkillMarkdown({ name: 'a: b', description: 'line1\nline2' }, '# body');
    assert.deepEqual(parseSkillMarkdown(md).unparsedLines, []);
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
