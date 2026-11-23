import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { callSiteOf } from '@omadia/usage-telemetry';

// Spec 2042 §5.10 — a call outside any execution context is reported under
// the frame of its real caller, not under a kernel bridge every caller of a
// kind passes through (live: every `ctx.llm` call was filed under
// `anthropicLlmProvider.js`).

const stack = (...frames: string[]): string => ['Error', ...frames.map((f) => `    at ${f}`)].join('\n');

describe('model gateway call site', () => {
  it('skips the gate, the adapters and the ctx.llm bridges', () => {
    const site = callSiteOf(
      stack(
        'callSite (file:///app/packages/harness-usage-telemetry/dist/modelCallMeter.js:140:20)',
        'admitModelCall (file:///app/packages/llm-provider-api/dist/modelCallGate.js:30:3)',
        'Object.complete (file:///app/packages/llm-adapter-anthropic/dist/adapter.js:88:5)',
        'Object.complete (file:///app/dist/platform/anthropicLlmProvider.js:57:44)',
        'Object.complete (file:///app/dist/platform/pluginContext.js:1947:20)',
        'async classifyBatch (file:///app/packages/harness-plugin-privacy-guard/dist/v4/modelClassifier.js:146:22)',
      ),
    );
    assert.equal(site, 'async classifyBatch (packages/harness-plugin-privacy-guard/dist/v4/modelClassifier.js:146:22)');
  });

  it('strips the checkout prefix as well as the image prefix', () => {
    assert.equal(
      callSiteOf(stack('run (file:///Users/x/omadia/middleware/src/privacy/recompute.ts:10:1)')),
      'run (src/privacy/recompute.ts:10:1)',
    );
  });

  it('falls back to the bridge when nothing follows it', () => {
    assert.equal(
      callSiteOf(stack('Object.complete (file:///app/dist/platform/anthropicLlmProvider.js:57:44)')),
      'Object.complete (dist/platform/anthropicLlmProvider.js:57:44)',
    );
  });
});
