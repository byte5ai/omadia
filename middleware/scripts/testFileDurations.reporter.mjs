/**
 * Records how long each test FILE took, so the file-scoped `--test-timeout`
 * can be guarded (issue #566).
 *
 * WHY A REPORTER
 * --------------
 * `--test-timeout` is applied to the test file, not to each leaf: a file whose
 * leaves are 300 ms each but whose total is 1200 ms is killed outright at
 * `--test-timeout=500`. So the number that matters is the per-FILE total, and
 * nothing else reports it. The spec and tap reporters flatten to suite names —
 * run a glob through them and the filename is gone — which is exactly why this
 * risk has been invisible.
 *
 * `test:summary` is the one event that carries both `file` and `duration_ms`,
 * and node emits it once per file. Collecting it costs nothing on top of a run
 * that is happening anyway, which is the point: the guard must not double the
 * CI test time it is guarding.
 *
 * Pair it with a second `--test-reporter-destination`, so the human-readable
 * reporter keeps stdout:
 *
 *   node --test \
 *     --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./scripts/testFileDurations.reporter.mjs \
 *     --test-reporter-destination=test-file-durations.json
 *
 * Then `scripts/check-test-file-durations.mjs` turns the JSON into a gate.
 */

import path from 'node:path';

export default async function* testFileDurations(source) {
  /** @type {Map<string, {durationMs: number, success: boolean}>} */
  const files = new Map();

  for await (const event of source) {
    if (event.type !== 'test:summary') continue;

    const file = event.data?.file;
    // A `test:summary` without a file is the run-level summary — not a file.
    if (!file) continue;

    const durationMs = event.data?.duration_ms;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) continue;

    // node emits one summary per file; keep the longest if that ever changes,
    // so the guard can only become more conservative, never less.
    const previous = files.get(file);
    if (previous && previous.durationMs >= durationMs) continue;

    files.set(file, { durationMs, success: event.data?.success !== false });
  }

  const cwd = process.cwd();
  const entries = [...files.entries()]
    .map(([file, info]) => ({
      file: path.relative(cwd, file),
      durationMs: Math.round(info.durationMs * 1000) / 1000,
      success: info.success,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);

  yield `${JSON.stringify({ files: entries }, null, 2)}\n`;
}
