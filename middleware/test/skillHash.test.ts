import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { computeSkillHash } from '@omadia/orchestrator';

describe('computeSkillHash', () => {
  it('returns a 64-char hex sha256', () => {
    const h = computeSkillHash({ name: 'x' }, 'body');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical content', () => {
    assert.equal(
      computeSkillHash({ a: 1, b: 2 }, 'body'),
      computeSkillHash({ a: 1, b: 2 }, 'body'),
    );
  });

  it('is independent of frontmatter key order', () => {
    assert.equal(
      computeSkillHash({ a: 1, b: 2 }, 'body'),
      computeSkillHash({ b: 2, a: 1 }, 'body'),
    );
  });

  it('is independent of key order in nested objects', () => {
    assert.equal(
      computeSkillHash({ meta: { x: 1, y: 2 } }, 'body'),
      computeSkillHash({ meta: { y: 2, x: 1 } }, 'body'),
    );
  });

  it('changes when the body changes', () => {
    assert.notEqual(
      computeSkillHash({ a: 1 }, 'body one'),
      computeSkillHash({ a: 1 }, 'body two'),
    );
  });

  it('changes when frontmatter changes', () => {
    assert.notEqual(
      computeSkillHash({ a: 1 }, 'body'),
      computeSkillHash({ a: 2 }, 'body'),
    );
  });

  it('respects array order (order is meaningful)', () => {
    assert.notEqual(
      computeSkillHash({ tags: ['a', 'b'] }, 'body'),
      computeSkillHash({ tags: ['b', 'a'] }, 'body'),
    );
  });

  it('distinguishes empty frontmatter from a present-but-empty body', () => {
    assert.notEqual(computeSkillHash({}, ''), computeSkillHash({ x: '' }, ''));
  });

  it('drops undefined-valued keys, mirroring JSON.stringify / the stored jsonb', () => {
    // An undefined-valued key is dropped by JSON.stringify (used to persist the
    // jsonb column), so the hash must treat {a: undefined, b: 1} like {b: 1};
    // otherwise a later name-only patch would silently re-version the hash.
    assert.equal(
      computeSkillHash({ a: undefined, b: 1 }, 'x'),
      computeSkillHash({ b: 1 }, 'x'),
    );
  });
});
