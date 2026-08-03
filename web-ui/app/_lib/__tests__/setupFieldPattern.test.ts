import { describe, expect, it } from 'vitest';

import {
  anchorPatternSource,
  isPatternUsable,
  nativePatternAttribute,
  screenPatternSource,
  violatesSetupPattern,
} from '../setupFieldPattern';

/**
 * OM-17 — the CLIENT half must agree with
 * `middleware/src/plugins/setupFieldPattern.ts` on three things. Each of the
 * three was a real, executed defect:
 *
 *   F1 the safety screen was a bypassable blacklist,
 *   F3 only the client skipped empty values,
 *   F4 only the client was anchored.
 *
 * The server file carries the same test cases; if you change one, change both.
 */

/** Executed against the OLD blacklist screen — every row PASSED it. */
const REDOS_BYPASSES = [
  '^(a+)+$',
  '^(a|a)+$',
  '^(a|a)*$',
  '^((a+))+$',
  '^(a|ab)*c$',
  '^(?:a|a)+$',
];

/** The two shapes this feature exists for. */
const SA_EMAIL = '^[^@\\s]+@[^@\\s]+\\.iam\\.gserviceaccount\\.com$';
const PEM_PREFIX = '^-----BEGIN [A-Z ]*PRIVATE KEY-----';

describe('F1 — the client screen is an allowlist, not a bypassable blacklist', () => {
  it.each(REDOS_BYPASSES)('rejects %s', (pattern) => {
    // This code runs in the operator's browser on every keystroke, and a
    // browser has no worker-thread execution bound to fall back on — the
    // grammar is the ONLY defence on this side.
    expect(screenPatternSource(pattern)).not.toBeNull();
    expect(isPatternUsable(pattern)).toBe(false);
  });

  it.each([SA_EMAIL, PEM_PREFIX])('accepts the realistic pattern %s', (p) => {
    expect(screenPatternSource(p)).toBeNull();
    expect(isPatternUsable(p)).toBe(true);
  });

  it('accepts unquantified alternation but rejects quantified alternation', () => {
    expect(screenPatternSource('^(?:prod|dev)$')).toBeNull();
    expect(screenPatternSource('^(?:prod|dev)+$')).not.toBeNull();
  });

  it('a refused pattern does not block the value — it just goes unchecked', () => {
    // Fail-open matches the server. The operator learns about it from the
    // `pattern_unavailable` warning, not from a mystery rejection.
    expect(violatesSetupPattern({ pattern: '^(a|a)+$' }, 'anything')).toBe(false);
  });
});

describe('F3 — an empty value is "not set", never a pattern violation', () => {
  it('never flags an empty value', () => {
    // The reported failure: only the client skipped empty values, so an
    // OPTIONAL patterned field could never be cleared — no client error, then
    // a 400 from the server. Both halves now skip; `required` is separate.
    expect(violatesSetupPattern({ pattern: '^sk-[A-Za-z0-9]+$' }, '')).toBe(false);
  });

  it('still flags a non-empty value that does not match', () => {
    expect(violatesSetupPattern({ pattern: '^sk-[A-Za-z0-9]+$' }, 'hunter2')).toBe(
      true,
    );
  });
});

describe('F4 — anchoring agrees with the server and with HTML `pattern=`', () => {
  it('"my password is 1234" fails [0-9]{4}', () => {
    expect(violatesSetupPattern({ pattern: '[0-9]{4}' }, 'my password is 1234')).toBe(
      true,
    );
    expect(violatesSetupPattern({ pattern: '[0-9]{4}' }, '1234')).toBe(false);
  });

  it('wraps only a pattern that carries no anchor of its own', () => {
    expect(anchorPatternSource('[0-9]{4}')).toBe('^(?:[0-9]{4})$');
    expect(anchorPatternSource(PEM_PREFIX)).toBe(PEM_PREFIX);
    expect(anchorPatternSource('^abc$')).toBe('^abc$');
    expect(anchorPatternSource('abc\\$')).toBe('^(?:abc\\$)$');
  });

  it('a PEM prefix pattern still accepts a real multi-line key', () => {
    const pem = `${PEM_PREFIX.slice(1).replace('[A-Z ]*', '')}\nMIIEvQIBADANBg\n`;
    expect(violatesSetupPattern({ pattern: PEM_PREFIX }, pem)).toBe(false);
  });

  it('emits no native pattern= attribute for a HALF-anchored pattern', () => {
    // The browser always anchors the attribute as `^(?:…)$`, which is STRICTER
    // than what the server enforces for a prefix check — it would block the
    // submit of every real multi-line PEM block. Both-anchors and no-anchors
    // agree with the server exactly, so those still get the attribute.
    expect(nativePatternAttribute(PEM_PREFIX)).toBeUndefined();
    expect(nativePatternAttribute('[0-9]{4}')).toBe('[0-9]{4}');
    expect(nativePatternAttribute(SA_EMAIL)).toBe(SA_EMAIL);
    expect(nativePatternAttribute('abc$')).toBeUndefined();
    expect(nativePatternAttribute('^(a|a)+$')).toBeUndefined();
    expect(nativePatternAttribute(undefined)).toBeUndefined();
  });
});
