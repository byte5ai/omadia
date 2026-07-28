import { describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the #433 review's scope-narrowing fix: `ApiError`
 * used to call `recordApiErrorDiagnostic` from its constructor, making it a
 * silent, global source for the Create Issue diagnostics buffer — any failed
 * API call anywhere in the admin UI (including a secrets/vault-config PATCH
 * on /admin/settings) would land there, and an operator could later attach
 * that unrelated captured content to a PUBLIC GitHub issue on a completely
 * different bug report. This asserts constructing an `ApiError` does NOT, by
 * itself, add anything to the diagnostics buffer. See api.ts's `ApiError`
 * doc comment and diagnosticsBuffer.ts's module doc comment.
 */
describe('ApiError diagnostics scope (#433 review — narrowed scope)', () => {
  it('does not add anything to the diagnostics buffer when constructed', async () => {
    vi.resetModules();
    const diagnostics = await import('../diagnosticsBuffer');
    const { ApiError } = await import('../api');

    expect(diagnostics.hasDiagnostics()).toBe(false);

    void new ApiError(500, 'PATCH /v1/admin/settings failed: 500', 'vault error detail');

    expect(diagnostics.hasDiagnostics()).toBe(false);
    expect(diagnostics.formatDiagnosticsExcerpt()).toBe('');
  });

  it('constructing many ApiErrors still leaves the buffer empty', async () => {
    vi.resetModules();
    const diagnostics = await import('../diagnosticsBuffer');
    const { ApiError } = await import('../api');

    for (let i = 0; i < 10; i++) {
      void new ApiError(500, `GET /v1/foo/${i} failed: 500`, 'detail');
    }

    expect(diagnostics.hasDiagnostics()).toBe(false);
  });
});
