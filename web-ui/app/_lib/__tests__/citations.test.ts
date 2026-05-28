import { describe, expect, it } from 'vitest';

import { stripCitationMarkers } from '../citations';

describe('stripCitationMarkers (#131)', () => {
  it('removes a single inline citation marker', () => {
    expect(
      stripCitationMarkers('Foo is a senior dev [ref:n_user_42].'),
    ).toBe('Foo is a senior dev.');
  });

  it('removes multiple markers in one string', () => {
    expect(
      stripCitationMarkers(
        'A [ref:n_a] and B [ref:n_b] and C [ref:n_c].',
      ),
    ).toBe('A and B and C.');
  });

  it('accepts node ids with hyphens, underscores and digits', () => {
    expect(
      stripCitationMarkers('Result [ref:confluence-page-89].'),
    ).toBe('Result.');
    expect(stripCitationMarkers('Result [ref:n_42-foo_bar].')).toBe(
      'Result.',
    );
  });

  it('is a no-op when no markers are present', () => {
    const src = 'Plain prose without any marker.';
    expect(stripCitationMarkers(src)).toBe(src);
  });

  it('is idempotent', () => {
    const src = 'Foo [ref:n_42] and bar [ref:n_99].';
    const once = stripCitationMarkers(src);
    expect(stripCitationMarkers(once)).toBe(once);
  });

  it('leaves bracketed text without the `ref:` prefix untouched', () => {
    const src = 'See [docs] and [example].';
    expect(stripCitationMarkers(src)).toBe(src);
  });
});
