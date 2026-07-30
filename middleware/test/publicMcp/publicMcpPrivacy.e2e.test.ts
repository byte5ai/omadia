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

  /** Belt-and-braces: the raw string must not appear ANYWHERE in the response
   *  body, not merely outside the content block. */
  it('leaks no PII anywhere in the raw HTTP body', async (t) => {
    const h = await start(options(), t);
    if (!h) return;
    const res = await h.post(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    const body = await res.text();
    assert.doesNotMatch(body, /sensitive\.person@customer\.example/);
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
