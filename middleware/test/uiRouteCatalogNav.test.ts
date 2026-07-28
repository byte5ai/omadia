import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';

/**
 * Nav-entry half of the UI catalogue (specs/470-dev-platform-plugin).
 *
 * The uiRoute-descriptor half is covered by uiRouteCatalog.test.ts. These
 * tests focus on what is new and what is dangerous: nav entries are
 * rendered inside the shell's own trusted header, so every field a plugin
 * supplies is treated as untrusted input.
 */

const LABEL = { en: 'Dev Platform', de: 'Dev-Plattform' } as const;

function validEntry(
  overrides: Partial<Parameters<UiRouteCatalog['registerNav']>[1]> = {},
): Parameters<UiRouteCatalog['registerNav']>[1] {
  return {
    navId: 'devPlatform',
    href: '/admin/dev-platform',
    label: LABEL,
    ...overrides,
  };
}

describe('UiRouteCatalog — nav entries', () => {
  it('round-trips an entry with pluginId injected and order defaulted', () => {
    const cat = new UiRouteCatalog();
    cat.registerNav('@plugin/dev', validEntry({ cluster: 'adminCluster' }));

    const entries = cat.listNav('en');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.pluginId, '@plugin/dev');
    assert.equal(entries[0]?.navId, 'devPlatform');
    assert.equal(entries[0]?.href, '/admin/dev-platform');
    assert.equal(entries[0]?.cluster, 'adminCluster');
    assert.equal(entries[0]?.order, 100, 'order defaults to 100');
    assert.equal(entries[0]?.label, 'Dev Platform');
  });

  it('omits cluster entirely when not supplied (top-level entry)', () => {
    const cat = new UiRouteCatalog();
    cat.registerNav('@plugin/dev', validEntry());
    assert.equal(Object.hasOwn(cat.listNav('en')[0] ?? {}, 'cluster'), false);
  });

  describe('label resolution', () => {
    it('resolves the exact locale when present', () => {
      const cat = new UiRouteCatalog();
      cat.registerNav('@plugin/dev', validEntry());
      assert.equal(cat.listNav('de')[0]?.label, 'Dev-Plattform');
    });

    it('falls back to the base language for a regional locale', () => {
      const cat = new UiRouteCatalog();
      cat.registerNav('@plugin/dev', validEntry());
      assert.equal(
        cat.listNav('de-AT')[0]?.label,
        'Dev-Plattform',
        'de-AT should fall back to de, not to en',
      );
    });

    it('falls back to en for an untranslated locale', () => {
      const cat = new UiRouteCatalog();
      cat.registerNav('@plugin/dev', validEntry());
      assert.equal(cat.listNav('fr')[0]?.label, 'Dev Platform');
    });

    it('requires an en label as the guaranteed fallback', () => {
      const cat = new UiRouteCatalog();
      assert.throws(
        () =>
          cat.registerNav('@plugin/dev', validEntry({ label: { de: 'Nur DE' } })),
        /must include an 'en' entry/,
      );
    });
  });

  describe('href confinement', () => {
    // The header is trusted chrome. A manifest must not be able to point a
    // nav entry off-origin or at a non-navigational scheme.
    const rejected: readonly [string, string][] = [
      ['//evil.example/pwn', 'protocol-relative'],
      ['/\\evil.example/pwn', 'backslash normalised to // by browsers'],
      ['https://evil.example', 'absolute URL'],
      ['javascript:alert(1)', 'scheme'],
      ['admin/dev-platform', 'relative path'],
      ['/admin/dev platform', 'whitespace'],
    ];

    for (const [href, why] of rejected) {
      it(`rejects ${JSON.stringify(href)} (${why})`, () => {
        const cat = new UiRouteCatalog();
        assert.throws(() => cat.registerNav('@p/x', validEntry({ href })), /href/);
      });
    }

    it('accepts a normal in-app path', () => {
      const cat = new UiRouteCatalog();
      assert.doesNotThrow(() =>
        cat.registerNav('@p/x', validEntry({ href: '/admin/dev-platform' })),
      );
    });
  });

  describe('label sanitisation', () => {
    it('rejects bidirectional-override characters (Trojan-Source spoofing)', () => {
      const cat = new UiRouteCatalog();
      const rtlOverride = String.fromCharCode(0x202e);
      assert.throws(
        () =>
          cat.registerNav(
            '@p/x',
            validEntry({ label: { en: `Safe${rtlOverride}nimdA` } }),
          ),
        /bidirectional-formatting/,
      );
    });

    it('rejects control characters', () => {
      const cat = new UiRouteCatalog();
      assert.throws(
        () =>
          cat.registerNav(
            '@p/x',
            validEntry({ label: { en: `Dev${String.fromCharCode(0)}Platform` } }),
          ),
        /control or bidirectional-formatting/,
      );
    });

    it('rejects an over-long label that would break the header', () => {
      const cat = new UiRouteCatalog();
      assert.throws(
        () => cat.registerNav('@p/x', validEntry({ label: { en: 'x'.repeat(41) } })),
        /exceeds 40 characters/,
      );
    });

    it('rejects an empty or whitespace-only label', () => {
      const cat = new UiRouteCatalog();
      assert.throws(
        () => cat.registerNav('@p/x', validEntry({ label: { en: '   ' } })),
        /non-empty string/,
      );
    });

    it('rejects a malformed locale key', () => {
      const cat = new UiRouteCatalog();
      assert.throws(
        () =>
          cat.registerNav(
            '@p/x',
            validEntry({ label: { en: 'OK', 'not a locale': 'x' } }),
          ),
        /is not a valid locale code/,
      );
    });
  });

  describe('field validation', () => {
    it('rejects a navId with structural characters', () => {
      const cat = new UiRouteCatalog();
      assert.throws(
        () => cat.registerNav('@p/x', validEntry({ navId: 'a::b' })),
        /navId/,
      );
    });

    it('rejects a malformed cluster key', () => {
      const cat = new UiRouteCatalog();
      assert.throws(
        () => cat.registerNav('@p/x', validEntry({ cluster: '9bad-key' })),
        /cluster/,
      );
    });

    it('rejects a non-integer order', () => {
      const cat = new UiRouteCatalog();
      assert.throws(
        () => cat.registerNav('@p/x', validEntry({ order: 1.5 })),
        /finite integer/,
      );
    });

    it('rejects an empty pluginId', () => {
      const cat = new UiRouteCatalog();
      assert.throws(() => cat.registerNav('', validEntry()), /pluginId/);
    });
  });

  it('sorts by (order asc, pluginId asc, navId asc)', () => {
    const cat = new UiRouteCatalog();
    cat.registerNav('@b/late', validEntry({ navId: 'z', href: '/z', order: 50 }));
    cat.registerNav('@a/early', validEntry({ navId: 'a', href: '/a', order: 10 }));
    cat.registerNav('@a/early', validEntry({ navId: 'b', href: '/b', order: 10 }));
    cat.registerNav('@c/default', validEntry({ navId: 'd', href: '/d' })); // 100

    assert.deepEqual(
      cat.listNav('en').map((e) => `${e.pluginId}:${e.navId}`),
      ['@a/early:a', '@a/early:b', '@b/late:z', '@c/default:d'],
    );
  });

  it('rejects a duplicate (pluginId, navId) rather than silently replacing', () => {
    const cat = new UiRouteCatalog();
    cat.registerNav('@p/x', validEntry());
    assert.throws(() => cat.registerNav('@p/x', validEntry()), /already registered/);
  });

  it('allows the same navId from two different plugins', () => {
    const cat = new UiRouteCatalog();
    cat.registerNav('@p/one', validEntry());
    assert.doesNotThrow(() => cat.registerNav('@p/two', validEntry()));
    assert.equal(cat.navSize(), 2);
  });

  describe('disposal', () => {
    it('the returned handle removes only its own entry', () => {
      const cat = new UiRouteCatalog();
      const dispose = cat.registerNav('@p/x', validEntry());
      cat.registerNav('@p/y', validEntry());
      dispose();
      assert.deepEqual(
        cat.listNav('en').map((e) => e.pluginId),
        ['@p/y'],
      );
    });

    it('a stale dispose handle does not drop a re-registered entry', () => {
      const cat = new UiRouteCatalog();
      const stale = cat.registerNav('@p/x', validEntry());
      stale();
      cat.registerNav('@p/x', validEntry({ href: '/admin/new' }));
      stale(); // the previous owner's closure, fired late
      assert.equal(cat.navSize(), 1, 're-registration survives a stale dispose');
      assert.equal(cat.listNav('en')[0]?.href, '/admin/new');
    });

    it('disposeBySource drops nav entries AND uiRoute descriptors together', () => {
      const cat = new UiRouteCatalog();
      cat.registerNav('@p/x', validEntry());
      cat.register('@p/x', { routeId: 'r', path: '/r', title: 'R' });
      cat.registerNav('@p/other', validEntry());

      const dropped = cat.disposeBySource('@p/x');

      assert.equal(dropped, 2, 'counts both surfaces');
      assert.equal(cat.navSize(), 1);
      assert.equal(cat.size(), 0);
      assert.equal(cat.listNav('en')[0]?.pluginId, '@p/other');
    });

    it('disposeBySource is a no-op for an unknown plugin', () => {
      const cat = new UiRouteCatalog();
      cat.registerNav('@p/x', validEntry());
      assert.equal(cat.disposeBySource('@p/nobody'), 0);
      assert.equal(cat.navSize(), 1);
    });
  });
});
