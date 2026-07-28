import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * diagnosticsBuffer is a module-scope singleton (the ring buffer and the
 * `capturing` guard both live at module scope, by design — every caller in
 * the app shares one buffer). Each test re-imports the module fresh via
 * `vi.resetModules()` so entries from one test can't leak into the next.
 */
async function freshModule() {
  vi.resetModules();
  return import('../diagnosticsBuffer');
}

describe('diagnosticsBuffer (#433)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports no diagnostics before anything is captured', async () => {
    const mod = await freshModule();
    expect(mod.hasDiagnostics()).toBe(false);
    expect(mod.formatDiagnosticsExcerpt()).toBe('');
  });

  it('captures a window error event once initDiagnosticsCapture runs', async () => {
    const mod = await freshModule();
    mod.initDiagnosticsCapture();

    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', error: new Error('boom') }),
    );

    expect(mod.hasDiagnostics()).toBe(true);
    expect(mod.formatDiagnosticsExcerpt()).toContain('window-error: boom');
  });

  it('captures an unhandled promise rejection', async () => {
    const mod = await freshModule();
    mod.initDiagnosticsCapture();

    const event = new Event('unhandledrejection') as PromiseRejectionEvent & {
      reason?: unknown;
    };
    Object.defineProperty(event, 'reason', { value: new Error('rejected') });
    window.dispatchEvent(event);

    expect(mod.formatDiagnosticsExcerpt()).toContain(
      'unhandled-rejection: rejected',
    );
  });

  it('is idempotent — registering capture twice does not double-record', async () => {
    const mod = await freshModule();
    mod.initDiagnosticsCapture();
    mod.initDiagnosticsCapture();

    window.dispatchEvent(new ErrorEvent('error', { message: 'only-once' }));

    const excerpt = mod.formatDiagnosticsExcerpt();
    expect(excerpt.split('only-once').length - 1).toBe(1);
  });

  it('bounds the buffer to the newest 20 entries', async () => {
    const mod = await freshModule();
    mod.initDiagnosticsCapture();
    for (let i = 0; i < 25; i++) {
      window.dispatchEvent(new ErrorEvent('error', { message: `err-${i}` }));
    }
    const excerpt = mod.formatDiagnosticsExcerpt();
    expect(excerpt).not.toContain('err-0\n');
    expect(excerpt).toContain('err-24');
  });

  it('caps the realistic worst case safely under the server input cap (#433 review)', async () => {
    // MAX_DIAGNOSTICS_INPUT_LEN in middleware/src/issues/issuesRouter.ts is
    // 20000 chars. This is the module's own worst case — MAX_ENTRIES (20)
    // window-error captures, each with a max-length message AND stack —
    // which would otherwise reach ~120000 chars and trip the server's
    // invalid_diagnostics rejection on a well-formed request.
    const SERVER_MAX_DIAGNOSTICS_INPUT_LEN = 20000;
    const mod = await freshModule();
    mod.initDiagnosticsCapture();
    for (let i = 0; i < 25; i++) {
      const err = new Error('x'.repeat(2000));
      err.stack = `${err.message}\n${'y'.repeat(4000)}`;
      window.dispatchEvent(new ErrorEvent('error', { message: 'x'.repeat(2000), error: err }));
    }

    const excerpt = mod.formatDiagnosticsExcerpt();
    expect(excerpt.length).toBeLessThan(SERVER_MAX_DIAGNOSTICS_INPUT_LEN);
    // Newest entry survives; the marker signals that older ones were cut.
    expect(excerpt).toContain('…older diagnostics entries truncated…');
  });

  it('does not truncate a realistic session (12-20 small entries)', async () => {
    // The scenario this feature exists for — several recent errors, not
    // pathologically large ones — should never hit the truncation path.
    const mod = await freshModule();
    mod.initDiagnosticsCapture();
    for (let i = 0; i < 18; i++) {
      window.dispatchEvent(
        new ErrorEvent('error', { message: `GET /v1/foo/${i} failed: 500` }),
      );
    }
    const excerpt = mod.formatDiagnosticsExcerpt();
    expect(excerpt).not.toContain('truncated');
    expect(excerpt).toContain('foo/17');
  });

  it('does not export an API-error capture path — only window error/unhandledrejection feed the buffer (#433 review — narrowed scope)', async () => {
    const mod = await freshModule();
    expect((mod as Record<string, unknown>)['recordApiErrorDiagnostic']).toBeUndefined();
  });
});
