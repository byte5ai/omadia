import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  createPrivacyTurnHandle,
  type PrivacyTurnHandle,
} from '../../packages/harness-orchestrator/src/privacyHandle.js';
import {
  ToolDispatchService,
  type ToolDispatchCallerContext,
} from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import { currentDispatchCaller } from '../../packages/harness-orchestrator/src/toolCallerContext.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';
// Imported from SOURCE (like privacyV4Bypass.test.ts): the real classifier is
// what the thrown-exception case below pins, so a change in `src/` must turn
// it red without a rebuild.
import { createPrivacyGuardService } from '../../packages/harness-plugin-privacy-guard/src/index.js';

/**
 * #542 prerequisite — the privacy/trace seam in `ToolDispatchService`.
 *
 * `ToolDispatchService` is what the loopback MCP server dispatches through, and
 * what a public MCP endpoint would dispatch through. Before this work it applied
 * NO privacy masking: the chat path masks tool results via
 * `Orchestrator.dispatchToolDeadlined`, but that code reads its handle from
 * `turnContext`, which this dispatcher runs entirely outside of. A caller reaching
 * tools here got PII in clear.
 *
 * MUTATION-CHECK DISCIPLINE: every assertion below inspects the CONTENT that
 * leaves the dispatcher. None of them assert "a masking function was called" —
 * a call-count assertion stays green over a masking function that returns its
 * input unchanged, which is exactly the class of false-green this repo has been
 * burned by. The fake handle performs a REAL redaction and the tests assert the
 * raw PII is absent from the output.
 */

const EMAIL = 'erika.mustermann@example.com';
const IBAN = 'DE89370400440532013000';
const PII_RESULT = `{"name":"Erika Mustermann","email":"${EMAIL}","iban":"${IBAN}"}`;

interface RecordedBypass {
  readonly toolName: string;
  readonly pluginId: string;
  readonly bytes: number;
}

type RecordedToolError = Parameters<PrivacyTurnHandle['recordToolError']>[0];

function redactPii(text: string): string {
  return text
    .replaceAll(EMAIL, '[masked:email]')
    .replaceAll(IBAN, '[masked:iban]')
    .replaceAll('Erika Mustermann', '[masked:person]');
}

/**
 * A privacy handle that genuinely redacts. `internToolResultV4` strips the email
 * and IBAN and returns a digest — so if the dispatcher fails to call it, the raw
 * values survive into the output and the assertions below fail. Its tool-error
 * redactor does the same without the digest envelope, and every tool-error
 * receipt entry lands in `toolErrors`.
 */
function redactingPrivacyHandle(options?: {
  readonly bypassTools?: ReadonlySet<string>;
  readonly bypassReceipts?: RecordedBypass[];
  readonly internThrows?: boolean;
  readonly toolErrors?: RecordedToolError[];
  readonly recordThrows?: boolean;
}): PrivacyTurnHandle {
  return {
    async internToolResultV4({ toolName, rawResult }) {
      if (options?.internThrows === true) {
        throw new Error('privacy provider unavailable');
      }
      return {
        digestText: `«dataset:${toolName}» ${redactPii(rawResult)}`,
        datasetId: `ds-${toolName}`,
      };
    },
    async recordBypassedTool({ toolName, pluginId, bytes }) {
      options?.bypassReceipts?.push({ toolName, pluginId, bytes });
    },
    async recordToolError(entry) {
      if (options?.recordThrows === true) throw new Error('receipt store down');
      options?.toolErrors?.push(entry);
    },
    async redactToolErrorText({ text }) {
      const redacted = redactPii(text);
      return {
        outcome: 'redacted',
        text: redacted,
        spans: redacted === text ? [] : [{ type: 'email', detector: 'c0-regex' }],
        degraded: false,
      };
    },
    checkBypass(toolName) {
      return options?.bypassTools?.has(toolName) === true
        ? { pluginId: `plugin-for-${toolName}` }
        : undefined;
    },
    async runV4Tool() {
      throw new Error('not used on this path');
    },
    async subAgentResultV4() {
      throw new Error('not used on this path');
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async maskUserPrompt() {
      return { outcome: 'disabled' };
    },
    async restorePromptPseudonyms(text) {
      return text;
    },
    snapshotPromptRestorer() {
      return undefined;
    },
    async finalize() {
      return undefined;
    },
  };
}

function registryWith(
  name: string,
  result: string,
  extra?: { readonly agentId?: string },
): NativeToolRegistry {
  const nativeTools = new NativeToolRegistry();
  nativeTools.register(name, {
    handler: async () => result,
    spec: {
      name,
      description: 'returns a PII-bearing payload',
      input_schema: { type: 'object', properties: {} },
    },
    domain: 'test.pii',
    ...(extra?.agentId !== undefined ? { agentId: extra.agentId } : {}),
  });
  return nativeTools;
}

describe('ToolDispatchService — privacy data-plane boundary (#542 prerequisite)', () => {
  it('MASKS a PII-bearing native tool result — the raw values never leave the dispatcher', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('odoo_read_partner', {});

    // The load-bearing assertions: the actual PII is GONE from the output.
    assert.equal(
      result.content.includes(EMAIL),
      false,
      'the email address reached the caller in clear — masking did not happen',
    );
    assert.equal(
      result.content.includes(IBAN),
      false,
      'the IBAN reached the caller in clear — masking did not happen',
    );
    assert.equal(
      result.content.includes('Erika Mustermann'),
      false,
      'the person name reached the caller in clear — masking did not happen',
    );
    // And the masked substitutes ARE present, so this is masking rather than
    // the result having been dropped or emptied.
    assert.match(result.content, /\[masked:email\]/);
    assert.match(result.content, /\[masked:iban\]/);
    assert.match(result.content, /«dataset:odoo_read_partner»/);
    assert.equal(result.isError, undefined);
  });

  it('MASKS a PII-bearing DOMAIN tool result too (both dispatch branches, not just native)', async () => {
    const domainTool: DomainTool = {
      name: 'ask_hr',
      spec: {
        name: 'ask_hr',
        description: 'sub-agent',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      domain: 'domain.hr',
      async handle() {
        return PII_RESULT;
      },
    };
    const service = new ToolDispatchService({
      nativeTools: new NativeToolRegistry(),
      domainTools: [domainTool],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('ask_hr', {});

    assert.equal(result.content.includes(EMAIL), false, 'domain-tool branch leaked the email');
    assert.equal(result.content.includes(IBAN), false, 'domain-tool branch leaked the IBAN');
    assert.match(result.content, /\[masked:email\]/);
  });

  it('inherits an AMBIENT turn privacy handle when no explicit dep is wired', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
    });

    const result = await turnContext.run(
      {
        privacyHandle: redactingPrivacyHandle(),
      } as unknown as Parameters<typeof turnContext.run>[0],
      () => service.dispatch('odoo_read_partner', {}),
    );

    assert.equal(
      result.content.includes(EMAIL),
      false,
      'a dispatch inside a turn must inherit that turn privacy handle',
    );
    assert.match(result.content, /\[masked:email\]/);
  });

  it('leaves the result UNCHANGED when no privacy provider is installed (parity with the orchestrator)', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
    });

    const result = await service.dispatch('odoo_read_partner', {});

    assert.equal(result.content, PII_RESULT);
  });

  it('honours the intern EXEMPTION list — a self/infra tool is not masked', async () => {
    // `memory` is on `INTERN_EXEMPT_TOOLS`: masking it would blind the agent to
    // its own operational state. The chat path exempts it, so this path must too.
    const service = new ToolDispatchService({
      nativeTools: registryWith('memory', PII_RESULT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('memory', {});

    assert.equal(result.content, PII_RESULT, 'an intern-exempt tool must pass through raw');
  });

  it('honours the operator BYPASS and records the receipt entry', async () => {
    const receipts: RecordedBypass[] = [];
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      privacy: () =>
        redactingPrivacyHandle({
          bypassTools: new Set(['odoo_read_partner']),
          bypassReceipts: receipts,
        }),
    });

    const result = await service.dispatch('odoo_read_partner', {});

    // Bypass means the operator explicitly opted this plugin out — raw is correct.
    assert.equal(result.content, PII_RESULT);
    // But it must stay auditable, exactly as on the chat path.
    assert.deepEqual(receipts, [
      {
        toolName: 'odoo_read_partner',
        pluginId: 'plugin-for-odoo_read_partner',
        bytes: Buffer.byteLength(PII_RESULT, 'utf8'),
      },
    ]);
  });

  it('fails OPEN when the privacy provider throws — documented parity with the chat path', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle({ internThrows: true }),
    });

    const result = await service.dispatch('odoo_read_partner', {});

    // `Orchestrator.dispatchToolDeadlined` logs and sends the raw result when
    // interning throws. This path matches it deliberately rather than silently
    // diverging; a fail-CLOSED policy for untrusted callers is its own decision.
    assert.equal(result.content, PII_RESULT);
    assert.equal(result.isError, undefined);
  });
});

/**
 * W4 — the ERROR path of the same boundary, now under the one thrown-error
 * policy every seam shares (`toolErrorRedaction.ts`).
 *
 * `afterDispatch` runs only on the success branch; a THROWING handler used to
 * return `error.message` verbatim, then (W4) an interned digest of it. Handler
 * exceptions are not sanitized: ORMs echo the failing row and drivers echo
 * bound parameters, so the message below is an ordinary shape for a real
 * Odoo/psql failure. Under a privacy handle the caller now gets the withheld
 * notice — class name, sanitised code, log ref — and nothing of the message.
 *
 * Same mutation-check discipline as above: every assertion inspects the CONTENT
 * that leaves the dispatcher. Deleting the `thrownResult` call, or forwarding
 * the message, fails these.
 */
const PII_ERROR = `Fault: Invalid field 'x' on record {"name":"Erika Mustermann","email":"${EMAIL}","iban":"${IBAN}"}`;

/** A registry whose handler THROWS instead of returning. */
function throwingRegistryWith(name: string, message: string): NativeToolRegistry {
  const nativeTools = new NativeToolRegistry();
  nativeTools.register(name, {
    handler: () => {
      throw new Error(message);
    },
    spec: {
      name,
      description: 'always fails, with PII in the message',
      input_schema: { type: 'object', properties: {} },
    },
    domain: 'test.pii',
  });
  return nativeTools;
}

/** A domain tool whose `handle` THROWS instead of returning. */
function throwingDomainTool(name: string, message: string): DomainTool {
  return {
    name,
    spec: {
      name,
      description: 'sub-agent that always fails',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    domain: 'domain.hr',
    handle() {
      throw new Error(message);
    },
  };
}

/**
 * #1097 — the public dispatch seam lets an MCP connect prompt (`🔒 …` plus the
 * `<mcp-auth-required>` machine block the chat UI parses into a Connect card)
 * through only when `McpManager.handleFailure` produced it in that dispatch;
 * `mcpAuthPromptProvenance.test.ts` drives that producer. The same bytes
 * returned by a handler are data: a remote server or a stored record can start
 * with the prefix, so the prefix alone must not switch the shield off.
 */
const AUTH_PROMPT =
  '🔒 The MCP server "Strava" needs authorization before it can be used. Ask the ' +
  "user to click Connect (this opens the provider's login), then retry: " +
  'https://example.test/oauth/authorize?x=1\n' +
  '<mcp-auth-required serverId="s-1" server="Strava" needsClient="false"></mcp-auth-required>';

describe('ToolDispatchService — control-flow passthrough (#1097)', () => {
  it('interns connect-prompt text a handler returns itself, and does not receipt it', async () => {
    const toolErrors: RecordedToolError[] = [];
    const service = new ToolDispatchService({
      nativeTools: registryWith('mcp__Strava__list_activities', AUTH_PROMPT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle({ toolErrors }),
    });

    const result = await service.dispatch('mcp__Strava__list_activities', {});

    assert.match(
      result.content,
      /^«dataset:mcp__Strava__list_activities»/,
      'prompt-shaped text without the manager as its producer is interned like any result',
    );
    assert.equal(result.origin, 'tool');
    assert.deepEqual(toolErrors, [], 'not receipted as a connect prompt');
  });

  it('REDACTS a PII-bearing returned `Error:` text on the loopback path, keeping the hint', async () => {
    const toolErrors: RecordedToolError[] = [];
    const service = new ToolDispatchService({
      nativeTools: registryWith('mail_send', `Error: mailbox ${EMAIL} is over quota`),
      domainTools: [],
      privacy: () => redactingPrivacyHandle({ toolErrors }),
    });

    const result = await service.dispatch('mail_send', {});

    assert.equal(result.content, 'Error: mailbox [masked:email] is over quota');
    assert.equal(result.origin, 'tool', 'handler-authored content, redacted — not dispatcher text');
    assert.equal(toolErrors[0]?.carrier, 'returned');
    assert.equal(toolErrors[0]?.outcome, 'redacted');
  });

  it('control — a PII-bearing result from the same tool IS still interned', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('mcp__Strava__list_activities', PII_RESULT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('mcp__Strava__list_activities', {});

    assert.match(result.content, /«dataset:mcp__Strava__list_activities»/);
    assert.equal(result.content.includes(EMAIL), false);
  });
});

/** The withheld notice's shape for a plain `Error` throw. */
function withheldNotice(tool: string): RegExp {
  return new RegExp(`^Error: tool \`${tool}\` failed with Error \\[ref [^\\]]+\\]\\. `);
}

describe('ToolDispatchService — error-path privacy boundary (W4)', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => {});
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('WITHHOLDS a NATIVE handler exception message and receipts it', async () => {
    const toolErrors: RecordedToolError[] = [];
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
      privacy: () => redactingPrivacyHandle({ toolErrors }),
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.content.includes(EMAIL), false, 'error path leaked the email');
    assert.equal(result.content.includes(IBAN), false, 'error path leaked the IBAN');
    assert.equal(
      result.content.includes('Erika Mustermann'),
      false,
      'error path leaked the person name',
    );
    assert.match(result.content, withheldNotice('odoo_search_partner'));
    assert.equal(result.isError, true, 'withholding must not swallow the error signal');
    assert.deepEqual(toolErrors, [
      {
        toolName: 'odoo_search_partner',
        carrier: 'thrown',
        outcome: 'withheld',
        bytes: Buffer.byteLength(PII_ERROR),
      },
    ]);
  });

  it('WITHHOLDS a DOMAIN tool exception message too (both branches)', async () => {
    const service = new ToolDispatchService({
      nativeTools: new NativeToolRegistry(),
      domainTools: [throwingDomainTool('ask_hr', PII_ERROR)],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('ask_hr', {});

    assert.equal(result.content.includes(EMAIL), false, 'domain-tool error path leaked the email');
    assert.equal(result.content.includes(IBAN), false, 'domain-tool error path leaked the IBAN');
    assert.match(result.content, withheldNotice('ask_hr'));
    assert.equal(result.isError, true);
  });

  it("uses the caller's request id as the log ref when one was sent", async () => {
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('odoo_search_partner', {}, {
      caller: { requestId: 'req-42' },
    });

    assert.match(result.content, /\[ref req-42\]/);
  });

  /**
   * #1097 — the fulfilled-result paths treat a string that follows the
   * `Error:` tool-error convention as control flow. A THROWN exception is a
   * different animal: nothing sanitized it, and its message may well start
   * with the same prefix. Pinning this here so the exception path is not
   * "fixed" later by pattern-matching on that prefix — the leak below is
   * exactly what would come back.
   */
  it('still WITHHOLDS a thrown exception whose message starts with `Error:` (not the tool-error convention)', async () => {
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', `Error: ${PII_ERROR}`),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.content.includes(EMAIL), false, 'a thrown `Error:` message leaked the email');
    assert.equal(result.content.includes(IBAN), false, 'a thrown `Error:` message leaked the IBAN');
    assert.equal(
      result.content.includes('Erika Mustermann'),
      false,
      'a thrown `Error:` message leaked the person name',
    );
    assert.match(result.content, withheldNotice('odoo_search_partner'));
    assert.equal(result.isError, true, 'withholding must not swallow the error signal');
  });

  /**
   * #1097 / triage AC3 — the same pin against the REAL privacy-guard service,
   * whose receipt must then list the withheld error. This message carries no
   * email, IBAN or phone — only a name and a salary, which no regex detector
   * sees; withholding does not depend on detection.
   */
  it('still WITHHOLDS a thrown `Error:` message through the real privacy-guard service', async () => {
    const guard = createPrivacyGuardService();
    const turnHandle = createPrivacyTurnHandle({
      service: guard,
      sessionId: 's-1097',
      turnId: 't-1097-thrown',
    });
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith(
        'odoo_search_partner',
        "Error: Invalid field 'x' on record {'id':42,'name':'Erika Mustermann','salary':'7.450 EUR'}",
      ),
      domainTools: [],
      privacy: () => turnHandle,
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.isError, true, 'withholding must not swallow the error signal');
    assert.match(result.content, withheldNotice('odoo_search_partner'));
    assert.equal(
      result.content.includes('Erika Mustermann'),
      false,
      'a thrown `Error:` message leaked the person name',
    );
    assert.equal(result.content.includes('7.450 EUR'), false, 'the salary leaked');
    const receipt = await turnHandle.finalize();
    assert.deepEqual(
      receipt?.toolErrors?.map((e) => [e.carrier, e.outcome]),
      [['thrown', 'withheld']],
    );
  });

  it('marks the withheld notice as `origin: dispatcher` — this service authored it', async () => {
    // The notice carries the tool name, the exception class and a ref — never
    // tool data — so a consumer (the public endpoint) may return it without a
    // masking pass, like this service's own refusals.
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.origin, 'dispatcher');
  });

  it("marks this service's OWN refusals as `origin: dispatcher` — they carry no tool data", async () => {
    const service = new ToolDispatchService({
      nativeTools: new NativeToolRegistry(),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const unknown = await service.dispatch('no_such_tool', {});
    assert.equal(unknown.origin, 'dispatcher');
    assert.equal(unknown.isError, true);

    const notReady = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT, { agentId: '@omadia/odoo' }),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
      isPluginToolsReady: () => false,
    });
    const unavailable = await notReady.dispatch('odoo_read_partner', {});
    assert.equal(unavailable.origin, 'dispatcher');
    assert.equal(unavailable.isError, true);
  });

  it('does NOT feed the exception text to `captureRawToolResult` — that sink is for tool RESULTS', async () => {
    // The KG-ingest / trace consumers behind this callback treat what they get
    // as business data. A driver stack trace is not, and reusing the whole
    // `afterDispatch` chain would have handed them one.
    const captured: string[] = [];
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
      captureRawToolResult: (_name, result) => captured.push(result),
    });

    await service.dispatch('odoo_search_partner', {});

    assert.deepEqual(captured, []);
  });

  it('does NOT honour the operator BYPASS for an exception, and records no receipt', async () => {
    // `_privacy_mode: bypass` is consent about a plugin's DECLARED output shape.
    // An exception message is arbitrary — anything the driver was holding — so
    // the consent does not transfer, and a byte-counted "bypassed" receipt would
    // mis-describe what was disclosed.
    const receipts: RecordedBypass[] = [];
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
      privacy: () =>
        redactingPrivacyHandle({
          bypassTools: new Set(['odoo_search_partner']),
          bypassReceipts: receipts,
        }),
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.content.includes(EMAIL), false, 'a bypass let raw error text through');
    assert.match(result.content, withheldNotice('odoo_search_partner'));
    assert.deepEqual(receipts, []);
  });

  it('honours the intern EXEMPTION for an error, exactly as for a result', async () => {
    // A self/infra tool's failure IS the agent's own operational state — the
    // case the allowlist exists for. (Such tools are unreachable from the public
    // endpoint anyway; `isPubliclyServableTool` filters them at the allowlist.)
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('memory', PII_ERROR),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('memory', {});

    assert.equal(result.content, PII_ERROR);
    assert.equal(result.isError, true);
  });

  it('leaves the error message UNCHANGED when no privacy provider is installed', async () => {
    // Parity with `afterDispatch`. The public endpoint refuses to call at all in
    // this configuration (`requirePrivacyMasking`), so this is the loopback/CLI
    // case, where the reader is the local operator.
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.content, PII_ERROR);
    assert.equal(result.isError, true);
  });

  it('withholds even when the provider is failing — nothing on this path depends on interning', async () => {
    // The old path interned the message and fell OPEN to the raw text when
    // interning threw. The notice needs no provider call, and a failing receipt
    // write only drops the entry.
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
      privacy: () => redactingPrivacyHandle({ internThrows: true, recordThrows: true }),
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.content.includes(EMAIL), false);
    assert.match(result.content, withheldNotice('odoo_search_partner'));
    assert.equal(result.isError, true);
  });

  it('withholds a non-Error throw (a bare string) too — it is never stringified onto the wire', async () => {
    const nativeTools = new NativeToolRegistry();
    nativeTools.register('odoo_search_partner', {
      handler: () => {
        // Deliberately not an Error: a thrown string IS a message, and
        // stringifying it would put it on the wire unchanged.
        throw PII_ERROR;
      },
      spec: {
        name: 'odoo_search_partner',
        description: 'throws a bare string',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.pii',
    });
    const service = new ToolDispatchService({
      nativeTools,
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.content.includes(EMAIL), false);
    assert.match(result.content, withheldNotice('odoo_search_partner'));
  });
});

describe('ToolDispatchService — raw-result capture (#542 prerequisite)', () => {
  it('captures the RAW result before masking, while the caller gets the MASKED one', async () => {
    const captured: Array<{ name: string; result: string; caller?: ToolDispatchCallerContext }> = [];
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
      captureRawToolResult: (name, result, caller) => {
        captured.push({ name, result, ...(caller !== undefined ? { caller } : {}) });
      },
    });

    const result = await service.dispatch('odoo_read_partner', {});

    // The trace consumer sees ground truth …
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.result, PII_RESULT);
    // … and the caller does NOT. Both halves matter: capturing the masked value
    // would make traces useless, returning the raw value would be the leak.
    assert.equal(result.content.includes(EMAIL), false);
  });

  it('survives a throwing capture callback without failing the tool call', async () => {
    const service = new ToolDispatchService({
      nativeTools: registryWith('odoo_read_partner', PII_RESULT),
      domainTools: [],
      captureRawToolResult: () => {
        throw new Error('audit sink exploded');
      },
    });

    const result = await service.dispatch('odoo_read_partner', {});

    assert.equal(result.content, PII_RESULT);
    assert.equal(result.isError, undefined);
  });
});

describe('ToolDispatchService — caller context seam (#542 prerequisite)', () => {
  it('propagates the caller identity to layers BENEATH the handler', async () => {
    const nativeTools = new NativeToolRegistry();
    let seenInsideHandler: ToolDispatchCallerContext | undefined;
    nativeTools.register('whoami', {
      // A plugin handler cannot receive identity as a parameter — the
      // `NativeToolHandler` contract is published — so it must be readable
      // ambiently, which is what this asserts.
      handler: async () => {
        seenInsideHandler = currentDispatchCaller();
        return 'ok';
      },
      spec: {
        name: 'whoami',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
    });
    const service = new ToolDispatchService({ nativeTools, domainTools: [] });

    const caller: ToolDispatchCallerContext = {
      principal: 'apikey_123',
      scopes: ['tools:write'],
      tenantId: 'tenant-a',
      userId: 'user-7',
      requestId: 'req-abc',
    };
    await service.dispatch('whoami', {}, { caller });

    assert.deepEqual(seenInsideHandler, caller);
  });

  it('leaves the ambient caller EMPTY on the loopback path (no caller supplied)', async () => {
    const nativeTools = new NativeToolRegistry();
    let seenInsideHandler: ToolDispatchCallerContext | undefined = {
      principal: 'sentinel',
    };
    nativeTools.register('whoami', {
      handler: async () => {
        seenInsideHandler = currentDispatchCaller();
        return 'ok';
      },
      spec: {
        name: 'whoami',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.x',
    });
    const service = new ToolDispatchService({ nativeTools, domainTools: [] });

    await service.dispatch('whoami', {});

    assert.equal(seenInsideHandler, undefined);
  });
});
