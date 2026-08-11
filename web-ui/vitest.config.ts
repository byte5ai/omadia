import { defineConfig } from 'vitest/config';
import path from 'node:path';
import react from '@vitejs/plugin-react';

/**
 * B.11-10: Vitest config for the web-ui surface.
 *
 * Scope: unit tests for the pure helpers (jsonSchemaShape,
 * openapiToTools, zodSchemaForToolSpec, entityVocabulary match,
 * toolTemplates) plus a small set of React-Testing-Library smokes
 * for the ToolList / ToolForm authoring path. Heavy components
 * (Monaco, dnd-kit drag) stay out of scope — covered by typecheck +
 * live-test, not by jsdom mocks.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['app/**/*.{test,spec}.{ts,tsx}'],
    globals: true,
    // vitest's default is 5000ms, which sits BELOW the honest runtime of the
    // heavier React Testing Library suites here — the template-proposal and
    // slot-picker renders measure 5-13s unloaded. A ceiling under a test's real
    // cost does not catch hangs, it manufactures them: four runs of an
    // unchanged tree gave 0, 9, 25 and 0 failures, purely as machine load
    // varied, every one of them a timeout rather than an assertion.
    //
    // 30s is deliberately generous. The job of this number is to stop a hung
    // test from burning the CI wall with no attribution, not to police tests
    // that are slow but honest. Raise it rather than trimming a real suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      // Match tsconfig's `@/*` -> `./*` (web-ui root), so `@/app/...` resolves
      // the same in vitest as in tsc and Next. (The previous `@` -> ./app
      // diverged from tsconfig; it surfaced once the first `@/app/...` imports
      // landed.)
      '@': path.resolve(__dirname, '.'),
    },
  },
});
