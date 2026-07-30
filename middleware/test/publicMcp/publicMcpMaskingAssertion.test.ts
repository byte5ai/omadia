import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { MCP_INVOKE_SCOPE, MCP_LIST_SCOPE } from '@omadia/api-key-auth';
import { NativeToolRegistry, ToolDispatchService } from '@omadia/orchestrator';
import type { PrivacyTurnHandle, ToolDispatchResult } from '@omadia/orchestrator';

import type {
  PublicMcpAuditEntry,
  PublicMcpDispatcher,
} from '../../src/mcp/publicMcpServer.js';
import {
  callResultText,
  callToolRequest,
  isSandboxListenDenied,
  maskingPrivacyService,
  realDispatcher,
  rpcErrorMessage,
  startHarness,
  type Harness,
  type HarnessOptions,
} from './harness.js';

/**
 * W4 (finding 2) — `masked()` is an ENFORCED assertion, not documentation.
 *
 * `publicMcpPrivacy.ts` has always exposed `masked()` with the comment "Lets the
 * endpoint assert that the boundary was actually crossed rather than skipped".
 * Nothing called it. The endpoint gated on `maskingFailed()` alone, which is
 * false in BOTH the good case and the dangerous one: masking that never ran
 * never "failed", so a result that skipped the boundary entirely sailed through
 * every check and was serialized to the caller.
 *
 * That is not a hypothetical. It is precisely how the unmasked-error-text leak
 * (finding 1) reached the wire, and it is the structural reason a NEW skip
 * introduced tomorrow would reach it too. This file pins the inverted control:
 * the endpoint now requires the positive signal.
 *
 * ─── Why these dispatchers are hand-built ────────────────────────────────────
 *
 * Each one below models a DIFFERENT way the boundary can be skipped while every
 * other gate stays green. They are not mocks of the masking function — the
 * privacy service they run against is the real redacting stub, and the
 * assertions read the bytes on the wire.
 */

const TOOL = 'query_crm';
const KEY_TOKEN = 'omadia_ak_masking_assert_eeeeeeeeeeee';
const KEY_ID = 'key-masking-assert';

const RAW_EMAIL = 'sensitive.person@customer.example';
const RAW_RESULT = `contact: ${RAW_EMAIL}, status: active`;

function options(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
    bindingRows: [
      {
        key_id: KEY_ID,
        agent_id: 'sales',
        read_tools: [TOOL],
        write_tools: [],
        write_rate_limit_per_minute: 10,
        enabled: true,
      },
    ],
    dispatchers: {
      sales: realDispatcher([{ name: TOOL, handle: async () => ({ content: RAW_RESULT }) }]),
    },
    allowWithoutPrivacyMasking: false,
    privacyService: maskingPrivacyService(),
    ...overrides,
  };
}

/**
 * A dispatcher that RETURNS the raw result without ever consulting the handle
 * it was given — the exact shape of "a dispatch branch that skips
 * `afterDispatch`". `withPrivacy` is honoured (the handle IS installed), so the
 * only thing distinguishing it from a correct dispatcher is that masking never
 * ran. `maskingFailed()` stays false for it.
 */
function boundarySkippingDispatcher(result: ToolDispatchResult): PublicMcpDispatcher {
  return {
    listDispatchableToolSpecs: () => [
      {
        name: TOOL,
        description: `desc:${TOOL}`,
        input_schema: { type: 'object' as const, properties: {} },
      },
    ],
    isWriteCapable: () => false,
    dispatch: () => Promise.resolve(result),
    async withPrivacy(_handle: PrivacyTurnHandle, fn: () => Promise<ToolDispatchResult>) {
      return fn();
    },
  } as unknown as PublicMcpDispatcher;
}

describe('public MCP endpoint — the masking boundary must be CROSSED (W4)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function start(
    opts: HarnessOptions,
    t: { skip: (m: string) => void },
  ): Promise<Harness | undefined> {
    try {
      harness = await startHarness(opts);
      return harness;
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
  }

  it('REFUSES a result that never crossed the boundary, even though masking did not "fail"', async (t) => {
    const h = await start(
      options({
        dispatchers: {
          sales: boundarySkippingDispatcher({ content: RAW_RESULT, origin: 'tool' }),
        },
      }),
      t,
    );
    if (!h) return;
    const res = await h.post(callToolRequest(TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(
      body,
      /sensitive\.person@customer\.example/,
      'an unmasked result reached the caller — the `masked()` assertion is not enforced',
    );
    assert.match(body, /privacy masking did not run/);
  });

  it('refuses an ORIGIN-LESS unmasked result too — an absent marker must fail closed', async (t) => {
    // A dispatcher predating `origin`, or a future one that forgets to set it,
    // must not thereby be exempt from the assertion.
    const h = await start(
      options({
        dispatchers: {
          sales: boundarySkippingDispatcher({ content: RAW_RESULT }),
        },
      }),
      t,
    );
    if (!h) return;
    const res = await h.post(callToolRequest(TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(body, /sensitive\.person@customer\.example/);
    assert.match(body, /privacy masking did not run/);
  });

  it('refuses an unmasked ERROR result — `isError` is not a licence to skip masking', async (t) => {
    const h = await start(
      options({
        dispatchers: {
          sales: boundarySkippingDispatcher({
            content: RAW_RESULT,
            isError: true,
            origin: 'tool',
          }),
        },
      }),
      t,
    );
    if (!h) return;
    const res = await h.post(callToolRequest(TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(body, /sensitive\.person@customer\.example/);
    assert.match(body, /privacy masking did not run/);
  });

  it('refuses when the dispatcher never installs the handle at all (no `withPrivacy`)', async (t) => {
    // The `withPrivacy` escape hatch is optional in the TYPE. A host that omits
    // it while masking is required cannot mask, so every call must be refused
    // rather than silently served raw.
    const noWithPrivacy = {
      listDispatchableToolSpecs: () => [
        {
          name: TOOL,
          description: `desc:${TOOL}`,
          input_schema: { type: 'object' as const, properties: {} },
        },
      ],
      isWriteCapable: () => false,
      dispatch: () => Promise.resolve({ content: RAW_RESULT, origin: 'tool' as const }),
    } as unknown as PublicMcpDispatcher;

    const h = await start(options({ dispatchers: { sales: noWithPrivacy } }), t);
    if (!h) return;
    const res = await h.post(callToolRequest(TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(body, /sensitive\.person@customer\.example/);
    assert.match(body, /privacy masking did not run/);
  });

  it('audits a skipped boundary distinctly from a FAILED one', async (t) => {
    // Two different operator problems: "the provider is down" and "a code path
    // bypassed the provider". Collapsing them into one audit reason would hide
    // the second inside the noise of the first.
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(
      options({
        audit,
        dispatchers: {
          sales: boundarySkippingDispatcher({ content: RAW_RESULT, origin: 'tool' }),
        },
      }),
      t,
    );
    if (!h) return;
    await h.rpc(callToolRequest(TOOL), { token: KEY_TOKEN });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.ok, false);
    assert.equal(audit[0]?.error, 'privacy masking skipped');
  });

  /**
   * `afterDispatch`'s `typeof result !== 'string'` short-circuit, investigated.
   *
   * `NativeToolHandler` is TYPED `(input) => Promise<string>`, but plugins load
   * dynamically at runtime, so a JavaScript plugin (or a TypeScript one with an
   * `any` in the wrong place) can resolve an OBJECT. That branch then returns it
   * untouched: masking genuinely never runs. The branch IS reachable.
   *
   * It is NOT, however, a live leak on this endpoint, and the mutation run says
   * so precisely: with the `masked()` assertion disabled, the raw PII still does
   * not reach the caller — the MCP SDK's own `CallToolResult` schema rejects a
   * non-string `text` block and the caller gets a zod validation error instead.
   * The containment is real but incidental, sitting in a dependency's outgoing
   * schema rather than in a control this endpoint owns.
   *
   * So what this test pins is the DETERMINISTIC refusal: the call is rejected at
   * the privacy boundary, with an audit row, rather than surviving to be caught
   * by an SDK schema whose strictness is not this repo's to guarantee. Drives the
   * REAL `ToolDispatchService` with a handler that violates its own contract,
   * which is the only honest way to reach the branch.
   */
  it('refuses a handler that returns a NON-STRING, which `afterDispatch` never masks', async (t) => {
    const registry = new NativeToolRegistry();
    registry.register(TOOL, {
      // Violates `NativeToolHandler`'s published `Promise<string>` on purpose.
      handler: (() => Promise.resolve({ email: RAW_EMAIL })) as unknown as (
        input: unknown,
      ) => Promise<string>,
      spec: {
        name: TOOL,
        description: `desc:${TOOL}`,
        input_schema: { type: 'object' as const, properties: {} },
      },
    });
    let slot: PrivacyTurnHandle | undefined;
    const service = new ToolDispatchService({
      nativeTools: registry,
      privacy: () => slot,
    });
    const dispatcher = {
      dispatch: (name: string, input: unknown, opts?: unknown) =>
        service.dispatch(name, input, opts as never),
      listDispatchableToolSpecs: () => service.listDispatchableToolSpecs(),
      isWriteCapable: (name: string) => service.isWriteCapable(name),
      async withPrivacy(handle: PrivacyTurnHandle, fn: () => Promise<ToolDispatchResult>) {
        slot = handle;
        try {
          return await fn();
        } finally {
          slot = undefined;
        }
      },
    } as unknown as PublicMcpDispatcher;

    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(options({ audit, dispatchers: { sales: dispatcher } }), t);
    if (!h) return;
    const res = await h.post(callToolRequest(TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(body, /sensitive\.person@customer\.example/);
    // The load-bearing half: refused HERE, by this endpoint, not downstream.
    assert.match(body, /privacy masking did not run/);
    assert.equal(audit[0]?.error, 'privacy masking skipped');
  });

  // ── the assertion must not fire on legitimate traffic ────────────────────

  it('still serves a normally-masked result', async (t) => {
    // The control. Without this, every test above would also pass if the
    // assertion simply refused everything.
    const h = await start(options(), t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(TOOL), { token: KEY_TOKEN });
    const text = callResultText(payload) ?? '';
    assert.doesNotMatch(text, /sensitive\.person@customer\.example/);
    assert.match(text, /\[email\]/);
  });

  it('still serves a masked ERROR from a throwing tool', async (t) => {
    // Finding 1's fix and finding 2's assertion have to coexist: a throwing
    // tool now DOES cross the boundary, so it must not be refused.
    const h = await start(
      options({
        dispatchers: {
          sales: realDispatcher([
            {
              name: TOOL,
              handle: () => {
                throw new Error(RAW_RESULT);
              },
            },
          ]),
        },
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /\[email\]/);
    assert.doesNotMatch(rpcErrorMessage(payload) ?? '', /sensitive\.person@customer\.example/);
  });

  it("does NOT refuse the dispatcher's OWN refusal string — there is nothing to mask", async (t) => {
    // `origin: 'dispatcher'` content names only the tool the caller asked for
    // and the owning plugin id. Requiring a digest for it would turn every
    // "plugin not ready" into an opaque internal error.
    const h = await start(
      options({
        dispatchers: {
          sales: boundarySkippingDispatcher({
            content: 'Error: tool `query_crm` is unavailable — plugin `@omadia/crm` …',
            isError: true,
            origin: 'dispatcher',
          }),
        },
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /has not completed|is unavailable/);
  });

  it('does not fire when no privacy provider is installed and the operator opted out', async (t) => {
    // `requirePrivacyMasking: false` is a documented operator decision. The
    // assertion must not second-guess it — there is no gate to consult.
    const base = options();
    const { privacyService: _dropped, ...withoutProvider } = base;
    const h = await start({ ...withoutProvider, allowWithoutPrivacyMasking: true }, t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(TOOL), { token: KEY_TOKEN });
    assert.equal(callResultText(payload), RAW_RESULT);
  });
});
