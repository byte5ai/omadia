/**
 * Install-target classification — the five shapes an operator can paste, and
 * the one decision that follows from each.
 *
 * WHY THIS SUITE EXISTS. An operator pasted
 * `abc8af8ec7fc471785d3b83c4d84b667` into the team field. The chain answered
 * `400 teamId needs to be a valid GUID`, then — once the GUID was normalised —
 * `404 No team found with Group Id`. Every team and every channel of the
 * tenant was searched afterwards and the id was neither: it was, with high
 * probability, the stem of a GROUP CHAT id. The operator wanted the right
 * thing from the start and the chain had no vocabulary for it.
 *
 * So the vocabulary is pinned here, once, and both the route and the runner
 * read it from the same function.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  classifyTeamsInstallTarget,
  resolveTeamsInstallTarget,
  TEAMS_TARGET_EXAMPLES,
} from '../src/platform/teamsInstallTarget.js';

describe('classifyTeamsInstallTarget', () => {
  it('reads a dashed GUID as a team', () => {
    const result = classifyTeamsInstallTarget('2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c');
    assert.equal(result.kind, 'team');
    assert.equal(result.id, '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c');
  });

  it('lowercases and keeps a dashed GUID addressable', () => {
    const result = classifyTeamsInstallTarget('2F1A9C44-1F0E-4F2C-8F1A-9C441F0E4F2C');
    assert.equal(result.kind, 'team');
    assert.equal(result.id, '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c');
  });

  it('reads a @thread.v2 id as a group chat', () => {
    const result = classifyTeamsInstallTarget('19:abc123def456@thread.v2');
    assert.equal(result.kind, 'group-chat');
    assert.equal(result.id, '19:abc123def456@thread.v2');
  });

  it('reads a @unq.gbl.spaces id as a one-on-one chat', () => {
    const result = classifyTeamsInstallTarget('19:user1_user2@unq.gbl.spaces');
    assert.equal(result.kind, 'one-on-one-chat');
    assert.equal(result.id, '19:user1_user2@unq.gbl.spaces');
  });

  it('reads a @thread.tacv2 id as a CHANNEL — never an install target', () => {
    const result = classifyTeamsInstallTarget('19:aBcDeF@thread.tacv2');
    assert.equal(result.kind, 'channel');
  });

  it('refuses to guess at a bare 32-hex string', () => {
    // The field-test id. It IS 32 hex, and that is exactly the problem: it
    // could be a team's group id or the stem of `19:<32hex>@thread.v2`.
    const result = classifyTeamsInstallTarget('abc8af8ec7fc471785d3b83c4d84b667');
    assert.equal(result.kind, 'ambiguous');
    // Still carries BOTH readings, so a caller can name them without
    // re-deriving the shapes.
    assert.equal(result.asTeamId, 'abc8af8e-c7fc-4717-85d3-b83c4d84b667');
    assert.equal(result.asGroupChatId, '19:abc8af8ec7fc471785d3b83c4d84b667@thread.v2');
  });

  it('calls anything else unrecognised rather than inventing a kind', () => {
    for (const input of ['hello world', '19:nope@thread.v9', 'not-a-guid', '19:']) {
      assert.equal(
        classifyTeamsInstallTarget(input).kind,
        'unrecognised',
        `expected ${input} to be unrecognised`,
      );
    }
  });

  it('trims copy-paste whitespace before deciding', () => {
    assert.equal(classifyTeamsInstallTarget('  19:x@thread.v2  ').kind, 'group-chat');
    assert.equal(
      classifyTeamsInstallTarget('  19:x@thread.v2  ').id,
      '19:x@thread.v2',
    );
  });

  it('treats an empty string as unrecognised, not as a crash', () => {
    assert.equal(classifyTeamsInstallTarget('').kind, 'unrecognised');
    assert.equal(classifyTeamsInstallTarget('   ').kind, 'unrecognised');
  });

  it('is case-insensitive about the thread suffixes Teams hands out', () => {
    assert.equal(classifyTeamsInstallTarget('19:x@Thread.V2').kind, 'group-chat');
    assert.equal(classifyTeamsInstallTarget('19:x@THREAD.TACV2').kind, 'channel');
  });
});

describe('resolveTeamsInstallTarget', () => {
  it('accepts a team and reports its kind', () => {
    const result = resolveTeamsInstallTarget('2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.kind, 'team');
  });

  it('accepts a group chat and reports its kind', () => {
    const result = resolveTeamsInstallTarget('19:abc@thread.v2');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.kind, 'group-chat');
  });

  it('accepts a one-on-one chat and reports its kind', () => {
    const result = resolveTeamsInstallTarget('19:a_b@unq.gbl.spaces');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.kind, 'one-on-one-chat');
  });

  it('REFUSES a channel id, and says what to use instead', () => {
    const result = resolveTeamsInstallTarget('19:x@thread.tacv2');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'channel');
  });

  it('refuses an unrecognised string', () => {
    const result = resolveTeamsInstallTarget('hello');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unrecognised');
  });

  /**
   * THE FIELD-TEST ID. Refused rather than guessed at, and the refusal carries
   * both ways out — guessing "team" is what spent five provisioning steps
   * before Graph said `404 No team found with Group Id`, and guessing "chat"
   * would only move the refusal one hop later (the connector's `installToChat`
   * rejects a bare stem and wants the full `19:<hex>@thread.v2` form).
   */
  it('REFUSES a bare 32-hex, and hands back both readings', () => {
    const result = resolveTeamsInstallTarget('abc8af8ec7fc471785d3b83c4d84b667');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'ambiguous');
    assert.equal(
      result.ok === false && result.reason === 'ambiguous' && result.asTeamId,
      'abc8af8e-c7fc-4717-85d3-b83c4d84b667',
    );
    assert.equal(
      result.ok === false && result.reason === 'ambiguous' && result.asGroupChatId,
      '19:abc8af8ec7fc471785d3b83c4d84b667@thread.v2',
    );
  });

  it('accepts the DISAMBIGUATED forms of that same id', () => {
    // The two ways out the refusal names must themselves resolve — otherwise
    // the message sends the operator somewhere that also fails.
    const asTeam = resolveTeamsInstallTarget('abc8af8e-c7fc-4717-85d3-b83c4d84b667');
    assert.equal(asTeam.ok && asTeam.kind, 'team');
    const asChat = resolveTeamsInstallTarget(
      '19:abc8af8ec7fc471785d3b83c4d84b667@thread.v2',
    );
    assert.equal(asChat.ok && asChat.kind, 'group-chat');
  });
});

describe('TEAMS_TARGET_EXAMPLES', () => {
  it('ships one valid example per installable kind, and each classifies back', () => {
    assert.equal(classifyTeamsInstallTarget(TEAMS_TARGET_EXAMPLES.team).kind, 'team');
    assert.equal(
      classifyTeamsInstallTarget(TEAMS_TARGET_EXAMPLES.groupChat).kind,
      'group-chat',
    );
    assert.equal(
      classifyTeamsInstallTarget(TEAMS_TARGET_EXAMPLES.oneOnOneChat).kind,
      'one-on-one-chat',
    );
  });
});
