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

  it('records a failed API call via recordApiErrorDiagnostic', async () => {
    const mod = await freshModule();
    mod.recordApiErrorDiagnostic({
      status: 503,
      message: 'POST /v1/issues/create failed: 503',
      detail: 'llm_unconfigured',
    });

    expect(mod.hasDiagnostics()).toBe(true);
    expect(mod.formatDiagnosticsExcerpt()).toContain(
      '503 POST /v1/issues/create failed: 503',
    );
    expect(mod.formatDiagnosticsExcerpt()).toContain('llm_unconfigured');
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
    for (let i = 0; i < 25; i++) {
      mod.recordApiErrorDiagnostic({ status: 500, message: `err-${i}` });
    }
    const excerpt = mod.formatDiagnosticsExcerpt();
    expect(excerpt).not.toContain('err-0\n');
    expect(excerpt).toContain('err-24');
  });
});
