import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  classifyByGate,
  classifyPlatformError,
  computeFingerprint,
  DEFAULT_REPORTABLE_CONFIDENCE,
  type TriageContext,
  type TriageLlmClient,
  type TriageResult,
} from '../../src/plugins/builder/platformIssueTriage.js';

function stubLlm(result: TriageResult): TriageLlmClient {
  return {
    classify: async () => Promise.resolve(result),
  };
}

function failingLlm(): TriageLlmClient {
  return {
    classify: async () =>
      Promise.reject(new Error('llm should not be called for this fixture')),
  };
}

describe('platformIssueTriage — classifyByGate', () => {
  it('agent-side ingest reasons short-circuit to "agent"', () => {
    for (const reason of [
      'spec_invalid',
      'conflict',
      'too_large',
      'manifest_invalid',
      'draft_not_found',
    ] as const) {
      const ctx: TriageContext = {
        summary: `install failure: ${reason}`,
        installFailure: { reason, code: `builder.${reason}`, message: '' },
      };
      const gate = classifyByGate(ctx);
      assert.equal(gate.kind, 'agent', `${reason} should be agent`);
    }
  });

  it('codegen_failed marks the failure as a platform candidate', () => {
    const ctx: TriageContext = {
      summary: 'codegen produced invalid TypeScript',
      installFailure: {
        reason: 'codegen_failed',
        code: 'builder.codegen_failed',
        message: 'internal codegen error',
      },
    };
    const gate = classifyByGate(ctx);
    assert.equal(gate.kind, 'platform-candidate');
    assert.ok(
      gate.kind === 'platform-candidate' &&
        gate.markers.includes('codegen-internal'),
    );
  });

  it('forbidden-import hint in stderr promotes to platform-candidate', () => {
    const ctx: TriageContext = {
      summary: 'build failed',
      stderrTail:
        'src/slots/foo.ts: Forbidden import: @omadia/plugin-api is not shipped',
    };
    const gate = classifyByGate(ctx);
    assert.equal(gate.kind, 'platform-candidate');
    assert.ok(
      gate.kind === 'platform-candidate' &&
        gate.markers.includes('forbidden-import'),
    );
  });

  it('core stack-frames promote to platform-candidate', () => {
    const stderr = `
TypeError: foo is not a function
    at builderAgent.runTurn (middleware/src/plugins/builder/builderAgent.ts:123:7)
    at async installCommit (middleware/src/plugins/builder/installCommit.ts:88:5)
`;
    const ctx: TriageContext = {
      summary: 'runtime crash',
      stderrTail: stderr,
    };
    const gate = classifyByGate(ctx);
    assert.equal(gate.kind, 'platform-candidate');
    assert.ok(
      gate.kind === 'platform-candidate' &&
        gate.markers.includes('core-stack-frame'),
    );
  });

  it('only-plugin-slot stack frames are NOT platform candidates', () => {
    const stderr = `
TypeError: foo is not a function
    at someSlot (de.byte5.agent.weather/src/slots/forecast.ts:42:5)
    at someOther (de.byte5.agent.weather/src/slots/forecast.ts:55:9)
`;
    const ctx: TriageContext = {
      summary: 'slot crashed during smoke',
      stderrTail: stderr,
    };
    const gate = classifyByGate(ctx);
    assert.equal(gate.kind, 'unknown');
  });

  it('admin-route schema-violation flags a platform candidate', () => {
    const ctx: TriageContext = {
      summary: 'admin route smoke failed',
      adminRouteResults: [
        {
          endpoint: '/admin/runtime/list',
          status: 'schema_violation',
          durationMs: 12,
        },
      ],
    };
    const gate = classifyByGate(ctx);
    assert.equal(gate.kind, 'platform-candidate');
  });

  it('build errors in core paths flag a platform candidate', () => {
    const ctx: TriageContext = {
      summary: 'tsc failed',
      buildErrors: [
        {
          path: 'middleware/src/plugins/builder/codegen.ts',
          line: 42,
          col: 5,
          code: 'TS2322',
          message: 'Type X is not assignable to Y',
        },
      ],
    };
    const gate = classifyByGate(ctx);
    assert.equal(gate.kind, 'platform-candidate');
  });
});

describe('platformIssueTriage — classifyPlatformError', () => {
  it('skips the LLM for gate-resolved agent failures', async () => {
    const ctx: TriageContext = {
      summary: 'manifest invalid',
      installFailure: {
        reason: 'manifest_invalid',
        code: 'builder.manifest_invalid',
        message: 'missing tool id',
      },
    };
    const decision = await classifyPlatformError(ctx, { llm: failingLlm() });
    assert.equal(decision.classification, 'agent');
    assert.equal(decision.reportable, false);
    assert.equal(decision.confidence, 1.0);
    assert.ok(decision.fingerprint.length >= 8);
  });

  it('reports when LLM says platform with confidence >= threshold', async () => {
    const ctx: TriageContext = {
      summary: 'codegen produced invalid TypeScript',
      installFailure: {
        reason: 'codegen_failed',
        code: 'builder.codegen_failed',
        message: 'internal codegen error',
      },
    };
    const decision = await classifyPlatformError(ctx, {
      llm: stubLlm({
        classification: 'platform',
        confidence: 0.92,
        reason: 'core codegen path produced invalid output',
      }),
    });
    assert.equal(decision.classification, 'platform');
    assert.equal(decision.reportable, true);
    assert.equal(decision.confidence, 0.92);
  });

  it('does NOT report when LLM confidence falls below threshold', async () => {
    const ctx: TriageContext = {
      summary: 'codegen produced invalid TypeScript',
      installFailure: {
        reason: 'codegen_failed',
        code: 'builder.codegen_failed',
        message: 'internal codegen error',
      },
    };
    const decision = await classifyPlatformError(ctx, {
      llm: stubLlm({
        classification: 'platform',
        confidence: DEFAULT_REPORTABLE_CONFIDENCE - 0.01,
        reason: 'looks platform but unsure',
      }),
    });
    assert.equal(decision.classification, 'platform');
    assert.equal(decision.reportable, false);
  });

  it('does NOT report ambiguous classifications even with high confidence', async () => {
    const ctx: TriageContext = {
      summary: 'build crashed somewhere',
    };
    const decision = await classifyPlatformError(ctx, {
      llm: stubLlm({
        classification: 'ambiguous',
        confidence: 0.99,
        reason: 'could be either side',
      }),
    });
    assert.equal(decision.reportable, false);
  });

  it('clamps NaN/negative confidence to 0', async () => {
    const decision = await classifyPlatformError(
      {
        summary: 'whatever',
        installFailure: {
          reason: 'pipeline_failed',
          code: 'builder.pipeline_failed',
          message: '',
        },
      },
      {
        llm: stubLlm({
          classification: 'platform',
          confidence: Number.NaN,
          reason: 'LLM returned NaN',
        }),
      },
    );
    assert.equal(decision.confidence, 0);
    assert.equal(decision.reportable, false);
  });
});

describe('platformIssueTriage — computeFingerprint', () => {
  it('produces a stable hash for the same input', () => {
    const ctx = {
      installFailure: {
        reason: 'codegen_failed',
        code: 'builder.codegen_failed',
      },
      buildErrors: [
        {
          path: 'middleware/src/plugins/builder/codegen.ts',
          line: 42,
          col: 5,
          code: 'TS2322',
          message: 'x',
        },
      ],
    };
    const a = computeFingerprint(ctx);
    const b = computeFingerprint(ctx);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{16}$/);
  });

  it('different error codes produce different hashes', () => {
    const a = computeFingerprint({
      installFailure: { reason: 'codegen_failed', code: 'A' },
    });
    const b = computeFingerprint({
      installFailure: { reason: 'codegen_failed', code: 'B' },
    });
    assert.notEqual(a, b);
  });

  it('column-only differences do not split fingerprints', () => {
    const base = {
      installFailure: {
        reason: 'pipeline_failed',
        code: 'builder.pipeline_failed',
      },
    };
    const a = computeFingerprint({
      ...base,
      buildErrors: [
        {
          path: 'middleware/src/plugins/builder/codegen.ts',
          line: 42,
          col: 5,
          code: 'TS2322',
          message: 'x',
        },
      ],
    });
    const b = computeFingerprint({
      ...base,
      buildErrors: [
        {
          path: 'middleware/src/plugins/builder/codegen.ts',
          line: 999, // line/col are NOT part of the fingerprint
          col: 99,
          code: 'TS2322',
          message: 'x',
        },
      ],
    });
    assert.equal(a, b);
  });

  it('absolute paths and unix-style paths converge after normalization', () => {
    const a = computeFingerprint({
      installFailure: { reason: 'pipeline_failed', code: 'x' },
      stderrTail:
        'at runTurn (/Users/alice/work/omadia/middleware/src/plugins/builder/builderAgent.ts:42:5)',
    });
    const b = computeFingerprint({
      installFailure: { reason: 'pipeline_failed', code: 'x' },
      stderrTail:
        'at runTurn (/home/bob/repos/omadia/middleware/src/plugins/builder/builderAgent.ts:42:5)',
    });
    assert.equal(a, b);
  });
});
