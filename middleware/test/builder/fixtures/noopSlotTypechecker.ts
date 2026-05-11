import type { SlotTypecheckService } from '../../../src/plugins/builder/slotTypecheckPipeline.js';

/**
 * Stub SlotTypecheckService that always reports ok=true. Used by tests
 * that don't exercise the tsc-gate path (e.g. BuilderAgent prompt-shape
 * tests, route wiring tests).
 */
export const noopSlotTypechecker: SlotTypecheckService = {
  async run() {
    return {
      ok: true,
      errors: [],
      reason: 'ok',
      summary: 'tsc clean (test)',
      durationMs: 0,
    };
  },
};
