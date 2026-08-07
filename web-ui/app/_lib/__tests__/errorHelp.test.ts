import { describe, expect, it } from 'vitest';

import {
  ERROR_HELP_CODES,
  isErrorHelpCode,
  resolveErrorHelp,
} from '../errorHelp';

/**
 * The stub echoes the key it was asked for. That is the point: this file
 * proves the resolver reaches the RIGHT catalogue keys without ever asserting
 * on English prose, which would make every copy edit a test edit.
 */
const echoT = (key: string): string => key;

describe('resolveErrorHelp', () => {
  it('resolves a catalogued code to its what/next keys', () => {
    expect(resolveErrorHelp('store.list_failed', echoT)).toEqual({
      what: 'errorHelp.store.list_failed.what',
      next: 'errorHelp.store.list_failed.next',
    });
  });

  it('attaches the in-app route for a code that has one', () => {
    const help = resolveErrorHelp('store.plugin_not_found', echoT);

    expect(help?.actionHref).toBe('/store');
  });

  it('leaves actionHref off a code with no route', () => {
    const help = resolveErrorHelp('providers.key_rejected', echoT);

    expect(help).not.toHaveProperty('actionHref');
  });

  it('returns null for a code the catalogue does not cover', () => {
    expect(resolveErrorHelp('does.not.exist', echoT)).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(resolveErrorHelp(null, echoT)).toBeNull();
    expect(resolveErrorHelp(undefined, echoT)).toBeNull();
  });

  it('never calls the translator for an uncatalogued code', () => {
    const calls: string[] = [];

    resolveErrorHelp('does.not.exist', (key) => {
      calls.push(key);
      return key;
    });

    // next-intl throws (or renders the key) for a missing message, so the
    // membership check has to come first, not after.
    expect(calls).toEqual([]);
  });
});

describe('isErrorHelpCode', () => {
  it('accepts every code in the catalogue list', () => {
    for (const code of ERROR_HELP_CODES) expect(isErrorHelpCode(code)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isErrorHelpCode('store.nope')).toBe(false);
    expect(isErrorHelpCode('')).toBe(false);
    expect(isErrorHelpCode(null)).toBe(false);
  });
});
