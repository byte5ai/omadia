import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { composeFixPrompt } from '../../src/plugins/builder/composeFixPrompt.js';
import type { BuildError } from '../../src/plugins/builder/buildErrorParser.js';
import type { ManifestViolation } from '../../src/plugins/builder/manifestLinter.js';
import type {
  AdminRouteSmokeResult,
  ToolSmokeResult,
  UiRouteSmokeResult,
} from '../../src/plugins/builder/runtimeSmoke.js';

const SAMPLE_ERROR: BuildError = {
  path: 'src/toolkit.ts',
  line: 42,
  col: 5,
  code: 'TS2322',
  message: `Type 'string' is not assignable to type 'number'.`,
};

function makeErrors(n: number): BuildError[] {
  return Array.from({ length: n }, (_, i) => ({
    ...SAMPLE_ERROR,
    line: 10 + i,
    code: `TS${String(2300 + i)}`,
    message: `Generated error #${String(i + 1)}`,
  }));
}

describe('composeFixPrompt — build_failed', () => {
  it('emits header with build number and tsc reason when errors are present', () => {
    const out = composeFixPrompt({
      kind: 'build_failed',
      errors: [SAMPLE_ERROR],
      buildN: 7,
    });
    assert.match(out, /Build #7 failed/);
    assert.match(out, /TypeScript compile errors/);
    assert.match(out, /src\/toolkit\.ts:42:5/);
    assert.match(out, /TS2322/);
  });

  it('falls back to "Last build" when buildN is missing', () => {
    const out = composeFixPrompt({ kind: 'build_failed', errors: [SAMPLE_ERROR] });
    assert.match(out, /Last build failed/);
  });

  it('uses provided reason instead of default', () => {
    const out = composeFixPrompt({
      kind: 'build_failed',
      reason: 'codegen_failed',
      errors: [],
    });
    assert.match(out, /failed:\*\* codegen_failed/);
  });

  it('caps at top-5 errors and reports remainder', () => {
    const errors = makeErrors(12);
    const out = composeFixPrompt({ kind: 'build_failed', errors, buildN: 1 });
    assert.match(out, /Generated error #1/);
    assert.match(out, /Generated error #5/);
    assert.ok(!out.includes('Generated error #6'), 'should truncate after top-5');
    assert.match(out, /and 7 more \(capped at 5\)/);
  });

  it('includes the content-guard closer in every output', () => {
    const out = composeFixPrompt({ kind: 'build_failed', errors: [SAMPLE_ERROR] });
    assert.match(out, /kein silent removal/);
  });

  it('handles empty errors gracefully (header-only)', () => {
    const out = composeFixPrompt({ kind: 'build_failed', errors: [], buildN: 3 });
    assert.match(out, /Build #3 failed/);
    assert.match(out, /No structured errors were captured/);
    assert.match(out, /kein silent removal/);
  });
});

describe('composeFixPrompt — smoke_failed', () => {
  const okResult: ToolSmokeResult = {
    toolId: 'fetch_pages',
    status: 'ok',
    durationMs: 12,
  };
  const threwResult: ToolSmokeResult = {
    toolId: 'analyze_seo',
    status: 'threw',
    durationMs: 230,
    errorMessage: 'TypeError: Cannot read properties of undefined (reading "title")',
  };
  const timeoutResult: ToolSmokeResult = {
    toolId: 'crawl_site',
    status: 'timeout',
    durationMs: 5000,
  };

  it('lists only failing tools with status, duration, message', () => {
    const out = composeFixPrompt({
      kind: 'smoke_failed',
      smokeResults: [okResult, threwResult, timeoutResult],
      buildN: 4,
    });
    assert.match(out, /Build #4 failed/);
    assert.match(out, /2 failing tool/);
    assert.match(out, /\*\*analyze_seo\*\*/);
    assert.match(out, /threw/);
    assert.match(out, /Cannot read properties/);
    assert.match(out, /\*\*crawl_site\*\*/);
    assert.match(out, /timeout/);
    assert.ok(!out.includes('fetch_pages'), 'ok tools should not appear');
  });

  it('falls back when timeout has no errorMessage', () => {
    const out = composeFixPrompt({
      kind: 'smoke_failed',
      smokeResults: [timeoutResult],
    });
    assert.match(out, /no error message/);
  });

  it('caps failing tools at 5', () => {
    const many: ToolSmokeResult[] = Array.from({ length: 8 }, (_, i) => ({
      toolId: `tool_${String(i)}`,
      status: 'threw',
      durationMs: 50,
      errorMessage: `boom_${String(i)}`,
    }));
    const out = composeFixPrompt({ kind: 'smoke_failed', smokeResults: many });
    assert.match(out, /tool_0/);
    assert.match(out, /tool_4/);
    assert.ok(!out.includes('tool_5'), 'should truncate after top-5');
    assert.match(out, /and 3 more/);
  });

  it('handles empty results gracefully', () => {
    const out = composeFixPrompt({ kind: 'smoke_failed', smokeResults: [] });
    assert.match(out, /no per-tool failure entries/);
  });
});

describe('composeFixPrompt — manifest_violations', () => {
  const sampleViolation: ManifestViolation = {
    kind: 'tool_id_invalid_syntax',
    path: '/tools/2/id',
    message: `Tool id 'fetchPages' must be snake_case.`,
  };

  it('lists kind, path, message for each violation', () => {
    const out = composeFixPrompt({
      kind: 'manifest_violations',
      violations: [sampleViolation],
      buildN: 9,
    });
    assert.match(out, /Build #9 failed/);
    assert.match(out, /1 manifest violation/);
    assert.match(out, /\/tools\/2\/id/);
    assert.match(out, /tool_id_invalid_syntax/);
    assert.match(out, /must be snake_case/);
  });

  it('caps at 5 with remainder line', () => {
    const many: ManifestViolation[] = Array.from({ length: 7 }, (_, i) => ({
      kind: 'reserved_id',
      path: `/path/${String(i)}`,
      message: `bad ${String(i)}`,
    }));
    const out = composeFixPrompt({ kind: 'manifest_violations', violations: many });
    assert.match(out, /\/path\/0/);
    assert.match(out, /\/path\/4/);
    assert.ok(!out.includes('/path/5'));
    assert.match(out, /and 2 more/);
  });

  it('handles empty violations gracefully', () => {
    const out = composeFixPrompt({ kind: 'manifest_violations', violations: [] });
    assert.match(out, /no violations were attached/);
  });

  it('always includes the content-guard closer', () => {
    const out = composeFixPrompt({
      kind: 'manifest_violations',
      violations: [sampleViolation],
    });
    assert.match(out, /kein silent removal/);
  });
});

describe('composeFixPrompt — admin_route_schema_violation', () => {
  const schemaViolation: AdminRouteSmokeResult = {
    endpoint: '/api/test/admin/api/devices',
    status: 'schema_violation',
    httpStatus: 200,
    durationMs: 12,
    reason: "response body missing required 'ok: boolean' field",
  };
  const httpError: AdminRouteSmokeResult = {
    endpoint: '/api/test/admin/api/boom',
    status: 'http_error',
    httpStatus: 500,
    durationMs: 8,
    reason: 'HTTP 500',
  };
  const okResult: AdminRouteSmokeResult = {
    endpoint: '/api/test/admin/api/healthy',
    status: 'ok',
    httpStatus: 200,
    durationMs: 5,
  };

  it('lists only failing routes with status, http, duration, reason', () => {
    const out = composeFixPrompt({
      kind: 'admin_route_schema_violation',
      adminRouteResults: [okResult, schemaViolation, httpError],
      buildN: 11,
    });
    assert.match(out, /Build #11 failed/);
    assert.match(out, /2 schema\/HTTP violation/);
    assert.match(out, /\/api\/test\/admin\/api\/devices/);
    assert.match(out, /schema_violation/);
    assert.match(out, /missing required 'ok: boolean'/);
    assert.match(out, /\/api\/test\/admin\/api\/boom/);
    assert.match(out, /HTTP 500/);
    assert.ok(
      !out.includes('/api/healthy'),
      'ok routes should not appear in the prompt',
    );
  });

  it('includes the contract reminder explaining {ok: boolean, ...}', () => {
    const out = composeFixPrompt({
      kind: 'admin_route_schema_violation',
      adminRouteResults: [schemaViolation],
    });
    assert.match(out, /\{\s*ok: boolean/);
    assert.match(out, /Frontend prüft `data\.ok`/);
  });

  it('caps failing routes at 5', () => {
    const many: AdminRouteSmokeResult[] = Array.from({ length: 8 }, (_, i) => ({
      endpoint: `/api/admin/r${String(i)}`,
      status: 'schema_violation' as const,
      durationMs: 5,
      reason: `boom_${String(i)}`,
    }));
    const out = composeFixPrompt({
      kind: 'admin_route_schema_violation',
      adminRouteResults: many,
    });
    assert.match(out, /\/api\/admin\/r0/);
    assert.match(out, /\/api\/admin\/r4/);
    assert.ok(!out.includes('/api/admin/r5'));
    assert.match(out, /and 3 more/);
  });

  it('handles missing results gracefully', () => {
    const out = composeFixPrompt({
      kind: 'admin_route_schema_violation',
      adminRouteResults: [],
    });
    assert.match(out, /no per-route entries were attached/);
    assert.match(out, /kein silent removal/);
  });
});

describe('composeFixPrompt — ui_route_render_failed', () => {
  const missingCsp: UiRouteSmokeResult = {
    endpoint: '/p/test.agent/dashboard',
    status: 'missing_csp',
    httpStatus: 200,
    durationMs: 14,
    reason: 'Content-Security-Policy header missing — Teams cannot embed',
  };
  const wrongType: UiRouteSmokeResult = {
    endpoint: '/p/test.agent/inbox',
    status: 'wrong_content_type',
    httpStatus: 200,
    durationMs: 9,
    reason: "Content-Type 'application/json' is not text/html",
  };
  const okRoute: UiRouteSmokeResult = {
    endpoint: '/p/test.agent/healthy',
    status: 'ok',
    httpStatus: 200,
    durationMs: 11,
  };

  it('lists only failing routes with status + reason + http', () => {
    const out = composeFixPrompt({
      kind: 'ui_route_render_failed',
      uiRouteResults: [okRoute, missingCsp, wrongType],
      buildN: 7,
    });
    assert.match(out, /Build #7 failed/);
    assert.match(out, /2 render failure/);
    assert.match(out, /\/p\/test\.agent\/dashboard/);
    assert.match(out, /missing_csp/);
    assert.match(out, /\/p\/test\.agent\/inbox/);
    assert.match(out, /wrong_content_type/);
    assert.ok(!out.includes('/p/test.agent/healthy'));
  });

  it('includes contract explainer (CSP frame-ancestors, text/html, non-empty)', () => {
    const out = composeFixPrompt({
      kind: 'ui_route_render_failed',
      uiRouteResults: [missingCsp],
    });
    assert.match(out, /frame-ancestors/);
    assert.match(out, /Content-Type/);
    assert.match(out, /Teams-Iframe-Embedding/);
  });

  it('mentions the most common failure-modes inline', () => {
    const out = composeFixPrompt({
      kind: 'ui_route_render_failed',
      uiRouteResults: [missingCsp],
    });
    assert.match(out, /missing_csp/);
    assert.match(out, /wrong_content_type/);
    assert.match(out, /empty_render/);
  });

  it('caps failing routes at 5', () => {
    const many: UiRouteSmokeResult[] = Array.from({ length: 8 }, (_, i) => ({
      endpoint: `/p/test.agent/r${String(i)}`,
      status: 'http_error' as const,
      durationMs: 5,
      reason: `boom_${String(i)}`,
    }));
    const out = composeFixPrompt({
      kind: 'ui_route_render_failed',
      uiRouteResults: many,
    });
    assert.match(out, /\/p\/test\.agent\/r0/);
    assert.match(out, /\/p\/test\.agent\/r4/);
    assert.ok(!out.includes('/p/test.agent/r5'));
    assert.match(out, /and 3 more/);
  });

  it('handles missing results gracefully', () => {
    const out = composeFixPrompt({
      kind: 'ui_route_render_failed',
      uiRouteResults: [],
    });
    assert.match(out, /no per-route entries were attached/);
    assert.match(out, /kein silent removal/);
  });

  it('treats introspection_failed as soft pass (not in failing list)', () => {
    const introspectFail: UiRouteSmokeResult = {
      endpoint: '/p/test.agent/x',
      status: 'introspection_failed',
      durationMs: 0,
      reason: 'unable to mount captured router',
    };
    const out = composeFixPrompt({
      kind: 'ui_route_render_failed',
      uiRouteResults: [introspectFail],
    });
    // Soft pass → not listed as failure
    assert.match(out, /0 render failure/);
  });
});
