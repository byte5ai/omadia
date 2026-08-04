import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Epic #470 C3 — the two credential-exposing modes must still REFUSE BOOT after
 * the dev-platform config keys were collapsed into `config.devPlatform`.
 *
 * `devPlatformBootRefusals` is unit-tested directly in devPlatform.e2e.test.ts.
 * That proves the function; it does NOT prove the function is still WIRED into
 * `loadConfig`, which is exactly what a config refactor can silently break — and
 * the failure mode is a middleware that boots happily with the operator's Claude
 * credential inside a runner, or an agent running as root.
 *
 * So this drives the real module: import `src/config.ts` in a child process with
 * the dangerous env set, and assert the process dies with the message. Nothing is
 * stubbed; the refusal either fires at import or the test fails.
 */

const middlewareRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const configEntry = resolve(middlewareRoot, 'src', 'config.ts');

/** Import `src/config.ts` in a child process with `env` and return what happened. */
async function importConfigWith(env: Record<string, string>): Promise<{
  ok: boolean;
  output: string;
}> {
  try {
    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(configEntry)});`],
      {
        cwd: middlewareRoot,
        // A clean env: only PATH (tsx needs node) plus what the case under test sets.
        // Nothing else can accidentally satisfy — or trip — a refusal.
        env: { PATH: process.env['PATH'] ?? '', ...env },
      },
    );
    return { ok: true, output: '' };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, output: `${e.stderr ?? ''}${e.stdout ?? ''}${e.message ?? ''}` };
  }
}

describe('dev-platform boot refusals are still wired into loadConfig (epic #470 C3)', () => {
  it('refuses to boot on DEV_PLATFORM_SUBSCRIPTION_MODE without DEV_PLATFORM_SUBSCRIPTION_ACK', async () => {
    const res = await importConfigWith({ DEV_PLATFORM_SUBSCRIPTION_MODE: 'true' });
    assert.equal(res.ok, false, 'importing config must throw, not boot');
    assert.match(res.output, /Invalid configuration/);
    assert.match(
      res.output,
      /DEV_PLATFORM_SUBSCRIPTION_MODE=true requires DEV_PLATFORM_SUBSCRIPTION_ACK to be set/,
    );
  });

  it('boots once the subscription acknowledgment is supplied', async () => {
    const res = await importConfigWith({
      DEV_PLATFORM_SUBSCRIPTION_MODE: 'true',
      DEV_PLATFORM_SUBSCRIPTION_ACK: 'I understand',
    });
    assert.equal(res.ok, true, `config should load; got: ${res.output}`);
  });

  it('refuses to boot on DEV_PLATFORM_UNSAFE_LOCAL without DEV_PLATFORM_LOCAL_UID', async () => {
    const res = await importConfigWith({ DEV_PLATFORM_UNSAFE_LOCAL: 'true' });
    assert.equal(res.ok, false, 'importing config must throw, not boot');
    assert.match(res.output, /Invalid configuration/);
    assert.match(res.output, /DEV_PLATFORM_UNSAFE_LOCAL=true requires DEV_PLATFORM_LOCAL_UID/);
  });

  it('boots once the unprivileged uid is supplied', async () => {
    const res = await importConfigWith({
      DEV_PLATFORM_UNSAFE_LOCAL: 'true',
      DEV_PLATFORM_LOCAL_UID: '1500',
    });
    assert.equal(res.ok, true, `config should load; got: ${res.output}`);
  });
});

describe('the collapsed dev-platform namespace still carries every setting (epic #470 C3)', () => {
  it('keeps the post-processing: PORT-derived runner base URL + resolved workspace dir', async () => {
    const { config } = await import('../../src/config.js');
    // DEV_PLATFORM_RUNNER_BASE_URL is unset in the test env ⇒ loopback + PORT.
    assert.equal(config.devPlatform.baseUrl, `http://127.0.0.1:${String(config.PORT)}`);
    // DEV_PLATFORM_WORKSPACE_DIR defaults to an os.tmpdir() path, which resolvePath
    // leaves alone because it is already absolute — the invariant is absoluteness.
    assert.ok(
      config.devPlatform.workspaceDir.startsWith('/'),
      `workspaceDir must be absolute, got ${config.devPlatform.workspaceDir}`,
    );
  });

  it('serves the dev-platform settings ONLY through the namespace', () => {
    // A stale `config.DEV_*` read would type-error, but a runtime leftover would
    // not — assert the raw keys are gone from the object as well.
    return import('../../src/config.js').then(({ config }) => {
      const raw = config as unknown as Record<string, unknown>;
      for (const key of ['DEV_PLATFORM_ENABLED', 'DEV_PLATFORM_BACKEND', 'DEV_FLY_RUNNER_APP']) {
        assert.equal(raw[key], undefined, `${key} must not be readable off the top-level config`);
      }
      assert.equal(typeof config.devPlatform.enabled, 'boolean');
      assert.equal(config.devPlatform.backend, 'docker');
      // The lookalike that is NOT dev-platform stays exactly where it was: a core
      // key, read off the top-level config by the dev-graph endpoints.
      assert.equal(typeof config.DEV_ENDPOINTS_ENABLED, 'boolean');
    });
  });
});
