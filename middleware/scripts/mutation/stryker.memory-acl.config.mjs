/**
 * Memory-ACL plan step 6 — nightly Stryker run over the files that hold only
 * memory access rules (`.github/workflows/memory-acl-mutation.yml`).
 *
 * Every mutant Stryker makes in these files must turn at least one of the
 * in-memory memory-access suites, or the unit tests listed below, red; a
 * surviving mutant is an access rule no test checks. The hand-run record
 * (`docs/testing/memory-acl-mutation-record.md`) covers what Stryker cannot
 * reach usefully: the Neon SQL predicates (Stryker only swaps whole string
 * literals) and the in-memory graph's search methods (too large a file to
 * mutate whole every night).
 *
 * In place, because the orchestrator's tests load its `dist/`: the build runs
 * once on the instrumented sources, and each mutant is switched on by
 * Stryker's environment variable in the test processes. Run from
 * `middleware/` on a throwaway checkout:
 *
 *   npx stryker run scripts/mutation/stryker.memory-acl.config.mjs
 */
import { readdirSync } from 'node:fs';

const suites = [
  ...readdirSync('test/memoryAccess')
    .filter((f) => f.endsWith('.test.ts') && !f.endsWith('.pg.test.ts'))
    .map((f) => `test/memoryAccess/${f}`),
  // Unit tests that hold rules of these files the sweeps cannot see: write
  // vetoes (the sweep's memory store is read-only), the chat turn's session
  // check and the plugin boundary's conversation scope (hand record: MS02,
  // MS04, RT04, PB04).
  'test/scopedMemoryStore.contexts.test.ts',
  'test/memoryContextIsolation.test.ts',
  'test/chatSessionsOwner.test.ts',
  'test/graphBoundarySideDoors.test.ts',
];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: {
    command: `node scripts/mutation/runUntilRed.mjs --width 2 ${suites.join(' ')}`,
  },
  mutate: [
    'packages/harness-orchestrator/src/graphNodeAccess.ts',
    'packages/harness-orchestrator/src/registry/scopedMemoryStore.ts',
    'packages/harness-orchestrator/src/membersMemory.ts',
    'src/platform/shieldedNeighbors.ts',
    'src/platform/boundedGraphServices.ts',
    'src/routes/chatSessionAccess.ts',
  ],
  inPlace: true,
  buildCommand: 'npm run build -w @omadia/orchestrator',
  // A mutant that only runs while a module loads needs a fresh process
  // anyway; the command runner gives every mutant one.
  ignoreStatic: false,
  concurrency: 4,
  timeoutMS: 120_000,
  dryRunTimeoutMinutes: 20,
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/memory-acl.html' },
  jsonReporter: { fileName: 'reports/mutation/memory-acl.json' },
  // Report only for now: the first nightly runs set the baseline, which is
  // then raised, never lowered.
  thresholds: { high: 90, low: 75, break: null },
};
