import {
  type LlmVerdict,
  type LlmVerifier,
} from './skillVerdictLlmVerifier.js';

/**
 * Intentional scoped exception to the no-mocking norm: a live LLM call cannot
 * belong in a deterministic CI suite, so tests need a tiny in-process stand-in.
 */
export function createFakeLlmVerifier(opts?: {
  modelId?: string;
  promptHash?: string;
  respond?: LlmVerdict | (() => LlmVerdict | Promise<LlmVerdict>);
  delayMs?: number;
}): LlmVerifier & { calls: number } {
  const fake: LlmVerifier & { calls: number } = {
    modelId: opts?.modelId ?? 'fake-llm-model',
    promptHash: opts?.promptHash ?? 'fake-llm-prompt',
    calls: 0,
    async verify(): Promise<LlmVerdict> {
      fake.calls += 1;
      const delayMs = opts?.delayMs ?? 0;
      if (delayMs > 0) {
        await delay(delayMs);
      }

      const respond = opts?.respond;
      if (typeof respond === 'function') {
        return respond();
      }
      if (respond) {
        return respond;
      }
      return {
        severity: 'no_signals',
        rationale: 'fake default response',
      };
    },
  };
  return fake;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
