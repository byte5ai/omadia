import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The web-ui's own health endpoint (#432).
 *
 * It reports a version for one reason: the self-update gates every replaced
 * service on its own `/health` reporting the target build. Without a version
 * here, a web-ui that came up on the wrong image — or not at all — was
 * invisible, because the middleware's answer satisfied the gate for both.
 *
 * `APP_VERSION` is resolved once at module load, so each case re-imports the
 * route with the environment it is testing.
 */

async function loadRoute(version?: string) {
  vi.resetModules();
  if (version === undefined) delete process.env['OMADIA_VERSION'];
  else process.env['OMADIA_VERSION'] = version;
  return import('./route');
}

afterEach(() => {
  delete process.env['OMADIA_VERSION'];
  vi.resetModules();
});

describe('GET /health', () => {
  it('reports the stamped build so the update gate can verify it', async () => {
    const { GET } = await loadRoute('v0.140.1');
    const body = (await GET().json()) as Record<string, unknown>;

    expect(body).toMatchObject({ status: 'ok', version: 'v0.140.1' });
  });

  // Null, not the string "unknown": the updater's health waiter reads a
  // missing version as "cannot verify" and falls back to plain reachability,
  // which is right for a locally built image. "unknown" would instead look
  // like a version that never matches and fail every update.
  it('reports null for an unstamped build rather than a fake version', async () => {
    const { GET } = await loadRoute();
    const body = (await GET().json()) as Record<string, unknown>;

    expect(body.status).toBe('ok');
    expect(body.version).toBeNull();
  });

  // OMADIA_VERSION is set in the RUNTIME stage of the Dockerfile, so a
  // statically prerendered route would bake in the build-time value (none).
  it('is rendered per request, not prerendered at build time', async () => {
    const mod = await loadRoute('v0.140.1');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});
