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

type WithKernelEnv = { kernelEnv(port: number): NodeJS.ProcessEnv };

function kernelEnv(): NodeJS.ProcessEnv {
  return (new Supervisor() as unknown as WithKernelEnv).kernelEnv(8769);
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
