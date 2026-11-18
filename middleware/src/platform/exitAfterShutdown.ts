/**
 * Turn a best-effort cleanup into a signal handler that actually ends the
 * process. Registering any `SIGTERM` / `SIGINT` listener disables Node's default
 * "die on signal"; with the HTTP server still listening nothing else ends the
 * event loop, so without an explicit exit the kernel outlives the signal until
 * the supervisor escalates to SIGKILL (desktop after 4s, Docker after 10s).
 *
 * The time limit stays below the desktop's 4s grace (`childLifecycle.ts`): a
 * cleanup that hangs must not turn every quit back into a SIGKILL.
 */
export const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface ExitAfterShutdownOptions {
  readonly timeoutMs?: number;
  /** Injected by tests; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  readonly log?: (message: string) => void;
}

export function exitAfterShutdown(
  cleanup: () => Promise<void>,
  options: ExitAfterShutdownOptions = {},
): () => Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const log = options.log ?? ((message: string): void => console.warn(message));
  let started = false;

  return async () => {
    // SIGTERM and SIGINT share one handler; a second signal must not exit early.
    if (started) return;
    started = true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([cleanup().then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') {
        log(`[middleware] shutdown cleanup still running after ${String(timeoutMs)}ms; exiting anyway`);
      }
    } catch (err) {
      log(`[middleware] shutdown cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    exit(0);
  };
}
