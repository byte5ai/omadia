import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { MCP_INVOKE_SCOPE, MCP_LIST_SCOPE, mcpWriteScope } from '@omadia/api-key-auth';
import {
  createPrivacyTurnHandle,
  currentDispatchCaller,
  INTERN_EXEMPT_TOOLS,
} from '@omadia/orchestrator';

import { MASKING_FAILED_PLACEHOLDER } from '../../src/mcp/publicMcpPrivacy.js';
import type { PublicMcpAuditEntry } from '../../src/mcp/publicMcpServer.js';
import {
  callResultText,
  callToolRequest,
  DECLARED_WRITE,
  isSandboxListenDenied,
  listToolsRequest,
  maskingPrivacyService,
  realDispatcher,
  rpcErrorMessage,
  startHarness,
  toolNames,
  type Harness,
  type HarnessOptions,
} from './harness.js';

/**
 * W2-3 (issue #542) — the public endpoint's privacy posture, proven against the
 * REAL `ToolDispatchService`.
 *
 * Every test here drives `realDispatcher`, so the actual `afterDispatch`
 * pipeline runs (raw capture → intern-exemption → operator bypass → intern).
 * A fake dispatcher returning already-masked text would prove nothing; the
 * assertions below require that a tool returning a genuine email address
 * produces an HTTP response that does NOT contain it.
 *
 * ─── The decision this file records ─────────────────────────────────────────
 *
 * The sibling unit closed the dispatch privacy seam at PARITY with the chat
 * path, and explicitly handed one consequence to this issue: masking fails OPEN
 * on a provider error. For an operator's own chat that is a considered
 * trade-off. For an untrusted external caller it is a leak, so this endpoint
 * fails CLOSED — implemented entirely in `publicMcpPrivacy.ts` so the chat
 * path's behaviour is untouched.
 */

const READ_TOOL = 'query_crm';
const WRITE_TOOL = 'create_lead';
const KEY_TOKEN = 'omadia_ak_privacy_token_dddddddddddd';
const KEY_ID = 'key-privacy';

/** The PII a tool returns. Asserted ABSENT from the wire. */
const RAW_EMAIL = 'sensitive.person@customer.example';
const RAW_RESULT = `contact: ${RAW_EMAIL}, status: active`;

function options(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    keys: [
      {
        token: KEY_TOKEN,
        id: KEY_ID,
        scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE, mcpWriteScope(WRITE_TOOL)],
      },
    ],
    bindingRows: [
      {
        key_id: KEY_ID,
        agent_id: 'sales',
        read_tools: [READ_TOOL],
        write_tools: [WRITE_TOOL],
        write_rate_limit_per_minute: 10,
        enabled: true,
      },
    ],
    dispatchers: {
      sales: realDispatcher([
        { name: READ_TOOL, handle: async () => ({ content: RAW_RESULT }) },
        {
          name: WRITE_TOOL,
          writeCapabilities: DECLARED_WRITE,
          handle: async () => ({ content: RAW_RESULT }),
        },
      ]),
    },
    allowWithoutPrivacyMasking: false,
    privacyService: maskingPrivacyService(),
    ...overrides,
  };
}

describe('public MCP endpoint — privacy', () => {
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

  // ── masking actually happens ──────────────────────────────────────────────

  /**
   * THE assertion this whole unit rests on. Without the explicit `privacy`
   * dependency, `turnContext.current()` is `undefined` on this path and the raw
   * email would go straight out over HTTP.
   */
  it('masks PII out of a read tool result before it reaches the wire', async (t) => {
    const h = await start(options(), t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    const text = callResultText(payload) ?? '';
    assert.doesNotMatch(text, /sensitive\.person@customer\.example/, 'raw PII reached the caller');
    assert.match(text, /\[email\]/, 'the masked digest should have replaced it');
    assert.match(text, /status: active/, 'non-PII content should survive masking');
  });

  it('masks PII out of a write tool result too', async (t) => {
    const h = await start(options(), t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    const text = callResultText(payload) ?? '';
    assert.doesNotMatch(text, /sensitive\.person@customer\.example/);
    assert.match(text, /\[email\]/);
  });

  // The fail-closed assertion demands that masking RAN for this dispatch. An
  // idempotency replay cannot satisfy that by observation: no handler runs, and
  // the gate is built per request, so `masked()` is false however well the
  // cached body was masked when produced. Unhandled, the endpoint answers
  // "privacy masking did not run" to a retried write — the worst possible reply,
  // because the caller learns nothing about whether the mutation committed.
  it('returns the cached result on an idempotent retry instead of a masking error', async (t) => {
    let executions = 0;
    const h = await start(
      options({
        dispatchers: {
          // `idempotency: true` is load-bearing — without a store wired,
          // `dispatchIdempotent` skips the cache and this test silently becomes
          // two ordinary dispatches that both mask fine, proving nothing.
          sales: realDispatcher(
            [
              {
                name: WRITE_TOOL,
                writeCapabilities: DECLARED_WRITE,
                handle: async () => {
                  executions += 1;
                  return { content: RAW_RESULT };
                },
              },
            ],
            undefined,
            { idempotency: true },
          ),
        },
      }),
      t,
    );
    if (!h) return;

    const withKey = (id: number): unknown => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: WRITE_TOOL,
        arguments: {},
        _meta: { idempotencyKey: 'retry-me-once' },
      },
    });

    const first = await h.rpc(withKey(1), { token: KEY_TOKEN });
    const firstText = callResultText(first.payload) ?? '';
    assert.match(firstText, /\[email\]/, 'the first call should have been masked normally');

    // Same key, same payload — the write must NOT run again, and the caller must
    // get the original answer rather than an internal error.
    const retry = await h.rpc(withKey(2), { token: KEY_TOKEN });
    const retryText = callResultText(retry.payload) ?? '';
    assert.doesNotMatch(
      rpcErrorMessage(retry.payload) ?? '',
      /privacy masking did not run/,
      'a legitimate replay was discarded by the masking assertion',
    );
    assert.equal(retryText, firstText, 'the replay should return the original masked body');
    assert.doesNotMatch(retryText, /sensitive\.person@customer\.example/, 'replay leaked raw PII');
    // The oracle: the handler must have run ONCE. Without this the test cannot
    // tell a genuine replay from two ordinary dispatches that both happened to
    // mask correctly — which is exactly what it was doing before the harness
    // gained a real idempotency store.
    assert.equal(executions, 1, 'the write executed twice — no replay actually happened');
  });

  // The ordering flaw the replay exemption originally introduced, and the case
  // the happy-path replay test above cannot see because it starts from an
  // already-masked cached body.
  //
  // The store used to retain the dispatch result BEFORE the endpoint asserted
  // that masking ran. So an unmasked body was cached, the first request was
  // correctly refused — and the retry replayed that raw body, flagged
  // `replayed` and therefore exempt from the very assertion that had just
  // rejected it. The assertion now runs inside the store's `exec`, so a body
  // that fails it is never retained and there is nothing for a replay to
  // smuggle back out.
  it('does not let a refused unmasked result be replayed on retry', async (t) => {
    // `withPrivacy` omitted — the interface permits it, and then the gate's
    // handle never reaches the dispatcher, so masking cannot run.
    const unmaskedDispatcher: import('../../src/mcp/publicMcpServer.js').PublicMcpDispatcher = {
      dispatch: async (_name, _input, options) => {
        const produced = { content: RAW_RESULT };
        options?.validateResult?.(produced);
        return produced;
      },
      listDispatchableToolSpecs: () => [
        {
          name: WRITE_TOOL,
          description: 'w',
          input_schema: { type: 'object' as const, properties: {} },
        },
      ],
      isWriteCapable: () => true,
    };
    const h = await start(options({ dispatchers: { sales: unmaskedDispatcher } }), t);
    if (!h) return;

    const withKey = (id: number): unknown => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: WRITE_TOOL, arguments: {}, _meta: { idempotencyKey: 'poison-1' } },
    });

    const first = await h.rpc(withKey(1), { token: KEY_TOKEN });
    assert.match(
      rpcErrorMessage(first.payload) ?? '',
      /privacy masking/,
      'an unmasked result must be refused on the first call',
    );

    const retry = await h.rpc(withKey(2), { token: KEY_TOKEN });
    const retryBody = JSON.stringify(retry.payload);
    assert.doesNotMatch(
      retryBody,
      /sensitive\.person@customer\.example/,
      'the retry replayed the cached UNMASKED body past the assertion',
    );
    assert.match(
      rpcErrorMessage(retry.payload) ?? '',
      /privacy masking/,
      'the retry must be refused too, not served from cache',
    );
  });

  /** Belt-and-braces: the raw string must not appear ANYWHERE in the response
   *  body, not merely outside the content block. */
  it('leaks no PII anywhere in the raw HTTP body', async (t) => {
    const h = await start(options(), t);
    if (!h) return;
    const res = await h.post(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(body, /sensitive\.person@customer\.example/);
  });

  // ── a THROWING tool leaks nothing either (W4) ─────────────────────────────

  /**
   * The leak this section exists for: `ToolDispatchService` ran its privacy
   * pipeline on the SUCCESS branch only, so a handler that threw returned
   * `error.message` verbatim and the endpoint serialized it straight to the
   * caller. Handler exceptions are not sanitized strings — the message below is
   * an ordinary shape for a real Odoo fault, and every byte of it went out.
   *
   * Asserted on the RAW HTTP BODY, not on "a masking function was called": the
   * bytes on the wire are the only thing that actually matters here.
   */
  const THROWN_PII = `Fault: Invalid field 'x' on record {"id":42,"name":"Jane Doe","email":"${RAW_EMAIL}","vat":"DE811234567"}`;

  function throwingOptions(via: 'native' | 'domain'): HarnessOptions {
    return options({
      dispatchers: {
        sales: realDispatcher(
          [
            {
              name: READ_TOOL,
              handle: () => {
                throw new Error(THROWN_PII);
              },
            },
          ],
          undefined,
          { via },
        ),
      },
    });
  }

  it('masks PII out of a NATIVE tool that THROWS — the raw fault never reaches the wire', async (t) => {
    const h = await start(throwingOptions('native'), t);
    if (!h) return;
    const res = await h.post(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(
      body,
      /sensitive\.person@customer\.example/,
      'a throwing tool leaked the raw error text to a public caller',
    );
    // The email is the marker this whole file uses: `maskingPrivacyService`
    // redacts email spans and nothing else, so its absence proves the digest —
    // not the surrounding prose — is what came back.
    assert.match(body, /\[email\]/, 'the error text should have been masked, not dropped');
    assert.doesNotMatch(
      body,
      new RegExp(THROWN_PII.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the exception message must not appear verbatim',
    );
  });

  it('masks PII out of a DOMAIN tool that THROWS too — both dispatch branches', async (t) => {
    // The two branches of `dispatchInner` have separately-written error
    // handling; proving one says nothing about the other.
    const h = await start(throwingOptions('domain'), t);
    if (!h) return;
    const res = await h.post(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(body, /sensitive\.person@customer\.example/);
    assert.match(body, /\[email\]/);
  });

  it('still reports the failure as an error rather than swallowing it', async (t) => {
    const h = await start(throwingOptions('native'), t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    const result = payload['result'] as { isError?: boolean } | undefined;
    assert.equal(result?.isError, true, 'masking must not turn a failure into a success');
  });

  it('audits a throwing tool as a failed call', async (t) => {
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start({ ...throwingOptions('native'), audit }, t);
    if (!h) return;
    await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.ok, false);
    assert.equal(audit[0]?.error, 'tool reported an error');
  });

  // ── fail CLOSED when masking errors ──────────────────────────────────────

  /**
   * The decision. `ToolDispatchService` catches a masking throw and returns the
   * RAW result (parity with the chat path). The endpoint's gate turns that
   * throw into a placeholder so the dispatcher's fail-open branch is never
   * reached, then discards the result and refuses.
   */
  it('refuses the call when the privacy provider throws — and never returns the raw result', async (t) => {
    const h = await start(
      options({ privacyService: maskingPrivacyService({ failOn: READ_TOOL }) }),
      t,
    );
    if (!h) return;
    const res = await h.post(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(body, /sensitive\.person@customer\.example/, 'FAILED OPEN — raw PII leaked');
    assert.match(body, /privacy masking failed/);
    // The placeholder is internal plumbing and must not surface either.
    assert.doesNotMatch(body, new RegExp(MASKING_FAILED_PLACEHOLDER.replace(/[[\]]/g, '\\$&')));
  });

  it('still serves a SIBLING tool when masking fails for only one of them', async (t) => {
    const h = await start(
      options({ privacyService: maskingPrivacyService({ failOn: WRITE_TOOL }) }),
      t,
    );
    if (!h) return;
    const failed = await h.rpc(callToolRequest(WRITE_TOOL, {}, 1), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(failed.payload) ?? '', /privacy masking failed/);

    // Per-call gate, not per-process: one tool's masking failure must not park
    // the endpoint for everyone.
    const ok = await h.rpc(callToolRequest(READ_TOOL, {}, 2), { token: KEY_TOKEN });
    assert.match(callResultText(ok.payload) ?? '', /\[email\]/);
  });

  it('audits a masking failure as a failed call', async (t) => {
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(
      options({ audit, privacyService: maskingPrivacyService({ failOn: READ_TOOL }) }),
      t,
    );
    if (!h) return;
    await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.ok, false);
    assert.equal(audit[0]?.error, 'privacy masking failed');
    assert.equal(audit[0]?.actingIdentity, `apikey:${KEY_ID}`);
  });

  // ── intern-exempt tools are never servable ───────────────────────────────

  /**
   * `isInternExemptTool` hands `memory`, `read_attachment` and friends over IN
   * CLEAR by design — correct for the agent reading its own scaffolding inside a
   * turn, unacceptable for a third party over HTTP. The dispatcher checks that
   * exemption BEFORE consulting the privacy handle, so it cannot be closed from
   * the handle; it is closed at the allowlist instead.
   */
  it('never lists an intern-exempt tool even when the operator allowlisted it', async (t) => {
    const h = await start(
      options({
        bindingRows: [
          {
            key_id: KEY_ID,
            agent_id: 'sales',
            read_tools: [READ_TOOL, 'memory'],
            write_tools: [],
            write_rate_limit_per_minute: 10,
            enabled: true,
          },
        ],
        dispatchers: {
          sales: realDispatcher([
            { name: READ_TOOL, handle: async () => ({ content: RAW_RESULT }) },
            { name: 'memory', handle: async () => ({ content: RAW_RESULT }) },
          ]),
        },
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    assert.deepEqual(toolNames(payload), [READ_TOOL]);
  });

  it('refuses to CALL an intern-exempt tool even when the operator allowlisted it', async (t) => {
    const seen: { name: string; input: unknown }[] = [];
    const h = await start(
      options({
        bindingRows: [
          {
            key_id: KEY_ID,
            agent_id: 'sales',
            read_tools: ['memory'],
            write_tools: [],
            write_rate_limit_per_minute: 10,
            enabled: true,
          },
        ],
        dispatchers: {
          sales: realDispatcher([{ name: 'memory', handle: async () => ({ content: RAW_RESULT }) }], seen),
        },
      }),
      t,
    );
    if (!h) return;
    const res = await h.post(callToolRequest('memory'), { token: KEY_TOKEN });
    const body = await res.text();
    assert.match(body, /not available to this API key/);
    assert.doesNotMatch(body, /sensitive\.person@customer\.example/);
    assert.deepEqual(seen, [], 'the exempt tool must never have been dispatched');
  });

  it('the exemption list this relies on is non-empty and contains `memory`', () => {
    // Guards against the allowlist filter silently becoming a no-op if the
    // upstream exemption set is ever emptied or renamed.
    assert.ok(INTERN_EXEMPT_TOOLS.size > 0);
    assert.equal(INTERN_EXEMPT_TOOLS.has('memory'), true);
  });

  // ── operator bypass does not reach a public caller ───────────────────────

  /**
   * An operator's per-plugin `_privacy_mode: bypass` means raw passthrough on the
   * chat path. Nobody consented to extending that to an anonymous HTTP caller,
   * so the gate pins `checkBypass` off. Driven here by handing the endpoint a
   * handle whose `checkBypass` WOULD fire.
   */
  it('ignores an operator per-plugin privacy bypass', async (t) => {
    const service = maskingPrivacyService();
    const h = await start(
      options({
        privacy: (scope) =>
          createPrivacyTurnHandle({
            service,
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            // Would hand the raw result straight through on the chat path.
            resolveBypass: () => ({ pluginId: '@omadia/test-plugin' }),
          }),
      }),
      t,
    );
    if (!h) return;
    const res = await h.post(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(
      body,
      /sensitive\.person@customer\.example/,
      'an operator bypass must not extend to a public caller',
    );
    assert.match(body, /\[email\]/);
  });

  // ── write capability comes from the declaration, not the name ────────────

  /**
   * `isWriteCapableTool` is declaration-driven. A tool that DECLARES write
   * capabilities is a write even if the operator filed it under `read_tools` —
   * otherwise a mis-filed binding would let `mcp:invoke` alone perform a
   * mutation.
   */
  it('treats a DECLARED write tool as a write even when the binding lists it as a read', async (t) => {
    const seen: { name: string; input: unknown }[] = [];
    const h = await start(
      options({
        keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
        bindingRows: [
          {
            key_id: KEY_ID,
            agent_id: 'sales',
            // Mis-filed on purpose: the operator called a write tool a read.
            read_tools: [WRITE_TOOL],
            write_tools: [],
            write_rate_limit_per_minute: 10,
            enabled: true,
          },
        ],
        dispatchers: {
          sales: realDispatcher(
            [
              {
                name: WRITE_TOOL,
                writeCapabilities: DECLARED_WRITE,
                handle: async () => ({ content: RAW_RESULT }),
              },
            ],
            seen,
          ),
        },
      }),
      t,
    );
    if (!h) return;
    // Not listed (the key holds no `mcp:write:create_lead`)…
    assert.deepEqual(toolNames((await h.rpc(listToolsRequest(), { token: KEY_TOKEN })).payload), []);
    // …and not callable.
    const { payload } = await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /not available to this API key/);
    assert.deepEqual(seen, [], 'a declared write must not run on mcp:invoke alone');
  });

  /**
   * The other half of the union. `isWriteCapableTool` returns FALSE for a tool
   * that mutates data but ships no annotation (its own docs call that a plugin
   * bug). A plugin bug must not become a public write escalation, so the
   * operator's `write_tools` list still forces the write treatment.
   */
  it('treats an UNANNOTATED tool as a write when the binding says so', async (t) => {
    const seen: { name: string; input: unknown }[] = [];
    const h = await start(
      options({
        keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
        bindingRows: [
          {
            key_id: KEY_ID,
            agent_id: 'sales',
            read_tools: [],
            // Declares nothing in code; the operator knows it mutates.
            write_tools: [READ_TOOL],
            write_rate_limit_per_minute: 10,
            enabled: true,
          },
        ],
        dispatchers: {
          sales: realDispatcher([{ name: READ_TOOL, handle: async () => ({ content: RAW_RESULT }) }], seen),
        },
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /not available to this API key/);
    assert.deepEqual(seen, []);
  });

  it('audits a declared write as a write', async (t) => {
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(options({ audit }), t);
    if (!h) return;
    await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    assert.equal(audit[0]?.write, true);
    assert.equal(audit[0]?.ok, true);
  });

  // ── caller context reaches dispatch ──────────────────────────────────────

  /**
   * The seam is a CARRIER, so this asserts propagation only — nothing beneath
   * dispatch enforces `scopes`, and this test must not be read as saying it does.
   */
  it('propagates the API-key principal to the dispatch caller context', async (t) => {
    let seenPrincipal: string | undefined;
    const h = await start(
      options({
        dispatchers: {
          sales: realDispatcher([
            {
              name: READ_TOOL,
              handle: async () => {
                seenPrincipal = currentDispatchCaller()?.principal;
                return { content: RAW_RESULT };
              },
            },
          ]),
        },
      }),
      t,
    );
    if (!h) return;
    await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.equal(seenPrincipal, KEY_ID);
  });
});
