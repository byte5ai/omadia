/**
 * Process-level guards against detached async failures in plugin code.
 *
 * Without these listeners, Node.js terminates the process on:
 *   - unhandledRejection (default since Node 15)
 *   - uncaughtException
 *
 * For a harness whose primary job is running third-party plugins, "host dies
 * because a plugin's setTimeout threw" is the worst-case failure mode. A
 * plugin with a detached async bug can leak into either of these paths — the
 * synchronous boundaries around `activate()` / `tool.run()` catch direct
 * failures, but work scheduled from inside a plugin that resolves later does
 * not pass through a try/catch.
 *
 * v1 (this file): log prominently and keep the process alive. Attribution
 * (which plugin caused it) is best-effort — Node's unhandledRejection/
 * uncaughtException events do NOT preserve AsyncLocalStorage context, so we
 * cannot reliably say "plugin X threw this" from the listener alone. Phase
 * 0c adds an ALS-based per-plugin error domain that lets the runtime
 * increment the right circuit-breaker counter on attributable failures.
 *
 * Tradeoff: swallowing uncaughtException also hides kernel bugs. For this
 * product the "don't kill host" property outweighs that risk — kernel errors
 * still surface in logs, and a kernel that keeps running lets the operator
 * inspect the state rather than bouncing into a restart loop where every boot
 * hits the same bug. Systemd/Fly will not auto-restart a process that
 * stopped, so crashing was never a good default anyway.
 */

export interface ProcessGuardOptions {
  log?: (msg: string, err: unknown) => void;
}

export function installProcessGuards(opts: ProcessGuardOptions = {}): void {
  const log =
    opts.log ??
    ((msg: string, err: unknown): void => {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
      // Use console.error so Fly's log aggregator picks it up on stderr
      // (stdout INFO lines have been observed to drop under load).
      console.error(`${msg}: ${detail}${stack}`);
    });

  process.on('unhandledRejection', (reason: unknown) => {
    log(
      '[process-guards] unhandledRejection — likely from detached async work in plugin code; host kept alive',
      reason,
    );
  });

  process.on('uncaughtException', (err: Error) => {
    log(
      '[process-guards] uncaughtException — likely from a plugin timer/callback; host kept alive',
      err,
    );
  });
}
