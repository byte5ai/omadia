/**
 * Operator authorisation for the first-user wizard (`auth/setupToken.ts`).
 *
 * The policy is small but it decides who can become admin of a fresh
 * install, so each branch is pinned — above all the exemption: ONLY the
 * desktop supervisor's explicit flag together with a literal loopback bind
 * skips the token. Either half alone does not, and no request header or
 * public URL is ever consulted.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  generateSetupToken,
  initSetupToken,
  isDesktopLoopbackKernel,
  resolveSetupTokenPolicy,
  setupTokenMatches,
  type SetupTokenPolicyInput,
  type SetupTokenStore,
} from '../../src/auth/setupToken.js';

const OPEN: SetupTokenPolicyInput = {
  configured: undefined,
  setupRequired: true,
  desktopEmbedded: false,
  host: '::',
};

describe('resolveSetupTokenPolicy', () => {
  it('an operator-configured token always wins', () => {
    for (const input of [
      OPEN,
      { ...OPEN, setupRequired: false },
      { ...OPEN, desktopEmbedded: true, host: '127.0.0.1' },
    ]) {
      assert.deepEqual(
        resolveSetupTokenPolicy({ ...input, configured: 'operator-chosen-token-123' }),
        { kind: 'env', token: 'operator-chosen-token-123' },
      );
    }
  });

  it('no wizard on this boot → no token needed', () => {
    assert.deepEqual(resolveSetupTokenPolicy({ ...OPEN, setupRequired: false }), {
      kind: 'not_needed',
    });
  });

  it('the desktop kernel (flag + literal loopback bind) is exempt', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
      assert.deepEqual(
        resolveSetupTokenPolicy({ ...OPEN, desktopEmbedded: true, host }),
        { kind: 'desktop_exempt' },
        host,
      );
    }
  });

  it('the desktop flag WITHOUT a loopback bind still requires a token', () => {
    for (const host of ['::', '0.0.0.0', '10.0.0.5', '192.168.1.20', 'localhost', 'omadia.example.com']) {
      assert.deepEqual(
        resolveSetupTokenPolicy({ ...OPEN, desktopEmbedded: true, host }),
        { kind: 'generate' },
        host,
      );
    }
  });

  it('a loopback bind WITHOUT the desktop flag still requires a token', () => {
    // A same-host reverse proxy in front of a 127.0.0.1-bound kernel makes it
    // public; the bind address alone proves nothing about who can reach it.
    for (const host of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.deepEqual(resolveSetupTokenPolicy({ ...OPEN, host }), { kind: 'generate' }, host);
    }
  });

  it('servers generate a token', () => {
    assert.deepEqual(resolveSetupTokenPolicy(OPEN), { kind: 'generate' });
  });

  it('isDesktopLoopbackKernel needs both halves', () => {
    assert.equal(isDesktopLoopbackKernel({ desktopEmbedded: true, host: '127.0.0.1' }), true);
    assert.equal(isDesktopLoopbackKernel({ desktopEmbedded: false, host: '127.0.0.1' }), false);
    assert.equal(isDesktopLoopbackKernel({ desktopEmbedded: true, host: '::' }), false);
  });
});

describe('generateSetupToken', () => {
  it('is base64url, 32 characters, and fresh every call', () => {
    const a = generateSetupToken();
    const b = generateSetupToken();
    assert.match(a, /^[A-Za-z0-9_-]{32}$/);
    assert.match(b, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(a, b);
  });
});

describe('setupTokenMatches', () => {
  const expected = 'test-token-0123456789abcdef';

  it('accepts exactly the expected value', () => {
    assert.equal(setupTokenMatches(expected, expected), true);
  });

  it('refuses everything else', () => {
    for (const received of [
      undefined,
      null,
      42,
      [expected],
      { token: expected },
      '',
      expected.slice(0, -1),
      `${expected}x`,
      expected.toUpperCase(),
      ` ${expected}`,
      'x'.repeat(10_000),
    ]) {
      assert.equal(setupTokenMatches(expected, received), false, JSON.stringify(received)?.slice(0, 40));
    }
  });
});

/** In-memory stand-in for the platform_settings row. */
class MemoryTokenStore implements SetupTokenStore {
  stored: string | undefined;
  claims: string[] = [];
  clears = 0;
  failClaim: Error | undefined;

  async claim(candidate: string): Promise<string> {
    this.claims.push(candidate);
    if (this.failClaim) throw this.failClaim;
    this.stored ??= candidate;
    return this.stored;
  }

  async clear(): Promise<void> {
    this.clears += 1;
    this.stored = undefined;
  }
}

describe('initSetupToken (boot wiring)', () => {
  it('generated: persists the token, logs it exactly once, and gates the wizard with it', async () => {
    const store = new MemoryTokenStore();
    const logs: string[] = [];
    let generated = 0;
    const boot = await initSetupToken({
      ...OPEN,
      store,
      generate: () => {
        generated += 1;
        return 'generated-token-0123456789abcdef';
      },
      log: (m) => logs.push(m),
    });
    assert.deepEqual(boot, { token: 'generated-token-0123456789abcdef', source: 'generated' });
    assert.equal(generated, 1);
    assert.deepEqual(store.claims, ['generated-token-0123456789abcdef']);
    const tokenLines = logs.filter((l) => l.includes('generated-token-0123456789abcdef'));
    assert.equal(tokenLines.length, 1, logs.join('\n'));
    assert.match(tokenLines[0] ?? '', /setup token: generated-token-0123456789abcdef/);
  });

  it('generated: a token another replica already stored wins over this boot’s candidate', async () => {
    const store = new MemoryTokenStore();
    store.stored = 'replica-a-token-0123456789abcdef';
    const logs: string[] = [];
    const boot = await initSetupToken({
      ...OPEN,
      store,
      generate: () => 'replica-b-candidate-0123456789ab',
      log: (m) => logs.push(m),
    });
    assert.equal(boot.token, 'replica-a-token-0123456789abcdef');
    assert.ok(logs.some((l) => l.includes('replica-a-token-0123456789abcdef')));
    assert.ok(!logs.some((l) => l.includes('replica-b-candidate')), 'the losing candidate is never shown');
  });

  it('generated: a store failure still gates the wizard, with a replica-local token', async () => {
    const store = new MemoryTokenStore();
    store.failClaim = new Error('platform_settings unavailable');
    const logs: string[] = [];
    const boot = await initSetupToken({
      ...OPEN,
      store,
      generate: () => 'local-only-token-0123456789abcde',
      log: (m) => logs.push(m),
    });
    assert.deepEqual(boot, { token: 'local-only-token-0123456789abcde', source: 'generated' });
    assert.ok(logs.some((l) => /this replica only/.test(l)), logs.join('\n'));
  });

  it('env: gates with the configured token and never prints it', async () => {
    const store = new MemoryTokenStore();
    const logs: string[] = [];
    const boot = await initSetupToken({
      ...OPEN,
      configured: 'operator-chosen-token-123',
      store,
      log: (m) => logs.push(m),
    });
    assert.deepEqual(boot, { token: 'operator-chosen-token-123', source: 'env' });
    assert.ok(!logs.some((l) => l.includes('operator-chosen-token-123')));
    assert.ok(logs.some((l) => l.includes('ADMIN_SETUP_TOKEN')));
    assert.deepEqual(store.claims, [], 'an operator token is never persisted');
  });

  it('desktop exempt: no token, nothing persisted', async () => {
    const store = new MemoryTokenStore();
    const boot = await initSetupToken({
      ...OPEN,
      desktopEmbedded: true,
      host: '127.0.0.1',
      store,
      log: () => undefined,
    });
    assert.deepEqual(boot, { token: undefined, source: 'desktop_exempt' });
    assert.deepEqual(store.claims, []);
  });

  it('not needed: clears a token left over from a finished setup', async () => {
    const store = new MemoryTokenStore();
    store.stored = 'leftover-token-0123456789abcdef';
    const boot = await initSetupToken({ ...OPEN, setupRequired: false, store, log: () => undefined });
    assert.deepEqual(boot, { token: undefined, source: 'not_needed' });
    assert.equal(store.clears, 1);
    assert.equal(store.stored, undefined);
  });
});

/**
 * `config` is parsed once at import, so each case loads `src/config.ts` in a
 * fresh child process with a controlled environment.
 */
describe('config: ADMIN_SETUP_TOKEN and OMADIA_DESKTOP_EMBEDDED', () => {
  const CONFIG_URL = pathToFileURL(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'config.ts'),
  ).href;

  function loadConfig(env: Record<string, string>): { ok: boolean; output: string } {
    const script =
      `const { config } = await import(${JSON.stringify(CONFIG_URL)});` +
      'console.log(JSON.stringify({ token: config.ADMIN_SETUP_TOKEN ?? null, desktop: config.OMADIA_DESKTOP_EMBEDDED }));';
    const base = { ...process.env };
    delete base['ADMIN_SETUP_TOKEN'];
    delete base['OMADIA_DESKTOP_EMBEDDED'];
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 },
    );
    return { ok: res.status === 0, output: `${res.stdout}${res.stderr}` };
  }

  it('an empty ADMIN_SETUP_TOKEN= line means unset instead of failing boot', () => {
    const res = loadConfig({ ADMIN_SETUP_TOKEN: '' });
    assert.equal(res.ok, true, res.output);
    assert.match(res.output, /"token":null/);
    assert.match(res.output, /"desktop":false/, 'the desktop exemption is off by default');
  });

  it('a token shorter than 16 characters fails boot and names the variable', () => {
    const res = loadConfig({ ADMIN_SETUP_TOKEN: 'too-short' });
    assert.equal(res.ok, false);
    assert.match(res.output, /ADMIN_SETUP_TOKEN/);
  });

  it('a token longer than the matcher accepts fails boot instead of never matching', () => {
    const res = loadConfig({ ADMIN_SETUP_TOKEN: 'x'.repeat(513) });
    assert.equal(res.ok, false);
    assert.match(res.output, /ADMIN_SETUP_TOKEN/);
  });

  it('a valid token and the desktop flag parse through', () => {
    const res = loadConfig({
      ADMIN_SETUP_TOKEN: 'operator-chosen-token-123',
      OMADIA_DESKTOP_EMBEDDED: 'true',
    });
    assert.equal(res.ok, true, res.output);
    assert.match(res.output, /"token":"operator-chosen-token-123"/);
    assert.match(res.output, /"desktop":true/);
  });
});
