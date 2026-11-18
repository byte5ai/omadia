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

/**
 * OM-09 — the machine code has to survive the trip from the middleware to a
 * catalogue lookup. Before this, every consumer re-parsed `body` itself and
 * most of them threw the code away and rendered the server's English
 * `message` instead. The parse must be total: a 502 from a proxy is an HTML
 * page, not JSON, and that must yield `null` rather than throw inside a
 * constructor every failed request runs through.
 */
describe('ApiError.code', () => {
  it('extracts the code from a JSON error body', async () => {
    const { ApiError } = await import('../api');

    const err = new ApiError(
      500,
      'GET /v1/store failed: 500',
      '{"code":"store.list_failed","message":"x"}',
    );

    expect(err.code).toBe('store.list_failed');
  });

  it('is null for a body that is not JSON at all', async () => {
    const { ApiError } = await import('../api');

    const err = new ApiError(502, 'GET /v1/store failed: 502', '<html>502</html>');

    expect(err.code).toBeNull();
  });

  it('is null for JSON that carries no code', async () => {
    const { ApiError } = await import('../api');

    const err = new ApiError(500, 'boom', '{"message":"no code here"}');

    expect(err.code).toBeNull();
  });

  it('is null when the code is not a string', async () => {
    const { ApiError } = await import('../api');

    const err = new ApiError(500, 'boom', '{"code":42}');

    expect(err.code).toBeNull();
  });

  it('is null for the default empty body', async () => {
    const { ApiError } = await import('../api');

    expect(new ApiError(500, 'boom').code).toBeNull();
  });

  // #1333 — the memory purge (and other older routes) send `{ error, message }`.
  it('falls back to the `error` field when there is no `code`', async () => {
    const { ApiError } = await import('../api');

    const err = new ApiError(
      400,
      'POST /v1/admin/memory/purge/preview failed: 400',
      '{"error":"invalid_selector","message":"a context selector must be spelled \\"<channelType>~<id>\\""}',
    );

    expect(err.code).toBe('invalid_selector');
  });

  it('prefers `code` over `error` when both are present', async () => {
    const { ApiError } = await import('../api');

    expect(new ApiError(400, 'x', '{"code":"a.b","error":"legacy"}').code).toBe('a.b');
  });
});

describe('ApiError.serverMessage (#1333)', () => {
  it("carries the body's message instead of dropping it", async () => {
    const { ApiError } = await import('../api');

    const err = new ApiError(400, 'POST x failed: 400', '{"error":"invalid_selector","message":"spell it teams~id"}');

    expect(err.serverMessage).toBe('spell it teams~id');
    expect(err.message).toBe('POST x failed: 400');
  });

  it('is null for a body without a message or one that is not JSON', async () => {
    const { ApiError } = await import('../api');

    expect(new ApiError(400, 'x', '{"error":"e"}').serverMessage).toBeNull();
    expect(new ApiError(502, 'x', '<html>502</html>').serverMessage).toBeNull();
  });
});
