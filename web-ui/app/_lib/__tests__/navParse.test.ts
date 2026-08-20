import { describe, expect, it } from 'vitest';

import { parseEntries } from '../navigation';

/**
 * The shell re-applies the middleware's nav rules rather than trusting them
 * to have run. The middleware is the enforcement point, but it is a
 * separate deployable — version skew, a partial rollout, or a compromised
 * control plane must not be able to put an off-origin link or
 * header-breaking chrome into the trusted header.
 */

const ok = {
  pluginId: 'core:dev-platform',
  navId: 'devPlatform',
  href: '/admin/dev-platform',
  label: 'Dev Platform',
  order: 50,
  cluster: 'adminCluster',
};

const wrap = (...entries: unknown[]): unknown => ({ locale: 'en', entries });

describe('parseEntries', () => {
  it('accepts a well-formed entry', () => {
    expect(parseEntries(wrap(ok))).toEqual([ok]);
  });

  it('returns empty for malformed envelopes', () => {
    expect(parseEntries(null)).toEqual([]);
    expect(parseEntries({})).toEqual([]);
    expect(parseEntries({ entries: 'nope' })).toEqual([]);
    expect(parseEntries(wrap(null, 42, 'x'))).toEqual([]);
  });

  it('drops entries with missing or mistyped required fields', () => {
    expect(parseEntries(wrap({ ...ok, href: undefined }))).toEqual([]);
    expect(parseEntries(wrap({ ...ok, label: 123 }))).toEqual([]);
    expect(parseEntries(wrap({ ...ok, pluginId: null }))).toEqual([]);
    expect(parseEntries(wrap({ ...ok, cluster: 7 }))).toEqual([]);
  });

  it('drops off-origin and non-canonical hrefs', () => {
    for (const href of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/x/%2e%2e/admin',
      '/x/../admin',
      '/admin/',
      '/admin?a=1',
      '/admin#x',
      `/${'a'.repeat(300)}`,
    ]) {
      expect(parseEntries(wrap({ ...ok, href })), href).toEqual([]);
    }
  });

  it('drops labels that could spoof or break the header', () => {
    const cases = [
      '',
      '   ',
      'x'.repeat(41),
      `Safe${String.fromCharCode(0x202e)}nimdA`, // RTL override
      `Ad${String.fromCharCode(0x200b)}min`, // zero-width space
      `Dev${String.fromCharCode(0)}Platform`, // NUL
    ];
    for (const label of cases) {
      expect(parseEntries(wrap({ ...ok, label })), JSON.stringify(label)).toEqual(
        [],
      );
    }
  });

  it('normalises a non-finite order rather than poisoning the sort', () => {
    // JSON.parse('{"order":1e400}') yields Infinity, which is a number and
    // would make every comparison in the merge sort return NaN-ish results.
    const infinite = JSON.parse('{"order":1e400}') as { order: number };
    expect(infinite.order).toBe(Infinity);
    const parsed = parseEntries(wrap({ ...ok, order: infinite.order }));
    expect(parsed[0]?.order).toBe(100);
  });

  it('defaults a missing order instead of dropping the entry', () => {
    const noOrder: Partial<typeof ok> = { ...ok };
    delete noOrder.order;
    expect(parseEntries(wrap(noOrder))[0]?.order).toBe(100);
  });

  it('omits cluster when absent rather than emitting undefined', () => {
    const noCluster: Partial<typeof ok> = { ...ok };
    delete noCluster.cluster;
    expect(Object.hasOwn(parseEntries(wrap(noCluster))[0] ?? {}, 'cluster')).toBe(
      false,
    );
  });

  it('caps how many entries it will accept', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      ...ok,
      navId: `n${String(i)}`,
      href: `/p${String(i)}`,
    }));
    expect(parseEntries(wrap(...many))).toHaveLength(100);
  });

  it('keeps the good entries when one is malformed', () => {
    const parsed = parseEntries(wrap(ok, { ...ok, href: '//evil.example' }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.href).toBe('/admin/dev-platform');
  });
});

/**
 * #798 — plugin-UI nav entries.
 *
 * A scoped plugin id only resolves percent-encoded, and percent-encoding is
 * exactly what the canonical-href rule above refuses. So the middleware flags
 * such an entry with `pluginUi: true` and this file DERIVES the href from
 * `pluginId` instead of validating the transmitted string.
 *
 * That is deliberately stronger than validating would have been: the only
 * encoded path this module can emit is one it computed itself from a
 * charset-checked id, so a version skew or a compromised control plane still
 * cannot inject an arbitrary encoded path into the trusted header.
 *
 * Mutation check: making the parser trust the incoming `href` for a
 * `pluginUi` entry fails "ignores the transmitted href".
 */
describe('parseEntries — pluginUi entries (#798)', () => {
  const pluginUiEntry = {
    pluginId: '@acme/widget',
    navId: 'main',
    href: '/plugin-ui/%40acme%2Fwidget',
    label: 'Reports',
    order: 50,
    cluster: 'adminCluster',
    pluginUi: true,
  };

  it('accepts a scoped-id entry the canonical-href rule would reject', () => {
    const parsed = parseEntries(wrap(pluginUiEntry));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.href).toBe('/plugin-ui/%40acme%2Fwidget');
    expect(parsed[0]?.pluginId).toBe('@acme/widget');
    expect(parsed[0]?.cluster).toBe('adminCluster');
  });

  it('rejects that same href when the entry is NOT flagged pluginUi', () => {
    // The strict rule is untouched for literal hrefs — the flag is the only
    // thing that admits percent-encoding, and only for a path core computes.
    expect(
      parseEntries(wrap({ ...pluginUiEntry, pluginUi: undefined })),
    ).toEqual([]);
  });

  it('ignores the transmitted href and derives it from pluginId', () => {
    const parsed = parseEntries(
      wrap({ ...pluginUiEntry, href: '/admin/somewhere-else' }),
    );
    expect(parsed[0]?.href).toBe('/plugin-ui/%40acme%2Fwidget');
  });

  it('leaves an unscoped id unencoded', () => {
    const parsed = parseEntries(
      wrap({ ...pluginUiEntry, pluginId: 'reporter' }),
    );
    expect(parsed[0]?.href).toBe('/plugin-ui/reporter');
  });

  it('drops an entry whose pluginId is not an npm-style id', () => {
    for (const pluginId of ['../etc', 'Has Spaces', '@acme/UPPER', 'a/b/c']) {
      expect(parseEntries(wrap({ ...pluginUiEntry, pluginId }))).toEqual([]);
    }
  });

  it('drops a pluginUi value that is not literal true', () => {
    for (const pluginUi of ['yes', 1, {}, false]) {
      expect(parseEntries(wrap({ ...pluginUiEntry, pluginUi }))).toEqual([]);
    }
  });

  it('still enforces the label rules on a pluginUi entry', () => {
    expect(
      parseEntries(wrap({ ...pluginUiEntry, label: 'x'.repeat(41) })),
    ).toEqual([]);
    expect(
      parseEntries(wrap({ ...pluginUiEntry, label: 'Rep\u202eorts' })),
    ).toEqual([]);
  });
});
