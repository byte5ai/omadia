import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { MCP_INVOKE_SCOPE, MCP_LIST_SCOPE } from '@omadia/api-key-auth';
import type { PrivacyGuardService } from '@omadia/plugin-api';

import {
  callResultText,
  callToolRequest,
  isSandboxListenDenied,
  maskingPrivacyService,
  realDispatcher,
  startHarness,
  type Harness,
  type HarnessOptions,
} from './harness.js';

/**
 * #2305 / ADR-0271 — `render_diagram`, `create_xlsx` and `create_docx` are
 * intern-exempt (ADR-0197), so the public gate never sees masking for them.
 * They are served again behind a per-result check: the shield's free-text
 * detectors read the result, and only a clean one goes out.
 */

const TOOL = 'create_xlsx';
const KEY_TOKEN = 'omadia_ak_result_check_ffffffffffffffff';
const KEY_ID = 'key-result-check';
const CLEAN = JSON.stringify({ filename: 'report.xlsx', rows: 3, url: 'https://files.example/x' });
const DIRTY = JSON.stringify({ filename: 'erika.mustermann@example.com.xlsx', rows: 3 });

type Verdict = 'clean' | 'spans' | 'degraded' | 'withheld' | 'absent' | 'throws';

function privacyWith(verdict: Verdict, finalized: string[]): PrivacyGuardService {
  const base = maskingPrivacyService();
  return {
    ...base,
    async finalizeTurn(turnId: string) {
      finalized.push(turnId);
      return undefined;
    },
    ...(verdict === 'absent'
      ? {}
      : {
          async redactToolErrorText(request: { text: string }) {
            if (verdict === 'throws') throw new Error('detector down');
            if (verdict === 'withheld') return { outcome: 'withheld', reason: 'x' };
            const hasEmail = /@/.test(request.text);
            return {
              outcome: 'redacted',
              text: request.text,
              spans: verdict === 'spans' || hasEmail ? [{ type: 'email', detector: 'c0' }] : [],
              degraded: verdict === 'degraded',
            };
          },
        }),
  } as unknown as PrivacyGuardService;
}

function options(result: string, verdict: Verdict, finalized: string[]): HarnessOptions {
  return {
    keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
    bindingRows: [
      {
        key_id: KEY_ID,
        agent_id: 'office',
        read_tools: [TOOL],
        write_tools: [],
        write_rate_limit_per_minute: 10,
        enabled: true,
      },
    ],
    dispatchers: {
      office: realDispatcher([{ name: TOOL, handle: async () => ({ content: result }) }]),
    },
    allowWithoutPrivacyMasking: false,
    privacyService: privacyWith(verdict, finalized),
  };
}

describe('public MCP — per-result check for the file producers (#2305)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function call(
    result: string,
    verdict: Verdict,
    t: { skip: (m: string) => void },
    finalized: string[] = [],
  ): Promise<string | undefined> {
    try {
      harness = await startHarness(options(result, verdict, finalized));
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
    const res = await harness.post(callToolRequest(TOOL), { token: KEY_TOKEN });
    return res.text();
  }

  it('serves a clean result unchanged', async (t) => {
    const body = await call(CLEAN, 'clean', t);
    if (body === undefined) return;
    assert.equal(callResultText(JSON.parse(body) as Record<string, unknown>), CLEAN);
  });

  for (const verdict of ['spans', 'degraded', 'withheld', 'absent', 'throws'] as const) {
    it(`refuses the result when the check is not clean (${verdict})`, async (t) => {
      const body = await call(verdict === 'spans' ? DIRTY : CLEAN, verdict, t);
      if (body === undefined) return;
      assert.doesNotMatch(body, /report\.xlsx|erika\.mustermann/);
      assert.match(body, /privacy masking did not run/);
    });
  }

  it("finalizes the request's privacy state once the work settled", async (t) => {
    const finalized: string[] = [];
    const body = await call(CLEAN, 'clean', t, finalized);
    if (body === undefined) return;
    for (let i = 0; i < 50 && finalized.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(finalized.length, 1);
  });
});
