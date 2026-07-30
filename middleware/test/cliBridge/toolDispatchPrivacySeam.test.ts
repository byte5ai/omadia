import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import {
  ToolDispatchService,
  type ToolDispatchCallerContext,
} from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import { currentDispatchCaller } from '../../packages/harness-orchestrator/src/toolCallerContext.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import type { DomainTool } from '../../packages/harness-orchestrator/src/tools/domainQueryTool.js';

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

/**
 * A privacy handle that genuinely redacts. `internToolResultV4` strips the email
 * and IBAN and returns a digest — so if the dispatcher fails to call it, the raw
 * values survive into the output and the assertions below fail.
 */
function redactingPrivacyHandle(options?: {
  readonly bypassTools?: ReadonlySet<string>;
  readonly bypassReceipts?: RecordedBypass[];
  readonly internThrows?: boolean;
}): PrivacyTurnHandle {
  return {
    async internToolResultV4({ toolName, rawResult }) {
      if (options?.internThrows === true) {
        throw new Error('privacy provider unavailable');
      }
      const redacted = rawResult
        .replaceAll(EMAIL, '[masked:email]')
        .replaceAll(IBAN, '[masked:iban]')
        .replaceAll('Erika Mustermann', '[masked:person]');
      return {
        digestText: `«dataset:${toolName}» ${redacted}`,
        datasetId: `ds-${toolName}`,
      };
    },
    async recordBypassedTool({ toolName, pluginId, bytes }) {
      options?.bypassReceipts?.push({ toolName, pluginId, bytes });
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
 * W4 — the ERROR path of the same boundary.
 *
 * `afterDispatch` ran only on the success branch; a THROWING handler returned
 * `error.message` verbatim. Handler exceptions are not sanitized: ORMs echo the
 * failing row and drivers echo bound parameters, so the message below is an
 * ordinary shape for a real Odoo/psql failure — and it went out unmasked.
 *
 * Same mutation-check discipline as above: every assertion inspects the CONTENT
 * that leaves the dispatcher. Deleting the `maskErrorText` call, or making it
 * return its input, fails these.
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

describe('ToolDispatchService — error-path privacy boundary (W4)', () => {
  it('MASKS PII out of a NATIVE handler exception message', async () => {
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.content.includes(EMAIL), false, 'error path leaked the email');
    assert.equal(result.content.includes(IBAN), false, 'error path leaked the IBAN');
    assert.equal(
      result.content.includes('Erika Mustermann'),
      false,
      'error path leaked the person name',
    );
    assert.match(result.content, /\[masked:email\]/, 'the masked digest should have replaced it');
    assert.equal(result.isError, true, 'masking must not swallow the error signal');
  });

  it('MASKS PII out of a DOMAIN tool exception message too (both branches)', async () => {
    const service = new ToolDispatchService({
      nativeTools: new NativeToolRegistry(),
      domainTools: [throwingDomainTool('ask_hr', PII_ERROR)],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('ask_hr', {});

    assert.equal(result.content.includes(EMAIL), false, 'domain-tool error path leaked the email');
    assert.equal(result.content.includes(IBAN), false, 'domain-tool error path leaked the IBAN');
    assert.match(result.content, /\[masked:email\]/);
    assert.equal(result.isError, true);
  });

  it('marks a masked error as `origin: tool` so a consumer knows it had to cross the boundary', async () => {
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
      privacy: () => redactingPrivacyHandle(),
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.origin, 'tool');
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
    assert.match(result.content, /\[masked:email\]/);
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

  it('falls back to the raw message when masking itself throws — and still flags the error', async () => {
    // Documented fail-OPEN, safe ONLY because `publicMcpPrivacy.ts`'s gate never
    // lets `internToolResultV4` throw and `PublicMcpServer` refuses an unmasked
    // result. Asserted so the branch cannot change silently.
    const service = new ToolDispatchService({
      nativeTools: throwingRegistryWith('odoo_search_partner', PII_ERROR),
      domainTools: [],
      privacy: () => redactingPrivacyHandle({ internThrows: true }),
    });

    const result = await service.dispatch('odoo_search_partner', {});

    assert.equal(result.content, PII_ERROR);
    assert.equal(result.isError, true);
  });

  it('masks a non-Error throw (a bare string) too — `errMsg` stringifies, it does not sanitize', async () => {
    const nativeTools = new NativeToolRegistry();
    nativeTools.register('odoo_search_partner', {
      handler: () => {
        // Deliberately not an Error: `errMsg` falls back to `String(error)`,
        // which stringifies without sanitizing anything.
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
    assert.match(result.content, /\[masked:email\]/);
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
