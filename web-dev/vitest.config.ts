import { defineConfig } from 'vitest/config';
import path from 'node:path';
import react from '@vitejs/plugin-react';

/**
 * B.11-10: Vitest config for the web-dev surface.
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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './app'),
    },
  },
});
