import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #1382 — the web-ui /health reports the build it serves, like the
 * middleware's does, so a script (or the updater) can tell which image is up.
 * `APP_VERSION` is resolved at import, hence the module reset per case.
 */

async function healthBody(): Promise<Record<string, unknown>> {
  vi.resetModules();
  const { GET } = await import('../route');
  return (await GET().json()) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /health', () => {
  it('reports the stamped build version', async () => {
    vi.stubEnv('OMADIA_VERSION', 'v0.180.0');
    expect(await healthBody()).toEqual({
      status: 'ok',
      service: 'omadia-web-ui',
      version: 'v0.180.0',
    });
  });

  it('reports unknown for an unstamped build instead of failing', async () => {
    vi.stubEnv('OMADIA_VERSION', '');
    expect(await healthBody()).toMatchObject({ status: 'ok', version: 'unknown' });
  });
});
