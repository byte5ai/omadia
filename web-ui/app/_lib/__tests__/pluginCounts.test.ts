import { describe, expect, it } from 'vitest';

import {
  countReadiness,
  isInstalled,
  isOperatorInstalled,
  isReady,
} from '../pluginCounts';
import type {
  Plugin,
  PluginInstallOrigin,
  PluginInstallState,
  PluginReadiness,
} from '../storeTypes';

type Countable = Pick<
  Plugin,
  'install_state' | 'readiness' | 'source' | 'install_origin'
>;

function o(
  install_state: PluginInstallState,
  install_origin?: PluginInstallOrigin,
): Countable {
  return {
    install_state,
    ...(install_origin ? { install_origin } : {}),
  } as Countable;
}

function p(
  install_state: PluginInstallState,
  readiness?: PluginReadiness,
  source?: Plugin['source'],
): Countable {
  return {
    install_state,
    ...(readiness ? { readiness } : {}),
    ...(source ? { source } : {}),
  } as Countable;
}

const READY: PluginReadiness = {
  state: 'ready',
  missing_fields: [],
  verified_at: '2026-03-03T09:00:00.000Z',
};
const CONFIG_REQUIRED: PluginReadiness = {
  state: 'config_required',
  missing_fields: ['api_key'],
  verified_at: null,
};
const ERRORED: PluginReadiness = {
  state: 'errored',
  missing_fields: [],
  verified_at: null,
};

describe('isInstalled (OM-27)', () => {
  it('counts update-available as installed', () => {
    // The store tab used to test `=== "installed"` only, so a plugin with a
    // pending update dropped out of the installed count entirely.
    expect(isInstalled(p('update-available'))).toBe(true);
    expect(isInstalled(p('installed'))).toBe(true);
  });

  it('does not count available or incompatible', () => {
    expect(isInstalled(p('available'))).toBe(false);
    expect(isInstalled(p('incompatible'))).toBe(false);
  });

  it('agrees across all three former call sites for the same catalog', () => {
    const catalog = [
      p('installed'),
      p('update-available'),
      p('available'),
      p('incompatible'),
    ];
    // dashboard's former filter
    const dashboard = catalog.filter(
      (x) =>
        x.install_state === 'installed' ||
        x.install_state === 'update-available',
    ).length;
    // store tab's former (buggy) filter
    const storeTab = catalog.filter((x) => x.install_state === 'installed')
      .length;

    expect(dashboard).toBe(2);
    expect(storeTab).toBe(1); // the drift this module removes
    expect(catalog.filter(isInstalled).length).toBe(dashboard);
  });
});

describe('store "Lokal" vs "Installiert" bucketing (OM-27)', () => {
  // Reproduces the store page's partition with the shared predicate.
  function bucket(plugins: Countable[]) {
    return {
      hub: plugins.filter((x) => x.source != null),
      installed: plugins.filter(isInstalled),
      local: plugins.filter((x) => x.source == null && !isInstalled(x)),
    };
  }

  it('a locally-catalogued update-available plugin lands in Installiert, not Lokal', () => {
    const pending = p('update-available');
    const b = bucket([pending, p('available')]);
    expect(b.installed).toContain(pending);
    expect(b.local).not.toContain(pending);
    expect(b.local).toHaveLength(1);
  });

  it('every plugin lands in exactly one of installed/local when there is no hub source', () => {
    const plugins = [
      p('installed'),
      p('update-available'),
      p('available'),
      p('incompatible'),
    ];
    const b = bucket(plugins);
    expect(b.installed.length + b.local.length).toBe(plugins.length);
  });
});

describe('isReady (OM-16)', () => {
  it('is false for an installed plugin whose required config is missing', () => {
    expect(isReady(p('installed', CONFIG_REQUIRED))).toBe(false);
  });

  it('is false for an errored plugin', () => {
    expect(isReady(p('installed', ERRORED))).toBe(false);
  });

  it('is true for an installed, ready plugin', () => {
    expect(isReady(p('installed', READY))).toBe(true);
    expect(isReady(p('update-available', READY))).toBe(true);
  });

  it('is false for a plugin that is not installed at all', () => {
    expect(isReady(p('available', READY))).toBe(false);
  });

  it('falls back to installed when readiness is absent (pre-OM-16 middleware)', () => {
    expect(isReady(p('installed'))).toBe(true);
    expect(isReady(p('available'))).toBe(false);
  });
});

describe('countReadiness', () => {
  it('reports installed and ready separately', () => {
    const counts = countReadiness([
      p('installed', READY),
      p('update-available', READY),
      p('installed', CONFIG_REQUIRED),
      p('installed', ERRORED),
      p('available', READY),
    ]);
    expect(counts).toEqual({ installed: 4, ready: 2 });
  });

  it('is zero/zero for an empty catalog', () => {
    expect(countReadiness([])).toEqual({ installed: 0, ready: 0 });
  });
});


describe('isOperatorInstalled (#1089)', () => {
  it('counts an operator install and not a bundled one', () => {
    // The whole bug in two lines: a fresh Compose deployment holds 16 entries
    // the kernel wrote at boot, and the onboarding step read them as work the
    // operator had done.
    expect(isOperatorInstalled(o('installed', 'operator'))).toBe(true);
    expect(isOperatorInstalled(o('installed', 'bundled'))).toBe(false);
  });

  it('counts update-available the same way isInstalled does', () => {
    expect(isOperatorInstalled(o('update-available', 'operator'))).toBe(true);
    expect(isOperatorInstalled(o('update-available', 'bundled'))).toBe(false);
  });

  it('never counts a plugin that is not installed at all', () => {
    expect(isOperatorInstalled(o('available', 'operator'))).toBe(false);
    expect(isOperatorInstalled(o('incompatible', 'operator'))).toBe(false);
  });

  it('falls back to isInstalled when the server sends no origin', () => {
    // An older middleware omits the field. Reporting "nothing installed" there
    // would be a worse lie than the pre-ticked step: it would pop the profile
    // modal over a fully configured deployment.
    expect(isOperatorInstalled(o('installed'))).toBe(true);
    expect(isOperatorInstalled(o('update-available'))).toBe(true);
    expect(isOperatorInstalled(o('available'))).toBe(false);
  });

  it('leaves isInstalled alone — the health tile still counts built-ins', () => {
    const catalog = [
      o('installed', 'bundled'),
      o('installed', 'bundled'),
      o('installed', 'operator'),
      o('available'),
    ];
    expect(catalog.filter(isInstalled).length).toBe(3);
    expect(catalog.filter(isOperatorInstalled).length).toBe(1);
  });
});
