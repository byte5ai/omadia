/**
 * The browser-side install-target verdict — the label under the field, and the
 * gate on the submit button.
 *
 * TWO THINGS ARE PINNED HERE, and they are the two halves of one bug.
 *
 * ONE: `19:…@thread.skype` is a group chat. It is the pre-`v2` spelling, the
 * tenant chat listing returns plenty of them, and this module used to call
 * them unrecognised — so the picker offered a chat and the field beneath it
 * announced that the chat was not an install target.
 *
 * TWO, and the one that outlives the suffix: an id that came out of the
 * listing does not need classifying at all. Graph said what it was. The
 * heuristic exists for strings a human typed, where guessing is the danger;
 * running a listed id back through it discards a better answer and re-derives
 * a worse one — and every id shape Microsoft mints next breaks the picker the
 * same way. So the directory's answer wins, bound to the exact id it was
 * about, which is what makes an edit put the kind back up for classification.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyKnownTeamsTarget,
  classifyTeamsInstallTarget,
  isSubmittableTarget,
  TEAMS_TARGET_EXAMPLES,
} from '../teamsInstallTarget';

// The id an operator actually picked out of the chat list, and could not use.
const LEGACY = '19:abc8af8ec7fc471785d3b83c4d84b667@thread.skype';

describe('the legacy @thread.skype group chat', () => {
  it('classifies as a group chat, not as unrecognised', () => {
    const target = classifyTeamsInstallTarget(LEGACY);
    expect(target.kind).toBe('group-chat');
    expect(target.id).toBe(LEGACY);
  });

  it('is submittable — the button must not stay disabled', () => {
    expect(isSubmittableTarget(classifyTeamsInstallTarget(LEGACY))).toBe(true);
  });

  it('matches the suffix whatever its casing', () => {
    expect(classifyTeamsInstallTarget('19:ABC@THREAD.SKYPE').kind).toBe(
      'group-chat',
    );
  });

  it('does not loosen the channel refusal', () => {
    expect(classifyTeamsInstallTarget('19:abc@thread.tacv2').kind).toBe(
      'channel',
    );
  });

  it('ships as an example, and the example classifies back', () => {
    expect(
      classifyTeamsInstallTarget(TEAMS_TARGET_EXAMPLES.legacyGroupChat).kind,
    ).toBe('group-chat');
  });
});

describe('classifyKnownTeamsTarget', () => {
  // A shape no pattern here knows — standing in for whatever Microsoft adds
  // next. The point is that the picker keeps working without a code change.
  const UNKNOWN_SHAPE = '19:something@thread.futurev9';

  it('accepts a listed target the heuristic cannot read', () => {
    expect(classifyTeamsInstallTarget(UNKNOWN_SHAPE).kind).toBe('unrecognised');

    const target = classifyKnownTeamsTarget(UNKNOWN_SHAPE, {
      id: UNKNOWN_SHAPE,
      kind: 'group-chat',
    });
    expect(target.kind).toBe('group-chat');
    expect(isSubmittableTarget(target)).toBe(true);
  });

  it('drops the claim as soon as the value is edited', () => {
    // The invalidation is structural: the claim names the id it was made
    // about, so a changed field cannot keep wearing the old label.
    const target = classifyKnownTeamsTarget('19:something-else@thread.futurev9', {
      id: UNKNOWN_SHAPE,
      kind: 'group-chat',
    });
    expect(target.kind).toBe('unrecognised');
    expect(isSubmittableTarget(target)).toBe(false);
  });

  it('settles the bare-32-hex ambiguity when the directory named it', () => {
    const bare = 'abc8af8ec7fc471785d3b83c4d84b667';
    expect(classifyTeamsInstallTarget(bare).kind).toBe('ambiguous');
    expect(classifyKnownTeamsTarget(bare, { id: bare, kind: 'team' }).kind).toBe(
      'team',
    );
  });

  it('refuses a channel even when a chat kind is claimed for it', () => {
    // The directory never lists channels, so this claim cannot have come from
    // one — and installing "the channel's team" reaches every channel of it.
    const target = classifyKnownTeamsTarget('19:abc@thread.tacv2', {
      id: '19:abc@thread.tacv2',
      kind: 'group-chat',
    });
    expect(target.kind).toBe('channel');
  });

  it('behaves like the plain classifier with no claim', () => {
    expect(classifyKnownTeamsTarget(LEGACY).kind).toBe('group-chat');
    expect(classifyKnownTeamsTarget('').kind).toBe('empty');
  });
});
