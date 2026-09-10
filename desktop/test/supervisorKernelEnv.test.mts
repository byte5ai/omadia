/**
 * The kernel the desktop spawns must not advertise over mDNS (OM-70 / #1004).
 *
 * `desktopKernelEnvDefaults` is tested on its own; this pins the WIRING, i.e.
 * that `Supervisor.kernelEnv()` actually spreads those defaults into the env
 * handed to `spawn`. Dropping the spread leaves the pure helper green and this
 * red. Reaching into the private method follows `supervisorRestartRace.test`:
 * a boot to the real `spawn` needs port 8769 free and a health endpoint, which
 * a unit test cannot promise.
 */
import { describe, it, afterEach, before } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Supervisor } from '../src/supervisor.ts';

before(() => {
  // `paths.ts` is compiled to CommonJS for the app and reads `__dirname` to
  // find the repo root in dev mode. Under the ESM test loader that global does
  // not exist, so give it the same answer the compiled `dist/` would have.
  (globalThis as { __dirname?: string }).__dirname = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
  );
});

type WithKernelEnv = {
  kernelEnv(port: number, uiPort: number): NodeJS.ProcessEnv;
};

/** The web-ui port is allocated per launch; any value proves the wiring. */
const UI_PORT = 51_234;

function kernelEnv(uiPort = UI_PORT): NodeJS.ProcessEnv {
  return (new Supervisor() as unknown as WithKernelEnv).kernelEnv(8769, uiPort);
}

const saved = process.env['OMADIA_UI_MDNS_ENABLED'];
afterEach(() => {
  if (saved === undefined) delete process.env['OMADIA_UI_MDNS_ENABLED'];
  else process.env['OMADIA_UI_MDNS_ENABLED'] = saved;
});

describe('Supervisor.kernelEnv mDNS wiring (OM-70)', () => {
  it('hands the kernel OMADIA_UI_MDNS_ENABLED=false by default', () => {
    delete process.env['OMADIA_UI_MDNS_ENABLED'];
    const env = kernelEnv();
    assert.equal(env['OMADIA_UI_MDNS_ENABLED'], 'false');
    // Sanity: this is the real kernel env, not a partial object.
    assert.equal(env['PORT'], '8769');
    assert.equal(env['HOST'], '127.0.0.1');
  });

  it("keeps the user's explicit opt-in", () => {
    process.env['OMADIA_UI_MDNS_ENABLED'] = 'true';
    assert.equal(kernelEnv()['OMADIA_UI_MDNS_ENABLED'], 'true');
  });
});

/**
 * OM-90 — `/api/v1/auth/login` redirected to `http://localhost:3979/login`,
 * the kernel config's default `PUBLIC_BASE_URL`. Nothing in the desktop app
 * listens on 3979: the kernel binds 8769 and the web-ui gets a fresh port on
 * every launch, so the login redirect landed on a dead port.
 */
describe('Supervisor.kernelEnv login-redirect base (OM-90)', () => {
  it('points PUBLIC_BASE_URL at the web-ui port, not the kernel port', () => {
    const env = kernelEnv();
    assert.equal(env['PUBLIC_BASE_URL'], `http://127.0.0.1:${UI_PORT}`);
    // The distinction is the whole point: a redirect to the kernel's own port
    // reaches a live server that serves no login page.
    assert.notEqual(env['PUBLIC_BASE_URL'], env['DIAGRAM_PUBLIC_BASE_URL']);
    assert.equal(env['DIAGRAM_PUBLIC_BASE_URL'], 'http://127.0.0.1:8769');
  });

  it('never leaves the kernel on its 3979 default', () => {
    assert.ok(!kernelEnv()['PUBLIC_BASE_URL']?.includes('3979'));
  });

  it('keeps the Entra OAuth callback on the kernel', () => {
    // `PUBLIC_BASE_URL` has a second reader: the kernel derives the callback
    // from it. `/api/v1/*` is NOT proxied by the web-ui, so without this
    // override the fix above would trade a dead login redirect for a dead
    // OAuth callback.
    assert.equal(
      kernelEnv()['AUTH_REDIRECT_URI'],
      'http://127.0.0.1:8769/api/v1/auth/login/entra/cb',
    );
  });

  it('follows the port it is given, launch to launch', () => {
    assert.equal(kernelEnv(40_001)['PUBLIC_BASE_URL'], 'http://127.0.0.1:40001');
    assert.equal(kernelEnv(40_002)['PUBLIC_BASE_URL'], 'http://127.0.0.1:40002');
  });

  it('wins over a stale inherited PUBLIC_BASE_URL', () => {
    // `...process.env` is spread first; a value left over from a previous run
    // or a user shell must not survive into this launch.
    const saved = process.env['PUBLIC_BASE_URL'];
    process.env['PUBLIC_BASE_URL'] = 'http://localhost:3979';
    try {
      assert.equal(kernelEnv()['PUBLIC_BASE_URL'], `http://127.0.0.1:${UI_PORT}`);
    } finally {
      if (saved === undefined) delete process.env['PUBLIC_BASE_URL'];
      else process.env['PUBLIC_BASE_URL'] = saved;
    }
  });
});
