/**
 * Desktop-only kernel environment defaults (OM-70 / #1004).
 *
 * The kernel's mDNS advertiser defaults to ON for self-hosters. Inside the
 * desktop app it is pointless (user and app share one machine) and harmful:
 * `bonjour-service` claimed the Mac's own `.local` name, macOS treated the
 * second responder as a foreign device and renamed the machine on every start
 * (`MacBook-Pro-8` → `-9` → `-10`). The desktop therefore turns it off unless
 * the user has explicitly decided otherwise in their environment.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { desktopKernelEnvDefaults } from '../src/kernelEnvDefaults.ts';
import { onLog } from '../src/log.ts';

/** Collect every WARN line emitted while `fn` runs. */
function warningsDuring(fn: () => void): string[] {
  const lines: string[] = [];
  const off = onLog((level, msg) => {
    if (level === 'WARN') lines.push(msg);
  });
  try {
    fn();
  } finally {
    off();
  }
  return lines;
}

describe('desktopKernelEnvDefaults (OM-70)', () => {
  it('turns the mDNS advertiser off when the user has not set it', () => {
    const env = desktopKernelEnvDefaults({});
    assert.equal(env.OMADIA_UI_MDNS_ENABLED, 'false');
  });

  it('respects an explicit user choice, either way', () => {
    assert.equal(
      desktopKernelEnvDefaults({ OMADIA_UI_MDNS_ENABLED: 'true' }).OMADIA_UI_MDNS_ENABLED,
      'true',
    );
    assert.equal(
      desktopKernelEnvDefaults({ OMADIA_UI_MDNS_ENABLED: 'false' }).OMADIA_UI_MDNS_ENABLED,
      'false',
    );
  });

  it('treats an empty value as unset, without a warning', () => {
    // An empty string would fail the kernel's `z.enum(['true','false'])` parse
    // and take the whole boot down; the default is the safer reading.
    let env: ReturnType<typeof desktopKernelEnvDefaults> | undefined;
    const warnings = warningsDuring(() => {
      env = desktopKernelEnvDefaults({ OMADIA_UI_MDNS_ENABLED: '' });
    });
    assert.equal(env?.OMADIA_UI_MDNS_ENABLED, 'false');
    assert.deepEqual(warnings, []);
  });

  it('coerces a typo to off but says so, so an opt-in attempt is visible', () => {
    for (const typo of ['1', 'TRUE', 'yes']) {
      let env: ReturnType<typeof desktopKernelEnvDefaults> | undefined;
      const warnings = warningsDuring(() => {
        env = desktopKernelEnvDefaults({ OMADIA_UI_MDNS_ENABLED: typo });
      });
      assert.equal(env?.OMADIA_UI_MDNS_ENABLED, 'false', `${typo} must not reach the kernel`);
      assert.equal(warnings.length, 1, `${typo} must produce exactly one warning`);
      assert.ok(warnings[0]!.includes('OMADIA_UI_MDNS_ENABLED'), warnings[0]);
      assert.ok(warnings[0]!.includes(typo), warnings[0]);
    }
  });

  it('a valid value produces no warning', () => {
    assert.deepEqual(
      warningsDuring(() => desktopKernelEnvDefaults({ OMADIA_UI_MDNS_ENABLED: 'true' })),
      [],
    );
  });

  it('does not leak anything else into the kernel env', () => {
    assert.deepEqual(Object.keys(desktopKernelEnvDefaults({ PATH: '/x' })), [
      'OMADIA_UI_MDNS_ENABLED',
    ]);
  });
});
