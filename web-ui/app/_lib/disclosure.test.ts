/**
 * Issue #648 (epic #642) — when the operator dashboard shows the AI-marking
 * deviation hint, and when it must stay silent.
 *
 * The silence cases carry more weight than the firing case. #648 asks for a
 * surface that is "unverändert ruhig" in the delivered state; a hint that fires
 * on a default install is one operators learn to scroll past, which would cost
 * exactly the signal the feature exists to create.
 */

import { describe, expect, it } from 'vitest';

import {
  deviatingChannels,
  shouldShowDisclosureNotice,
  type DisclosureHealthDto,
} from './disclosure';

function posture(over: Partial<DisclosureHealthDto> = {}): DisclosureHealthDto {
  return {
    known: true,
    source: 'default',
    deviates: false,
    channels: {
      teams: 'standard',
      telegram: 'standard',
      slack: 'standard',
      email: 'standard',
      web: 'standard',
    },
    inertOverrides: [],
    warnings: [],
    ...over,
  };
}

describe('#648 — disclosure deviation hint', () => {
  it('stays silent in the delivered state', () => {
    expect(shouldShowDisclosureNotice(posture())).toBe(false);
    expect(deviatingChannels(posture())).toEqual([]);
  });

  it('stays silent when the posture could not be read', () => {
    // An unreachable middleware, or one older than this feature. "We could not
    // read it" is not "it deviates" — claiming a deviation here would train the
    // operator to distrust the hint.
    expect(shouldShowDisclosureNotice(null)).toBe(false);
    expect(shouldShowDisclosureNotice(posture({ known: false }))).toBe(false);
  });

  it('fires for a per-channel override and names only the changed channel', () => {
    const p = posture({
      source: 'operator',
      deviates: true,
      channels: { ...posture().channels, telegram: 'concise' },
    });

    expect(shouldShowDisclosureNotice(p)).toBe(true);
    expect(deviatingChannels(p)).toEqual([['telegram', 'concise']]);
  });

  it('names every channel when the operator changed the GLOBAL level', () => {
    // The case a "compare against this instance's own default" implementation
    // would report as nothing at all: no per-channel override exists, but the
    // operator switched marking off everywhere.
    const p = posture({
      source: 'operator',
      deviates: true,
      channels: {
        teams: 'off',
        telegram: 'off',
        slack: 'off',
        email: 'off',
        web: 'off',
      },
    });

    expect(shouldShowDisclosureNotice(p)).toBe(true);
    expect(deviatingChannels(p).map(([c]) => c)).toEqual([
      'teams',
      'telegram',
      'slack',
      'email',
      'web',
    ]);
  });

  it('stays silent for an override that merely pins the shipping level', () => {
    // `web=standard` configures an override that can never fire, but it
    // deviates from nothing — so it is not worth a warning banner.
    const p = posture({ source: 'operator', inertOverrides: ['web'] });

    expect(shouldShowDisclosureNotice(p)).toBe(false);
  });
});
