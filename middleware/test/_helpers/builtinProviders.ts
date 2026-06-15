/**
 * Test helper for the "everything is a plugin" migration: the llm-provider
 * package ships ZERO static models now, so tests that need the real
 * anthropic/openai/mistral models must register the app's bundled built-in
 * providers into the global overlay first. Call `useBuiltinProviders()` at the
 * top of a test file (or inside a describe) to register them before each test
 * and clear the overlay after.
 */
import { LlmProviderCatalog, clearExternalModels } from '@omadia/llm-provider';
import { afterEach, beforeEach } from 'node:test';

import { registerBuiltinLlmProviders } from '../../src/platform/builtinLlmProviders.js';

/** Register the bundled built-in providers (anthropic/openai/mistral) into the
 *  global model overlay before each test; clear it after. Idempotent. */
export function useBuiltinProviders(): void {
  beforeEach(() => {
    clearExternalModels();
    registerBuiltinLlmProviders(new LlmProviderCatalog());
  });
  afterEach(() => {
    clearExternalModels();
  });
}
