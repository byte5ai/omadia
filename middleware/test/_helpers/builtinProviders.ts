/**
 * Test helper for the "everything is a plugin" migration: the llm-provider
 * package ships ZERO static models now, so tests that need the real
 * anthropic/openai/mistral models must register the app's bundled built-in
 * providers into the global overlay first. Call `useBuiltinProviders()` at the
 * top of a test file (or inside a describe) to register them before each test
 * and clear the overlay after.
 */
import { registerAnthropicAdapter } from '@omadia/llm-adapter-anthropic';
import { registerOpenAiAdapter } from '@omadia/llm-adapter-openai';
import {
  defaultLlmAdapters,
  LlmProviderCatalog,
  clearExternalModels,
} from '@omadia/llm-provider';
import { afterEach, beforeEach } from 'node:test';

import { registerBuiltinLlmProviders } from '../../src/platform/builtinLlmProviders.js';

/**
 * Register the bundled built-in providers into the GLOBAL model overlay, the
 * way the kernel does at boot (`src/index.ts`, before any plugin activates).
 * The catalog itself is a throwaway — what the registry reads is the overlay.
 *
 * For suites that need the models in only SOME of their tests (e.g. #1451's
 * class-ref guards, which also exercise the modelless state) and therefore
 * cannot use the `useBuiltinProviders()` hooks below.
 */
export function registerBuiltinProvidersIntoOverlay(): void {
  clearExternalModels();
  registerBuiltinLlmProviders(new LlmProviderCatalog());
}

/** Register the bundled built-in providers (anthropic/openai/mistral) into the
 *  global model overlay before each test; clear it after. Also registers the
 *  wire-format adapters into the process-default registry so a built provider
 *  actually resolves (the app does this at boot; tests run without boot).
 *  Idempotent. */
export function useBuiltinProviders(): void {
  beforeEach(() => {
    registerBuiltinProvidersIntoOverlay();
    registerAnthropicAdapter(defaultLlmAdapters);
    registerOpenAiAdapter(defaultLlmAdapters);
  });
  afterEach(() => {
    clearExternalModels();
  });
}
