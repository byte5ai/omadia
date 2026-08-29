import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeTeamsTeamId } from '../src/platform/teamsTeamId.js';

describe('normalizeTeamsTeamId (#860)', () => {
  it('dashes the unhyphenated form Teams hands out', () => {
    // The exact value from the first end-to-end run on the byte5 tenant: the
    // chain completed the Entra app, the Azure bot and the catalog upload,
    // then Graph answered `teamId needs to be a valid GUID.` on the install.
    assert.equal(
      normalizeTeamsTeamId('abc8af8ec7fc471785d3b83c4d84b667'),
      'abc8af8e-c7fc-4717-85d3-b83c4d84b667',
    );
  });

  it('leaves an already-dashed GUID alone', () => {
    const canonical = 'abc8af8e-c7fc-4717-85d3-b83c4d84b667';
    assert.equal(normalizeTeamsTeamId(canonical), canonical);
  });

  it('lowercases while dashing, so one team has one representation', () => {
    assert.equal(
      normalizeTeamsTeamId('ABC8AF8EC7FC471785D3B83C4D84B667'),
      'abc8af8e-c7fc-4717-85d3-b83c4d84b667',
    );
  });

  it('trims the whitespace a paste brings with it', () => {
    assert.equal(
      normalizeTeamsTeamId('  abc8af8ec7fc471785d3b83c4d84b667\n'),
      'abc8af8e-c7fc-4717-85d3-b83c4d84b667',
    );
  });

  it('passes through identifiers it has no business reshaping', () => {
    // A conversation/thread id is a legitimate way to name a Teams
    // destination and is not a GUID. Rewriting it — or rejecting it — would
    // break working input to fix a problem it does not have.
    const thread = '19:abc8af8ec7fc471785d3b83c4d84b667@thread.tacv2';
    assert.equal(normalizeTeamsTeamId(thread), thread);
  });

  it('does not dash a hex string of the wrong length', () => {
    // 31 and 33 digits are not GUIDs; guessing where the dashes go would
    // invent an id that addresses nothing.
    assert.equal(
      normalizeTeamsTeamId('abc8af8ec7fc471785d3b83c4d84b66'),
      'abc8af8ec7fc471785d3b83c4d84b66',
    );
    assert.equal(
      normalizeTeamsTeamId('abc8af8ec7fc471785d3b83c4d84b6677'),
      'abc8af8ec7fc471785d3b83c4d84b6677',
    );
  });

  it('does not dash a 32-character string that is not hex', () => {
    const notHex = 'zbc8af8ec7fc471785d3b83c4d84b667';
    assert.equal(normalizeTeamsTeamId(notHex), notHex);
  });
});
